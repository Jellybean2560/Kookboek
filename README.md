# Kookboek

Jullie eigen receptenboek als app voor Android en iPhone.

- **Wat eten we?** — kies aardappelen/rijst/pasta/…, dan kip/gehakt/steak/vis/…, en krijg jullie eigen recepten (langst niet gekookt bovenaan, of laat de app kiezen).
- **Recepten importeren** via een link (Leuke Recepten, Dagelijkse Kost, 24Kitchen en de meeste sites met receptgegevens), via een **foto** van een kookboek of handgeschreven briefje (gratis, via Cloudflare Workers AI), via geplakte tekst, of zelf intypen met eigen foto.
- **Omrekenen** naar het aantal personen.
- **Samen één kookboek** — koppel meerdere telefoons met een code; wijzigingen worden gesynchroniseerd.
- Werkt offline zodra de app geladen is; scherm blijft aan tijdens het koken.

## Installeren
- **iPhone:** open de link in Safari → deel-icoon → *Zet op beginscherm*.
- **Android:** open de link in Chrome → ⋮ → *App installeren*. Daarna kun je vanuit Chrome een recept *Delen* naar Kookboek.

## Ontwikkeling
Zie `CLAUDE.md`. App: push naar `main` (GitHub Pages). Backend: `cd worker && npx wrangler deploy`.
