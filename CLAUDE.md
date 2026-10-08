# Kookboek — project notes

Dutch-language recipe PWA for Android + iOS. Single file `index.html`, no build step, deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Pieces
- `index.html` — whole app (HTML + CSS + JS). Hash router: `#/vandaag[/base[/protein[/time]]]`, `#/recepten`, `#/toevoegen`, `#/recept/{id}`, `#/koken/{id}/{step}`, `#/inhuis`, `#/bewerk/{id|nieuw}`, `#/instellingen`, `#/koppel/{code}`.
  - Wizard steps skip themselves (`location.replace`) when there's only one meaningful answer; recipes without a time are listed under "Tijd onbekend" rather than counted as quick. Cooked in the last 7 days is hidden unless that would leave nothing.
  - Cook mode: durations in step text (`DURATION_RE`) become timer buttons; timers persist in `kb_timers` as end times, alarm = WebAudio beep + vibrate. Browsers don't run pages in the background, so the alarm sounds when the app is in front again. "Nodig voor deze stap" matches ingredient words (minus units/adjectives) against the step text, incl. Dutch compound suffixes.
- `sw.js` — network-first app shell (`kookboek-v2`, bump to force refresh). `manifest.json` has a `share_target` so Android's share sheet opens `./?url=…`.
- `worker/` — Cloudflare Worker `kookboek`, live at `https://kookboek.jellevandenwouwer.workers.dev`. Deploy with `cd worker && npx wrangler deploy` (wrangler is logged in on this PC).
  - `GET /import?url=` fetches a recipe page server-side, parses schema.org `Recipe` JSON-LD (microdata fallback), returns normalised JSON. Never returns raw HTML (not an open proxy).
  - `GET /image?url=` returns one image (image/* only, ≤8 MB). The app stores imported photos as its own ~900px JPEG data-URL copy (`copyImage`), and `migrateImages()` converts older recipes that still hotlink.
  - `POST /scan` is limited by the `Limiter` DO: 25 per IP and 55 total per UTC day, so nobody can drain the free AI allowance.
  - `GET /b/{code}/snapshots[/{id}]` — the Book copies its live recipes once a day *before* applying the day's first changes; 14 kept. Restore in Instellingen re-saves those recipes as new versions (later additions stay).
  - `POST /scan` `{images: [dataURL]}` (max 4, ~1600px JPEG) — photo of a printed/handwritten recipe → recipe JSON via Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct` (`[ai]` binding). Free plan: 10k neurons/day, ~150 per photo; over the limit it errors (429), never bills. Chosen over mistral-small-3.1 (similar, slightly worse on diacritics); gemma-3 is not enabled on this account.
  - `POST /b/{code}/sync` — one SQLite Durable Object per shared book. Client sends `{since, changes}`; server keeps per-recipe last-write-wins on client `updatedAt` and returns rows with `seq > since`. Deletions are tombstones (`deleted: true`).
- Local testing: `localStorage.kb_api = 'http://localhost:8787'` points the app at `wrangler dev`.

## Data
- Recipes in IndexedDB `kookboek/recipes` (photos are data-URLs, too big for localStorage). Settings in `kb_settings`, unsynced ids in `kb_dirty`.
- Recipe: `{id, title, image, source, servings, time, bases[], proteins[], ingredients[], steps[], notes, favorite, rating (0–5), lastCooked, cookCount, createdAt, updatedAt}`.
- Deleting sets `deleted: true, deletedAt` but keeps the contents for 30 days ("Onlangs verwijderd", undo toast); `emptyOldTrash()` then strips it to a bare tombstone. Old tombstones without `title` are pre-trash and can't be restored.
- Without a shared book there are no server snapshots; `backupBanner()` nags monthly to export (share sheet on phones). Lines starting with `#` (or `## ` from imports) are section headings.
- Untagged recipes count as `anders` in the wizard (`effBases` / `effProteins`).

## Gotchas
- **Allerhande (ah.nl) returns 403** to any non-browser fetch (Akamai bot protection), including from Cloudflare. The "Tekst plakken" path (`parseRecipeText`) is the workaround — don't try to evade the block.
- **Dagelijkse Kost** only puts the first 2 steps in JSON-LD; `nextPayloadSteps()` reads the full list from the Next.js payload.
- `guessTags()` keyword-matches ingredient lines; strip false friends first (kippenbouillon, vissaus, currypasta, tomatenpuree, rundergehakt → gehakt).
- Quantity scaling only touches the *leading* quantity of an ingredient line (`QTY_RE`); at factor 1 the original text is shown untouched.
- The Durable Object's `json()` already sets CORS headers — don't add them again in the outer fetch, browsers reject `Access-Control-Allow-Origin: *, *`.
