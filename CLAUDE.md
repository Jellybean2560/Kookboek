# Kookboek — project notes

Dutch-language recipe PWA for Android + iOS. Single file `index.html`, no build step, deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Pieces
- `index.html` — whole app (HTML + CSS + JS). Hash router: `#/vandaag[/base[/protein]]`, `#/recepten`, `#/toevoegen`, `#/recept/{id}`, `#/bewerk/{id|nieuw}`, `#/instellingen`, `#/koppel/{code}`.
- `sw.js` — network-first app shell (`kookboek-v1`, bump to force refresh). `manifest.json` has a `share_target` so Android's share sheet opens `./?url=…`.
- `worker/` — Cloudflare Worker `kookboek`, live at `https://kookboek.jellevandenwouwer.workers.dev`. Deploy with `cd worker && npx wrangler deploy` (wrangler is logged in on this PC).
  - `GET /import?url=` fetches a recipe page server-side, parses schema.org `Recipe` JSON-LD (microdata fallback), returns normalised JSON. Never returns raw HTML (not an open proxy).
  - `POST /b/{code}/sync` — one SQLite Durable Object per shared book. Client sends `{since, changes}`; server keeps per-recipe last-write-wins on client `updatedAt` and returns rows with `seq > since`. Deletions are tombstones (`deleted: true`).
- Local testing: `localStorage.kb_api = 'http://localhost:8787'` points the app at `wrangler dev`.

## Data
- Recipes in IndexedDB `kookboek/recipes` (photos are data-URLs, too big for localStorage). Settings in `kb_settings`, unsynced ids in `kb_dirty`.
- Recipe: `{id, title, image, source, servings, time, bases[], proteins[], ingredients[], steps[], notes, lastCooked, cookCount, createdAt, updatedAt}`. Lines starting with `#` (or `## ` from imports) are section headings.
- Untagged recipes count as `anders` in the wizard (`effBases` / `effProteins`).

## Gotchas
- **Allerhande (ah.nl) returns 403** to any non-browser fetch (Akamai bot protection), including from Cloudflare. The "Tekst plakken" path (`parseRecipeText`) is the workaround — don't try to evade the block.
- **Dagelijkse Kost** only puts the first 2 steps in JSON-LD; `nextPayloadSteps()` reads the full list from the Next.js payload.
- `guessTags()` keyword-matches ingredient lines; strip false friends first (kippenbouillon, vissaus, currypasta, tomatenpuree, rundergehakt → gehakt).
- Quantity scaling only touches the *leading* quantity of an ingredient line (`QTY_RE`); at factor 1 the original text is shown untouched.
- The Durable Object's `json()` already sets CORS headers — don't add them again in the outer fetch, browsers reject `Access-Control-Allow-Origin: *, *`.
