# Shared UI Guidelines

## Visual Identity & Design System

Retain Dezoomify's authentic parchment aesthetic, wide proportions, and distinctive tactile controls tailored to an audience of art historians, archivists, museum researchers, and cultural heritage enthusiasts:

1. **Logo & Heritage:**
   - Always use the authentic Dezoomify logo (`getDezoomifyLogoSvg`): sapphire blue magnifying glass (`#3c7bff`) framing coral-salmon tile quadrants (`#ff8080`).
   - Pair with clean navigation buttons (`Browser Extension`, `Desktop App`), right-anchored `Help`, and bold `Donate`. Do not link to obsolete legacy external sites or duplicate links in the bottom footer.

2. **Colors & Atmosphere (No Sci-Fi / LLM Smell):**
   - Light Mode: Page background is cool off-white `#fcfeff`. Surface card and navigation use the signature warm parchment gradient `linear-gradient(180deg, #f7eded 0%, #f7eeee 100%)` with warm slate border `1px solid #a19797` and natural warm drop shadow `0 4px 20px rgba(130, 115, 110, 0.12)`.
   - Dark Mode: Night gallery / archivist atelier palette. Warm charcoal background `#181615` (never cold blue-black), warm dark walnut/parchment surface `linear-gradient(180deg, #252220 0%, #1e1c1a 100%)`, warm stone border `1px solid #3f3935`, and natural dark shadow. Avoid cold space-terminal voids or neon halos.
   - Link colors: scholarly sapphire `#1d4ed8` in light mode; illuminated manuscript warm ochre/gold `#dfa44e` in dark mode.
   - Primary button: tactile beveled parchment `linear-gradient(180deg, #fffafa 0%, #dfd8d8 100%)` in light mode; tactile dark bronze `linear-gradient(180deg, #332e2a 0%, #25211e 100%)` in dark mode.
   - Interactive focus: crisp architectural focus ring `0 0 0 2px rgba(...)`, never blurry neon halos.

3. **Forbidden Pills & Architectural Geometry:**
   - "Pills" in the UI are strictly forbidden. Progress bars, tracks, badges, clear buttons, and modal step indicators use crisp architectural geometry (`border-radius: var(--dz-radius)`, 3–4px), never `9999px` or bubble pills.

4. **Zero Nested Boxes (Breathable Layout):**
   - Eliminate nested container syndrome (no box inside a box inside a box). The status card is the single surface container.
   - In error, display-only, and completed states, content flows directly within the card with generous vertical rhythm and whitespace.
   - Guidance paths (Extension, Desktop, FAQ) render as an open, breathable typographic grid without heavy bordered card containers.

5. **Spacious Proportions & Input Visibility:**
   - The status card must be spacious (`max-width: 960px` or `width: min(92%, 960px)`).
   - The URL input field must be full-width (`width: 100%`) with `3.25rem` (52px) height and `1.05rem` font size, accommodating 100–250+ character URLs from IIIF manifests and digital collections without horizontal truncation.

6. **Format Selection & Progressive Disclosure:**
   - Display a serene, uncluttered default view: full-width input, a compact interactive format indicator (`Format: Select automatically (click to change)`), and the centered `Dezoomify !` button.
   - Clicking smoothly discloses the full 17-format grid.

7. **Pinned Bottom Footer & Error Guidance:**
   - Footer is pinned to the true bottom (`margin-top: auto`), containing only legal and repo links (`Open Source (GPL)`, `FAQ`, `Privacy`, `Terms`, `Donate`). Avoid redundant slogans.
   - Layer error messages: concise plain sentence first, actionable interactive guidance for our Extension and Desktop app, and collapsible diagnostics.
