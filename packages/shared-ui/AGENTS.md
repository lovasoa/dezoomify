# Shared UI Guidelines

## Visual Identity & Design System

Retain Dezoomify's authentic parchment aesthetic, wide proportions, and distinctive tactile controls tailored to an audience of art historians, archivists, museum researchers, and cultural heritage enthusiasts:

1. **Logo & Heritage:**
   - Always use the authentic Dezoomify logo (`getDezoomifyLogoSvg`): sapphire blue magnifying glass (`#3c7bff`) framing coral-salmon tile quadrants (`#ff8080`).
   - Pair with classic navigation links: `dezoomify-extension`, `dezoomify-rs`, bold `donate`, and right-anchored `Help`.

2. **Colors & Gradients:**
   - Page background: cool off-white `#fcfeff`
   - Surface card & navigation: warm parchment gradient `linear-gradient(180deg, #f7eded 0%, #f7eeee 100%)`
   - Border: warm slate `1px solid #a19797`
   - Atmosphere shadow: diffuse lilac glow `0 0 12px rgba(185, 190, 240, 0.45)`
   - Primary button: tactile beveled parchment `linear-gradient(180deg, #fffafa 0%, #dfd8d8 100%)` with `1px solid #8c8080`, dark text `#1c1917`
   - Interactive focus: vivid cyan halo `box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.3)`
   - Radio indicator: teal/cyan accent `#0284c7`

3. **Spacious Proportions & Input Visibility:**
   - The status card must be spacious (`max-width: 960px` or `width: min(92%, 960px)`) to provide comfortable room for URLs and image previews.
   - The URL input field must be full-width (`width: 100%`) with `3.2rem` (50px) height and `1.05rem` font size, accommodating 100–250+ character URLs from IIIF manifests and digital collections without horizontal truncation.

4. **Format Selection & Action CTA:**
   - Supported formats are displayed with "Select automatically" pre-selected as the highlighted default choice.
   - The primary action button `[ Dezoomify ! ]` is centered and substantial below the format options.

5. **Progressive Disclosure:**
   - Left-align body copy (never `text-align: justify`).
   - Layer error messages: concise plain sentence first, actionable next steps (Extension, Desktop app, FAQ), collapsible diagnostics.
   - Progress uses an elegant cyan/blue track and tabular counts.
