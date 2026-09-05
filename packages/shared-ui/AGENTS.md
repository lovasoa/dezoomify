# Shared UI Guidelines

## Visual Identity & Design System

Retain Dezoomify's authentic parchment aesthetic, wide proportions, and distinctive tactile controls tailored to an audience of art historians, archivists, museum researchers, and cultural heritage enthusiasts:

1. **Logo & Heritage:**
   - Always use the authentic Dezoomify logo (`getDezoomifyLogoSvg`): sapphire blue magnifying glass (`#3c7bff`) framing coral-salmon tile quadrants (`#ff8080`).
   - Pair with clean navigation buttons (`Browser Extension`, `Desktop App`), right-anchored `Help`, and bold `Donate`. Do not link to obsolete legacy external sites or duplicate links in the bottom footer.

2. **Colors & Gradients:**
   - Page background: cool off-white `#fcfeff`
   - Surface card & navigation: warm parchment gradient `linear-gradient(180deg, #f7eded 0%, #f7eeee 100%)`
   - Border: warm slate `1px solid #a19797`
   - Atmosphere shadow: diffuse lilac glow `0 0 14px rgba(185, 190, 240, 0.45)`
   - Primary button: tactile beveled parchment `linear-gradient(180deg, #fffafa 0%, #dfd8d8 100%)` with `1px solid #8c8080`, dark text `#1c1917`
   - Interactive focus: vivid cyan halo `box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.25)`
   - Radio indicator: teal/cyan accent `#0284c7`
   - Link colors: scholarly sapphire `#1d4ed8` (light) / luminous cyan `#38bdf8` (dark), with visited links matching harmonious tones (`#3730a3` / `#93c5fd`), never default browser purple.

3. **Spacious Proportions & Input Visibility:**
   - The status card must be spacious (`max-width: 960px` or `width: min(92%, 960px)`).
   - The URL input field must be full-width (`width: 100%`) with `3.25rem` (52px) height and `1.05rem` font size, accommodating 100–250+ character URLs from IIIF manifests and digital collections without horizontal truncation.

4. **Format Selection & Progressive Disclosure:**
   - Display a serene, uncluttered default view: full-width input, a compact interactive format indicator (`● Format: Select automatically (click to change)`), and the centered `Dezoomify !` button.
   - Clicking smoothly discloses the full 17-format grid.

5. **Pinned Bottom Footer & Error Guidance:**
   - Footer is pinned to the true bottom (`margin-top: auto`), containing only legal and repo links (`Open Source (GPL)`, `FAQ`, `Privacy`, `Terms`, `Donate`). Avoid redundant slogans.
   - Layer error messages: concise plain sentence first, actionable interactive guidance for our Extension and Desktop app, and collapsible diagnostics.
