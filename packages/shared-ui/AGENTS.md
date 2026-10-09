# Shared UI

Follow the root [documentation rule](../../AGENTS.md#documentation).

- Keep components host-neutral: products inject storage, actions, and platform
  capabilities. Detection and download policy belong to Rust.
- Preserve the warm parchment aesthetic, blue-tile [logo](../../favicon.svg),
  spacious URL input, tactile controls, and restrained rectangular geometry.
  Avoid pills, nested cards, and neon styling. Reuse [theme tokens](src/styles/theme.css)
  rather than copying their values into guidelines. Render the logo as native SVG.
- Keep the default view uncluttered, with automatic format detection. Use
  left-aligned copy, visible keyboard focus, and accessible controls. Give errors
  a plain explanation and a next action before collapsible diagnostics. Show the
  active transport; report saves only when the product confirms its disposition.
- Use the shared [translation system](src/i18n.ts) for user copy. Keep locale keys
  and placeholders aligned with English; keep names, codes, URLs, and diagnostics
  literal. Use the existing lookup and fallback path.
- Bundle shared sources directly; do not maintain copied JavaScript or translation
  tables in products. Link to the [user guides](../../docs/user/README.md) for help.
