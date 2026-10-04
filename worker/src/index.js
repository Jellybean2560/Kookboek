// Kookboek backend.
//
// Routes:
//   GET  /import?url=...   Fetch a recipe page and return its schema.org Recipe
//                          data, normalised. Only the parsed recipe is returned,
//                          never the raw page, so this is not an open proxy.
//   POST /b/{book}/sync    {since, changes: [recipe]} -> {seq, changes: [recipe]}
//                          The book code doubles as the shared secret.
//
// Every book is one Durable Object. Each stored recipe carries the server
// sequence number of its last write; a phone sends the highest sequence it
// has seen and gets back everything written after it. Conflicts are decided
// per recipe by the client's updatedAt (last edit wins). Deletions are kept as
// tombstones so they reach every phone.

import { DurableObject } from "cloudflare:workers";

const BOOK_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_RECIPE_BYTES = 1_500_000;
const MAX_CHANGES = 500;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/import" && request.method === "GET") {
        return json(await importRecipe(url.searchParams.get("url")));
      }
      const m = url.pathname.match(/^\/b\/([^/]+)\/sync$/);
      if (m && request.method === "POST") {
        if (!BOOK_RE.test(m[1])) return json({ error: "Ongeldige kookboekcode" }, 400);
        const stub = env.BOOKS.get(env.BOOKS.idFromName(m[1]));
        // The Book's json() responses already carry the CORS headers.
        return stub.fetch(request);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

export class Book extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recipes (
        id         TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        seq        INTEGER NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recipes_seq ON recipes(seq);
    `);
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ongeldige JSON" }, 400); }
    const since = Number.isInteger(body.since) ? body.since : 0;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (changes.length > MAX_CHANGES) return json({ error: "Te veel wijzigingen in één keer" }, 400);

    let seq = this.sql.exec("SELECT value FROM meta WHERE key = 'seq'").toArray()[0]?.value ?? 0;
    for (const r of changes) {
      if (!r || typeof r.id !== "string" || r.id.length > 64 || !Number.isFinite(r.updatedAt)) continue;
      const data = JSON.stringify(r);
      if (data.length > MAX_RECIPE_BYTES) continue;
      const cur = this.sql.exec("SELECT updated_at FROM recipes WHERE id = ?", r.id).toArray()[0];
      if (cur && cur.updated_at >= r.updatedAt) continue;
      seq++;
      this.sql.exec(
        "INSERT INTO recipes (id, updated_at, seq, data) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, seq = excluded.seq, data = excluded.data",
        r.id, r.updatedAt, seq, data);
    }
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seq);

    const out = this.sql.exec("SELECT data FROM recipes WHERE seq > ? ORDER BY seq", since)
      .toArray().map(row => JSON.parse(row.data));
    return json({ seq, changes: out });
  }
}

// ── Recipe import ───────────────────────────────────────────────────────────

async function importRecipe(target) {
  let u;
  try { u = new URL(target); } catch { throw httpError(400, "Dat is geen geldige link"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw httpError(400, "Alleen http(s)-links worden ondersteund");

  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
      },
    });
  } catch {
    throw httpError(502, "De website kon niet bereikt worden");
  }
  if (!res.ok) throw httpError(502, `De website weigerde de aanvraag (fout ${res.status})`);
  const html = (await res.text()).slice(0, 4_000_000);

  const fromLd = findLdRecipe(html);
  const recipe = fromLd ? normaliseLd(fromLd) : fromMicrodata(html);
  recipe.source = res.url || u.toString();
  // Dagelijkse Kost only puts the first two steps in its JSON-LD; the full
  // list is in the Next.js payload.
  if (recipe.steps.length < 3) {
    const embedded = nextPayloadSteps(html);
    if (embedded.length > recipe.steps.length) recipe.steps = embedded;
  }
  recipe.steps = recipe.steps.flatMap(splitLongStep);
  if (!recipe.title) recipe.title = meta(html, "og:title") || tagText(html, "title");
  if (!recipe.image) recipe.image = meta(html, "og:image");
  if (recipe.image) recipe.image = absolute(recipe.image, recipe.source);
  recipe.partial = !(recipe.ingredients.length && recipe.steps.length);
  if (!recipe.title && !recipe.ingredients.length) {
    throw httpError(422, "Op deze pagina werd geen recept gevonden");
  }
  return recipe;
}

function findLdRecipe(html) {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); }
    catch {
      // Some sites put raw newlines inside JSON strings.
      try { data = JSON.parse(m[1].trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    }
    const found = walkForRecipe(data, 0);
    if (found) return found;
  }
  return null;
}

function walkForRecipe(node, depth) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const f = walkForRecipe(n, depth + 1); if (f) return f; }
    return null;
  }
  const type = node["@type"];
  if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const f = walkForRecipe(node[key], depth + 1);
    if (f) return f;
  }
  return null;
}

function normaliseLd(r) {
  const prep = isoMinutes(r.prepTime), cook = isoMinutes(r.cookTime);
  return {
    title: clean(r.name),
    description: clean(r.description),
    image: pickImage(r.image),
    servings: parseServings(r.recipeYield),
    time: isoMinutes(r.totalTime) || (prep + cook) || null,
    ingredients: toArray(r.recipeIngredient || r.ingredients).map(clean).filter(Boolean),
    steps: flattenSteps(r.recipeInstructions),
    keywords: [r.recipeCategory, r.recipeCuisine, r.keywords].flat().filter(Boolean).map(clean).join(", "),
  };
}

function flattenSteps(ins) {
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (typeof n === "string") {
      // A single blob of text: split on line breaks / list items.
      n.split(/<\/?(?:li|p|br)[^>]*>|\n+/i).map(clean).filter(Boolean).forEach(s => out.push(s));
      return;
    }
    if (Array.isArray(n)) return n.forEach(visit);
    if (n["@type"] === "HowToSection" || n.itemListElement) {
      if (n.name) out.push("## " + clean(n.name));
      return visit(n.itemListElement);
    }
    const text = clean(n.text || n.name || n.description);
    if (text) out.push(text);
  };
  visit(ins);
  return out;
}

function nextPayloadSteps(html) {
  const re = /\\"step\\":(\d+),[^{}]*?\\"description\\":\\"((?:[^"\\]|\\\\[^"])*?)\\"/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (!seen.has(+m[1])) seen.set(+m[1], clean(m[2].replace(/\\\\n/g, " ").replace(/\\\\(.)/g, "$1")));
  }
  return [...seen].sort((a, b) => a[0] - b[0]).map(e => e[1]).filter(Boolean);
}

// Some sites put the whole method in one paragraph. Break it into steps of a
// few sentences so it can be followed while cooking.
function splitLongStep(step) {
  if (step.length < 450 || step.startsWith("## ")) return [step];
  const sentences = step.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [step];
  const out = [];
  let cur = "";
  for (const s of sentences.map(x => x.trim())) {
    if (cur && (cur + " " + s).length > 260) { out.push(cur); cur = s; }
    else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

function fromMicrodata(html) {
  const props = (name) => {
    const re = new RegExp(`<([a-z0-9]+)[^>]*itemprop=["']${name}["'][^>]*>([\\s\\S]*?)</\\1>`, "gi");
    const out = []; let m;
    while ((m = re.exec(html))) out.push(clean(m[2]));
    return out.filter(Boolean);
  };
  return {
    title: props("name")[0] || "",
    description: "",
    image: "",
    servings: parseServings(props("recipeYield")[0]),
    time: null,
    ingredients: [...props("recipeIngredient"), ...props("ingredients")],
    steps: props("recipeInstructions").flatMap(s => s.split(/\n+/)).map(s => s.trim()).filter(Boolean),
    keywords: "",
  };
}

function pickImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return pickImage(img[0]);
  return img.url || img.contentUrl || "";
}

function parseServings(y) {
  for (const v of toArray(y)) {
    if (typeof v === "number" && v > 0) return Math.round(v);
    const m = String(v).match(/\d+/);
    if (m && +m[0] > 0 && +m[0] < 100) return +m[0];
  }
  return null;
}

function isoMinutes(d) {
  const m = typeof d === "string" && d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return 0;
  return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

function toArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è",
  euml: "ë", ecirc: "ê", aacute: "á", agrave: "à", auml: "ä", iuml: "ï", ouml: "ö", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", ndash: "–",
  mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", times: "×",
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function clean(s) {
  if (s == null) return "";
  if (typeof s !== "string") s = String(s);
  // Decode twice: some sites double-encode (&amp;eacute;).
  return decode(decode(s.replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();
}

function meta(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i"));
  const c = m && m[0].match(/content=["']([^"']*)["']/i);
  return c ? clean(c[1]) : "";
}

function tagText(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? clean(m[1]) : "";
}

function absolute(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
