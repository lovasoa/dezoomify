# Shared UI Guidelines

## Visual Identity & Design System

Retain Dezoomify's authentic parchment aesthetic, wide proportions, and distinctive tactile controls:

1. **Colors & Gradients:**
   - Page background: `#fcfeff`
   - Surface card & navigation: `linear-gradient(180deg, #f7eded 0%, #f7eeee 100%)`
   - Border: `1px solid #a19797`
   - Atmosphere shadow: `0 0 12px rgba(185, 190, 240, 0.45)`
   - Primary button: `linear-gradient(180deg, #fffafa 0%, #dfd8d8 100%)` with `1px solid #8c8080`, text `#1c1917`
   - Focus outline: `box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.3)`
   - Radio accent: `#0284c7` (teal/cyan)

2. **Spacious Proportions & Input Visibility:**
   - The status card must be wide (`max-width: 960px` or `width: min(92%, 960px)`) to provide comfortable room for URLs and image previews.
   - The URL input field must be full-width (`width: 100%`) with `3rem` (48px) height and `1.05rem` font size, accommodating 120–250+ character URLs from IIIF manifests and image servers without truncation.

3. **Format Selection & Action CTA:**
   - Supported formats are displayed with "Select automatically" pre-selected as the highlighted default choice.
   - The primary action button `[ Dezoomify ! ]` is centered and substantial below the format options.

4. **Progressive Disclosure:**
   - Layer error messages: concise plain sentence first, actionable next steps (Extension, Desktop app, FAQ), collapsible diagnostics.
   - Progress uses an elegant cyan/blue track and tabular counts.
