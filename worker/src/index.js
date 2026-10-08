// Kookboek backend.
//
// Routes:
//   GET  /import?url=...   Fetch a recipe page and return its schema.org Recipe
//                          data, normalised. Only the parsed recipe is returned,
//                          never the raw page, so this is not an open proxy.
//   GET  /image?url=...    Fetch one image (image/* only, max 8 MB) so the app
//                          can keep its own copy of an imported recipe photo.
//   POST /scan             {images: [dataURL]} -> recipe read from photos.
//   POST /classify         {recipe} -> {bases, proteins, time} chosen by AI.
//   POST /assist           {mode: "vega"|"side", recipe} -> variation / side dishes.
//                          AI routes share a daily budget per IP and in total.
//   POST /b/{book}/sync    {since, changes: [recipe]} -> {seq, changes: [recipe]}
//   GET  /b/{book}/snapshots          -> {snapshots: [{id, created, count}]}
//   GET  /b/{book}/snapshots/{id}     -> {created, recipes: [recipe]}
//                          The book code doubles as the shared secret.
//
// Every book is one Durable Object. Each stored recipe carries the server
// sequence number of its last write; a phone sends the highest sequence it
// has seen and gets back everything written after it. Conflicts are decided
// per recipe by the client's updatedAt (last edit wins). Deletions are kept as
// tombstones so they reach every phone. Once a day, before applying the first
// changes, the book copies its live recipes into a snapshot (14 are kept).

import { DurableObject } from "cloudflare:workers";

const BOOK_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_RECIPE_BYTES = 1_500_000;
const MAX_CHANGES = 500;
const MAX_IMAGE_BYTES = 8_000_000;
const SNAPSHOT_EVERY_MS = 20 * 3600_000;
const SNAPSHOTS_KEPT = 14;
// The free Workers AI allowance is 10,000 neurons/day. Each AI call is
// charged an estimate against a daily budget that stays below that, so one
// connection can't use it all up and the total never runs into the hard cap.
const AI_COST = { scan: 160, classify: 30, assist: 90 };
const AI_BUDGET_PER_IP = 4500;
const AI_BUDGET_PER_DAY = 9000;
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
      if (url.pathname === "/image" && request.method === "GET") {
        return await proxyImage(url.searchParams.get("url"));
      }
      if (url.pathname === "/scan" && request.method === "POST") {
        await chargeAI(request, env, "scan");
        return json(await scanRecipe(request, env));
      }
      if (url.pathname === "/classify" && request.method === "POST") {
        const body = await readRecipeBody(request);
        await chargeAI(request, env, "classify");
        return json(await classifyRecipe(body, env));
      }
      if (url.pathname === "/assist" && request.method === "POST") {
        const body = await readRecipeBody(request);
        await chargeAI(request, env, "assist");
        return json(await assistRecipe(body, env));
      }
      const m = url.pathname.match(/^\/b\/([^/]+)\/(sync|snapshots)(?:\/(\d+))?$/);
      if (m) {
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
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_recipes (snap INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_recipes_snap ON snapshot_recipes(snap);
    `);
  }

  async fetch(request) {
    const parts = new URL(request.url).pathname.split("/");
    if (parts[3] === "snapshots" && request.method === "GET") {
      if (!parts[4]) {
        const list = this.sql.exec("SELECT id, count FROM snapshots ORDER BY id DESC").toArray();
        return json({ snapshots: list.map(s => ({ id: s.id, created: s.id, count: s.count })) });
      }
      const id = +parts[4];
      if (!this.sql.exec("SELECT id FROM snapshots WHERE id = ?", id).toArray().length) return json({ error: "Back-up niet gevonden" }, 404);
      const rows = this.sql.exec("SELECT data FROM snapshot_recipes WHERE snap = ?", id).toArray();
      return json({ created: id, recipes: rows.map(r => JSON.parse(r.data)) });
    }
    if (parts[3] !== "sync" || request.method !== "POST") return json({ error: "not found" }, 404);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Ongeldige JSON" }, 400); }
    const since = Number.isInteger(body.since) ? body.since : 0;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (changes.length > MAX_CHANGES) return json({ error: "Te veel wijzigingen in één keer" }, 400);

    if (changes.length) this.maybeSnapshot();

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

  // Copies the book as it was *before* the day's first change, so a bad edit
  // or delete can be rolled back from Instellingen.
  maybeSnapshot() {
    const now = Date.now();
    const last = this.sql.exec("SELECT MAX(id) AS id FROM snapshots").toArray()[0]?.id || 0;
    if (now - last < SNAPSHOT_EVERY_MS) return;
    const live = "json_extract(data, '$.deleted') IS NOT 1";
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM recipes WHERE ${live}`).toArray()[0].n;
    if (!count) return;
    this.sql.exec(`INSERT INTO snapshot_recipes (snap, data) SELECT ?, data FROM recipes WHERE ${live}`, now);
    this.sql.exec("INSERT INTO snapshots (id, count) VALUES (?, ?)", now, count);
    const old = this.sql.exec("SELECT id FROM snapshots ORDER BY id DESC LIMIT -1 OFFSET ?", SNAPSHOTS_KEPT).toArray();
    for (const s of old) {
      this.sql.exec("DELETE FROM snapshot_recipes WHERE snap = ?", s.id);
      this.sql.exec("DELETE FROM snapshots WHERE id = ?", s.id);
    }
  }
}

// Sums estimated AI cost per IP and in total, per UTC day.
export class Limiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day))");
  }

  async take(key, cost = 1, perKey = AI_BUDGET_PER_IP, total = AI_BUDGET_PER_DAY) {
    const day = new Date().toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM hits WHERE day <> ?", day);
    const get = (k) => this.sql.exec("SELECT n FROM hits WHERE key = ? AND day = ?", k, day).toArray()[0]?.n || 0;
    if (get(key) + cost > perKey) return "ip";
    if (get("*") + cost > total) return "all";
    for (const k of [key, "*"]) {
      this.sql.exec("INSERT INTO hits (key, day, n) VALUES (?, ?, ?) ON CONFLICT(key, day) DO UPDATE SET n = n + excluded.n", k, day, cost);
    }
    return "";
  }
}

async function chargeAI(request, env, kind) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const blocked = await env.LIMITER.get(env.LIMITER.idFromName("ai")).take(ip, AI_COST[kind]);
  if (!blocked) return;
  const what = kind === "scan" ? "Scannen" : "De AI-hulp";
  throw httpError(429, `${what} kan vandaag niet meer: het gratis dagtegoed is op. Morgen kan het weer.`);
}

// ── AI help with categories and variations ──────────────────────────────────

const AI_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const BASE_IDS = ["aardappelen", "rijst", "pasta", "brood", "anders"];
const PROTEIN_IDS = ["kip", "gehakt", "rund", "varken", "vis", "zeevruchten", "vega", "anders"];

async function readRecipeBody(request) {
  if (+request.headers.get("Content-Length") > 200_000) throw httpError(413, "Recept te groot");
  let body;
  try { body = await request.json(); } catch { throw httpError(400, "Ongeldige aanvraag"); }
  const lines = (v) => toArray(v).filter(s => typeof s === "string").map(s => s.slice(0, 300)).slice(0, 80);
  const r = body.recipe || {};
  const recipe = { title: String(r.title || "").slice(0, 200), servings: r.servings || null, ingredients: lines(r.ingredients), steps: lines(r.steps) };
  if (!recipe.title && !recipe.ingredients.length) throw httpError(400, "Geen recept ontvangen");
  return { mode: body.mode, recipe };
}

async function askModel(env, prompt, maxTokens) {
  let out;
  try {
    out = await env.AI.run(AI_TEXT_MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2 });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/neuron|quota|429|exceeded/i.test(msg)) throw httpError(429, "Het gratis AI-tegoed voor vandaag is op. Morgen kan het weer.");
    throw httpError(502, "De AI-hulp lukte niet: " + msg.slice(0, 200));
  }
  const text = typeof out?.response === "string" ? out.response
    : out?.response ? JSON.stringify(out.response) : out?.choices?.[0]?.message?.content || "";
  const parsed = parseModelJson(text);
  if (!parsed) throw httpError(502, "De AI gaf geen bruikbaar antwoord. Probeer het nog eens.");
  return parsed;
}

const recipeText = (r) => `Titel: ${r.title}\n${r.servings ? `Personen: ${r.servings}\n` : ""}Ingrediënten:\n${r.ingredients.map(i => "- " + i).join("\n")}\n${r.steps.length ? `Bereiding:\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}`;

async function classifyRecipe({ recipe }, env) {
  const prompt = `Categoriseer dit recept voor een app die vraagt "waar heb je zin in" (de basis van de maaltijd) en "welk vlees of vis".

${recipeText(recipe)}

Kies:
- "bases": de koolhydraatbasis die je op je bord krijgt NAAST of ONDER het gerecht, één of meer uit ${JSON.stringify(BASE_IDS)}. Rijst die erbij geserveerd wordt telt. "anders" = soep, salade, ovenschotel zonder duidelijke basis, enz. Ingrediënten die IN de saus of het stoofsel verwerkt worden zijn NOOIT een basis: brood met mosterd in stoofvlees bindt de saus en is dus geen "brood"; paneermeel, bloem en currypasta ook niet. Staat er geen basis in het recept, kies dan wat er in België traditioneel bij gegeten wordt (bv. stoofvlees → aardappelen).
- "proteins": de hoofdeiwitbron, één of meer uit ${JSON.stringify(PROTEIN_IDS)}. Bouillon of vissaus telt niet. Geen vlees of vis = "vega". Gehakt (ook rundergehakt) = "gehakt"; steak, stoofvlees, rundvlees = "rund"; spek, ham, worst = "varken".
- "time": geschatte totale bereidingstijd in minuten (getal), inclusief oventijd en stooftijd.

Antwoord ALLEEN met JSON: {"bases": [], "proteins": [], "time": 0}`;
  const out = await askModel(env, prompt, 200);
  const pick = (v, allowed) => [...new Set(toArray(v).map(x => String(x).toLowerCase().trim()).filter(x => allowed.includes(x)))];
  const time = parseInt(out.time, 10);
  return { bases: pick(out.bases, BASE_IDS), proteins: pick(out.proteins, PROTEIN_IDS), time: time > 0 && time < 1440 ? time : null };
}

async function assistRecipe({ mode, recipe }, env) {
  if (mode === "vega") {
    const prompt = `Maak een vegetarische versie van dit recept. Vervang vlees en vis door een passend vegetarisch alternatief (bv. kikkererwten, tofu, halloumi, paddenstoelen, linzen, vegetarisch gehakt) en pas hoeveelheden en bereiding daarop aan. Houd de rest zoveel mogelijk gelijk. Schrijf in het Nederlands (Belgisch is prima).

${recipeText(recipe)}

Geef het een nieuwe titel die het vegetarische alternatief noemt, zonder het vlees of de vis (dus "Currysaus met kikkererwten", niet "Vegetarische kip in currysaus").

Antwoord ALLEEN met JSON:
{"title": "", "intro": "één zin over wat je vervangen hebt", "ingredients": ["hoeveelheid + ingrediënt", ...], "steps": ["stap", ...]}`;
    const out = await askModel(env, prompt, 1500);
    const lines = (v) => toArray(v).map(x => clean(typeof x === "string" ? x : x?.text || "")).filter(Boolean);
    const result = { title: clean(out.title), intro: clean(out.intro), ingredients: lines(out.ingredients), steps: lines(out.steps).map(s => s.replace(/^\d+[.)]\s*/, "")) };
    if (!result.ingredients.length || !result.steps.length) throw httpError(502, "De AI gaf geen volledig recept terug. Probeer het nog eens.");
    return result;
  }
  if (mode === "side") {
    const prompt = `Geef 3 bijgerechten of aanvullingen die goed passen bij dit gerecht, zodat het een complete maaltijd wordt. Houd het eenvoudig en haalbaar op een weekdag. Ingrediënten die al in het recept zitten hoef je niet opnieuw voor te stellen. Schrijf in het Nederlands.

${recipeText(recipe)}

Antwoord ALLEEN met JSON:
{"suggestions": [{"name": "korte naam", "why": "één zin waarom het past", "ingredients": ["hoeveelheid voor ${recipe.servings || 4} personen + ingrediënt", ...]}]}`;
    const out = await askModel(env, prompt, 700);
    const suggestions = toArray(out.suggestions).slice(0, 3).map(s => ({
      name: clean(s?.name), why: clean(s?.why),
      // The model sometimes returns one comma-separated string instead of a list.
      ingredients: toArray(s?.ingredients).flatMap(x => String(x).split(/\s*;\s*|,\s+/)) // "1,5 dl" stays whole.map(clean).filter(Boolean).slice(0, 8),
    })).filter(s => s.name);
    if (!suggestions.length) throw httpError(502, "De AI gaf geen suggesties terug. Probeer het nog eens.");
    return { suggestions };
  }
  throw httpError(400, "Onbekende vraag");
}

// ── Image copy ──────────────────────────────────────────────────────────────

async function proxyImage(target) {
  let u;
  try { u = new URL(target); } catch { throw httpError(400, "Ongeldige link"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw httpError(400, "Ongeldige link");
  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8",
        // Some sites refuse images requested without their own page as referrer.
        "Referer": u.origin + "/",
      },
    });
  } catch {
    throw httpError(502, "De foto kon niet opgehaald worden");
  }
  const type = res.headers.get("Content-Type") || "";
  if (!res.ok || !/^image\//i.test(type)) throw httpError(502, "De foto kon niet opgehaald worden");
  if (+res.headers.get("Content-Length") > MAX_IMAGE_BYTES) throw httpError(413, "De foto is te groot");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw httpError(413, "De foto is te groot");
  return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400", ...CORS } });
}

// ── Photo scan ──────────────────────────────────────────────────────────────
// A vision model on Workers AI reads photographed recipe pages. On the free
// plan this draws from the 10,000 neurons/day allowance (~150 per photo) and
// simply fails once that is used up; it never bills.

const SCAN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_SCAN_IMAGES = 4;
const MAX_SCAN_BYTES = 8_000_000;

const SCAN_PROMPT = `Je krijgt een of meer foto's van een gedrukt of handgeschreven recept (kookboek, tijdschrift, papiertje). Lees het recept en geef het terug als JSON.

Regels:
- Neem de tekst letterlijk over in de oorspronkelijke taal. Niet vertalen, niets verzinnen, geen hoeveelheden aanpassen.
- "ingredients": één ingrediënt per item, met de hoeveelheid vooraan zoals gedrukt (bv. "500 g gehakt", "1 ui"). Staan ingrediënten onder tussenkopjes (bv. "Voor de saus"), zet het kopje als apart item met "# " ervoor.
- "steps": één stap per item, zonder nummering. Lees kolommen in de juiste volgorde; zinnen die over een regeleinde doorlopen horen bij dezelfde stap.
- "servings": aantal personen als getal, of null. "time": totale bereidingstijd in minuten als getal, of null.
- "notes": tips of opmerkingen bij het recept, anders "".
- Lukt het niet om een recept te lezen, geef dan {"error": "korte uitleg"}.

Antwoord ALLEEN met JSON in deze vorm:
{"title": "", "servings": null, "time": null, "ingredients": [], "steps": [], "notes": ""}`;

async function scanRecipe(request, env) {
  const len = +request.headers.get("Content-Length") || 0;
  if (len > MAX_SCAN_BYTES) throw httpError(413, "De foto's zijn te groot");
  let body;
  try { body = await request.json(); } catch { throw httpError(400, "Ongeldige aanvraag"); }
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(s => typeof s === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(s));
  if (!images.length) throw httpError(400, "Geen foto ontvangen");
  if (images.length > MAX_SCAN_IMAGES) throw httpError(400, `Maximaal ${MAX_SCAN_IMAGES} foto's tegelijk`);

  let out;
  try {
    out = await env.AI.run(SCAN_MODEL, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          ...images.map(url => ({ type: "image_url", image_url: { url } })),
        ],
      }],
      max_tokens: 2500,
      temperature: 0.1,
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/neuron|quota|429|exceeded/i.test(msg)) throw httpError(429, "Het gratis scan-tegoed voor vandaag is op. Probeer het morgen opnieuw, of plak de tekst.");
    throw httpError(502, "Het scannen lukte niet: " + msg.slice(0, 200));
  }

  const text = typeof out?.response === "string" ? out.response
    : out?.response ? JSON.stringify(out.response)
    : out?.choices?.[0]?.message?.content || "";
  const parsed = parseModelJson(text);
  if (!parsed) throw httpError(422, "De foto kon niet als recept gelezen worden. Probeer een scherpere foto, recht van boven.");
  if (parsed.error) throw httpError(422, String(parsed.error));

  const lines = (v) => toArray(v).map(x => clean(typeof x === "string" ? x : x?.text || x?.name || "")).filter(Boolean);
  const num = (v) => { const n = parseInt(v, 10); return n > 0 && n < 1000 ? n : null; };
  const recipe = {
    title: clean(parsed.title),
    servings: num(parsed.servings),
    time: num(parsed.time),
    ingredients: lines(parsed.ingredients),
    steps: lines(parsed.steps).map(s => s.replace(/^(stap\s*)?\d+[.)]\s*/i, "")),
    notes: clean(parsed.notes),
  };
  if (!recipe.title && !recipe.ingredients.length && !recipe.steps.length) {
    throw httpError(422, "Op de foto werd geen recept gevonden");
  }
  return recipe;
}

function parseModelJson(text) {
  if (!text) return null;
  const s = text.replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
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
