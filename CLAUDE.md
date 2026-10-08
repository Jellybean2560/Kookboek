# Kookboek — project notes

Dutch-language recipe PWA for Android + iOS. Single file `index.html`, no build step, deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Pieces
- `index.html` — whole app (HTML + CSS + JS). Hash router: `#/vandaag[/base[/protein[/time]]]`, `#/recepten`, `#/toevoegen`, `#/recept/{id}`, `#/koken/{id}/{step}`, `#/inhuis`, `#/boodschappen[/kies]`, `#/bewerk/{id|nieuw}`, `#/instellingen`, `#/koppel/{code}`.
  - Wizard steps skip themselves (`location.replace`) when there's only one meaningful answer; recipes without a time are listed under "Tijd onbekend" rather than counted as quick. Cooked in the last 7 days is hidden unless that would leave nothing.
  - Cook mode: durations in step text (`DURATION_RE`) become timer buttons; timers persist in `kb_timers` as end times, alarm = WebAudio beep + vibrate. Browsers don't run pages in the background, so the alarm sounds when the app is in front again. "Nodig voor deze stap" matches ingredient words (minus units/adjectives) against the step text, incl. Dutch compound suffixes.
  - Week menu: a `plan` doc has `day` ('YYYY-MM-DD' or null = shopping only). Home shows "Vanavond" (plans for today) and a 7-day strip; tapping an empty day sets `todayState.planDay`, which makes the recipe page offer "Plan voor <dag>". `openPlanSheet()` picks/changes a day.
  - Kooklogboek: `recipe.log = [{at, note}]` (newest first, max 50). "Gekookt" and cook-mode "Klaar" open the log sheet.
  - Cook mode: 🔊 reads steps aloud (speechSynthesis, nl-BE voice if present); 🎙️ uses (webkit)SpeechRecognition for "volgende/vorige/herhaal/timer/klaar" and restarts itself when the browser stops listening; recognition is aborted while the app is speaking. Works well in Chrome on Android, unreliable on iOS.
  - Text size: `settings.textScale` → CSS `--scale` on body text, detail title and cook text.
  - Bottom sheets via `openSheet()/closeSheet()`; render() only closes them on a real navigation, since background syncs redraw too.
- `sw.js` — network-first app shell (`kookboek-v4`, bump to force refresh). `manifest.json` has a `share_target` so Android's share sheet opens `./?url=…`.
- `worker/` — Cloudflare Worker `kookboek`, live at `https://kookboek.jellevandenwouwer.workers.dev`. Deploy with `cd worker && npx wrangler deploy` (wrangler is logged in on this PC).
  - `GET /import?url=` fetches a recipe page server-side, parses schema.org `Recipe` JSON-LD (microdata fallback), returns normalised JSON. Never returns raw HTML (not an open proxy).
  - `GET /image?url=` returns one image (image/* only, ≤8 MB). The app stores imported photos as its own ~900px JPEG data-URL copy (`copyImage`), and `migrateImages()` converts older recipes that still hotlink.
  - All AI routes are charged an estimated neuron cost (`AI_COST`: scan 160, classify 30, assist 90) against a daily budget in the `Limiter` DO: 4500 per IP, 9000 total (free allowance is 10k).
  - `POST /classify` {recipe} → {bases, proteins, time}. New imported/scanned/pasted drafts call it in the background (`classifyDraft`); the keyword `guessTags()` stays as fallback. The prompt spells out that bread/flour cooked *into* a sauce isn't a base and to fall back to the Belgian default side (stoofvlees → aardappelen).
  - `POST /assist` {mode: 'vega'|'side', recipe} → vegetarian variant (saved as a new draft) or 3 side dishes (ingredients can go on the shopping list as manual items with `from`).
  - `GET /b/{code}/snapshots[/{id}]` — the Book copies its live recipes once a day *before* applying the day's first changes; 14 kept. Restore in Instellingen re-saves those recipes as new versions (later additions stay).
  - `POST /scan` `{images: [dataURL]}` (max 4, ~1600px JPEG) — photo of a printed/handwritten recipe → recipe JSON via Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct` (`[ai]` binding). Free plan: 10k neurons/day, ~150 per photo; over the limit it errors (429), never bills. Chosen over mistral-small-3.1 (similar, slightly worse on diacritics); gemma-3 is not enabled on this account.
  - `POST /b/{code}/sync` — one SQLite Durable Object per shared book. Client sends `{since, changes}`; server keeps per-recipe last-write-wins on client `updatedAt` and returns rows with `seq > since`. Deletions are tombstones (`deleted: true`).
- Local testing: `localStorage.kb_api = 'http://localhost:8787'` points the app at `wrangler dev`.

## Data
- Recipes in IndexedDB `kookboek/recipes` (photos are data-URLs, too big for localStorage). Settings in `kb_settings`, unsynced ids in `kb_dirty`.
- Recipe: `{id, title, image, source, servings, time, bases[], proteins[], ingredients[], steps[], notes, favorite, rating (0–5), lastCooked, cookCount, createdAt, updatedAt}`.
- Shopping list (`#/boodschappen`, picker `#/boodschappen/kies`) lives in the same store/sync as recipes, as docs with a `kind`: `plan` `{recipeId, servings}` and `item` `{planId, recipeId, line, checked}` or a manual `{line, manual: true}`. `liveRecipes()` excludes `kind` docs; `liveDocs(kind)` returns them. One doc per line so two phones can tick at once. Items keep the original recipe line and are scaled to the plan's servings when drawn.
  - `shoppingLines()` groups by product key (`parseLine`: ingredient words, crude singular, `SYNONYMS` like ajuin→ui), sums per unit family (`UNIT_BASE` g/ml/el/tl; other units stay separate, joined with " + "), rounds pieces up, sorts by supermarket aisle (`AISLES`, checked in an order where "kippenbouillon"/"blik tomaten" aren't meat/fresh), and puts `STAPLES` (zout, peper, olie…) under "Heb je dit nog in huis?".
  - 📌 Vaste producten: `product` docs (`prod-<key>`) map a list key to a pasted Collect&Go link; product pages are `/nl/zoek?searchTerm=…#pdp_<id>` and open directly on the product with "Toevoegen aan winkelwagen". Lines can be swiped right/left to (un)tick.
  - Collect&Go has no public API to fill a cart. Each line links to `https://www.collectandgo.be/nl/zoek?searchTerm=…` (verified Oct 2026; `/nl/zoeken` is a 404). Neither colruyt.be nor collectandgo.be publishes app links, so it opens the webshop in the browser, not the Xtra app. Don't automate their private API (needs the user's Xtra password, ToS, bot protection).
- Deleting sets `deleted: true, deletedAt` but keeps the contents for 30 days ("Onlangs verwijderd", undo toast); `emptyOldTrash()` then strips it to a bare tombstone. Old tombstones without `title` are pre-trash and can't be restored.
- Without a shared book there are no server snapshots; `backupBanner()` nags monthly to export (share sheet on phones). Lines starting with `#` (or `## ` from imports) are section headings.
- Untagged recipes count as `anders` in the wizard (`effBases` / `effProteins`).

## Gotchas
- **Allerhande (ah.nl) returns 403** to any non-browser fetch (Akamai bot protection), including from Cloudflare. The "Tekst plakken" path (`parseRecipeText`) is the workaround — don't try to evade the block.
- **Dagelijkse Kost** only puts the first 2 steps in JSON-LD; `nextPayloadSteps()` reads the full list from the Next.js payload.
- `guessTags()` keyword-matches ingredient lines; strip false friends first (kippenbouillon, vissaus, currypasta, tomatenpuree, rundergehakt → gehakt).
- Quantity scaling only touches the *leading* quantity of an ingredient line (`QTY_RE`); at factor 1 the original text is shown untouched.
- The Durable Object's `json()` already sets CORS headers — don't add them again in the outer fetch, browsers reject `Access-Control-Allow-Origin: *, *`.
