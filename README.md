# Kookboek

Jullie eigen receptenboek als app voor Android en iPhone.

- **Wat eten we?** — kies aardappelen/rijst/pasta/…, dan kip/gehakt/steak/vis/…, dan hoeveel tijd je hebt, en krijg jullie eigen recepten als fotokaarten (wat deze week al op tafel kwam wordt verborgen, of laat de app kiezen). Bovenaan suggesties: favorieten en wat je lang niet meer maakte.
- **Wat heb ik in huis?** — vul ingrediënten in en zie welke recepten je ermee kunt maken.
- **Kookmodus** — stap voor stap met grote tekst, de ingrediënten per stap, en timers door op een tijd in de tekst te tikken.
- **Favorieten en sterren**, en verwijderen met *Ongedaan maken*.
- **Recepten importeren** via een link (Leuke Recepten, Dagelijkse Kost, 24Kitchen en de meeste sites met receptgegevens), via een **foto** van een kookboek of handgeschreven briefje (gratis, via Cloudflare Workers AI), via geplakte tekst, of zelf intypen met eigen foto.
- **Omrekenen** naar het aantal personen.
- **Samen één kookboek** — koppel meerdere telefoons met een code; wijzigingen worden gesynchroniseerd en het kookboek wordt elke dag automatisch bewaard (14 dagen terug te zetten). Verwijderde recepten blijven 30 dagen terug te halen.
- Werkt offline zodra de app geladen is; scherm blijft aan tijdens het koken.

## Installeren
- **iPhone:** open de link in Safari → deel-icoon → *Zet op beginscherm*.
- **Android:** open de link in Chrome → ⋮ → *App installeren*. Daarna kun je vanuit Chrome een recept *Delen* naar Kookboek.

## Ontwikkeling
Zie `CLAUDE.md`. App: push naar `main` (GitHub Pages). Backend: `cd worker && npx wrangler deploy`.
