# dezoomify user documentation

This directory is the **single source of truth for everything users read**:
the help section of the website (`/help/`), the guidance shown inside every
app, and any doc text surfaced elsewhere. Do not duplicate this content in
READMEs, wikis, or external sites: link to it instead.

The pages are written for Dezoomify's users: historians, researchers,
archivists, artists, and collectors. They are deliberately free of
implementation vocabulary. Name user actions and outcomes, not mechanisms;
state platform limits as facts about the app; give every problem at least
one next step. `docs/product.md` defines the full writing rules.

## Pages

Rendered order (also the navigation order in the website help section):

1. [start-here](start-here.md): what Dezoomify does and which app to pick.
2. [website](website.md): the website, its abilities and limits.
3. [browser-extension](browser-extension.md): finding images while you
   browse, including signed-in pages.
4. [desktop-app](desktop-app.md): very large images, more formats,
   resuming, protected pages.
5. [command-line](command-line.md): scripts and bulk downloads.
6. [finding-the-image-address](finding-the-image-address.md): what to paste
   when the image is not found.
7. [troubleshooting](troubleshooting.md): problems and their next steps.
8. [supported-formats](supported-formats.md): every understood site format.

## When to add or edit

- A user-visible behavior, limitation, or app boundary changes.
- A new app or capability ships.
- A support question appears more than once.
- An error message gains a recovery path worth explaining.

Skip it for internal refactors with no user-visible change.

## Editing rules

- A filename stem is the page identity and its web address
  (`help/<stem>.html`). Renaming a page breaks links from error messages
  and other apps; update every reference in the same change.
- Write in the constrained markdown the help generator understands:
  headings (`#`–`###`), paragraphs, bullet and numbered lists, tables,
  fenced code, blockquotes, links, `**bold**`, and `code`.
- Links between pages are relative to this directory (`./website.md`);
  links to site pages use the same `./` form (`./index.html`). The
  generator rewrites both for the published pages.
- Heading text is stable: error messages and apps deep-link to
  `help/<page>.html#<heading-slug>`. Changing a heading changes an address.
- Add a page by adding a `.md` file here and registering it in
  `scripts/build-help.mjs`; the freshness test fails until
  `node scripts/build-help.mjs` regenerates `help/`.
- Never hand-edit files under `help/`; they are generated.
- Never link to legacy external doc sites (the old GitHub wiki, the old
  dezoomify-rs site, the old extension pages). This directory replaces
  them.
