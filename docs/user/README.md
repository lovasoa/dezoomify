# dezoomify user documentation

The guides here and [the desktop guide](../../apps/desktop/desktop-app.md) are
the **single source of truth for everything users read**:
the help section of the website (`/help/`), the guidance shown inside every
app, and any doc text surfaced elsewhere. Do not duplicate this content in
READMEs, wikis, or external sites: link to it instead.

The pages are written for Dezoomify's users: historians, researchers,
archivists, artists, and collectors. They are deliberately free of
implementation vocabulary. Name user actions and outcomes, not mechanisms;
state platform limits as facts about the app; give every problem at least
one next step. Lead with a specific outcome and the best next action; keep
technical details expandable or linked.

## Pages

Rendered order (also the navigation order in the website help section):

1. [start-here](start-here.md): what Dezoomify does and which app to pick.
2. [website](website.md): the website, its abilities and limits.
3. [browser-extension](browser-extension.md): finding images while you
   browse, including signed-in pages.
4. [desktop-app](../../apps/desktop/desktop-app.md): very large images, protected pages.
5. [command-line](command-line.md): scripts.
6. [finding-the-image-address](finding-the-image-address.md): what to paste
   when the image is not found.
7. [troubleshooting](troubleshooting.md): problems and their next steps.
8. [supported-formats](supported-formats.md): every understood site format.

## When to add or edit

Follow the root [documentation rule](../../AGENTS.md#documentation). Edit a guide
when its advice becomes wrong or misses a step needed to finish the task.
Repeated support questions can justify an explanation in an existing page.
New capabilities and error variants do not each need their own documentation;
add a page only for a distinct, recurring user task. Internal refactors need no
user-doc edits.

## Editing rules

- A filename stem is the page identity and its web address
  (`help/<stem>.html`). Renaming a page breaks links from error messages
  and other apps; update every reference in the same change.
- Write in standard Markdown (headings, paragraphs, bullet and numbered
  lists, tables, fenced code, blockquotes, links, bold, and code). The
  help generator renders it with the markdown-it dependency.
- Links between pages are relative to their source file (`./website.md` here,
  `../../docs/user/website.md` from the desktop guide);
  links to site pages use the same `./` form (`./index.html`). The
  generator rewrites both for the published pages.
- Heading text is stable: error messages and apps deep-link to
  `help/<page>.html#<heading-slug>`. Changing a heading changes an address.
- The desktop guide lives under `apps/desktop/` because its installation steps
  are packaged in the DMG and must trigger desktop CI.
- Add a page by adding a `.md` file here and registering its source in
  `scripts/build-help.mjs`; `node scripts/build-help.mjs` regenerates
  `help/` (untracked: the website-deploy workflow builds it at deploy
  time, and the web test lanes regenerate it before testing).
- Never hand-edit files under `help/`; they are generated.
- Never link to legacy external doc sites (the old GitHub wiki, the old
  dezoomify-rs site, the old extension pages). This directory replaces
  them.
