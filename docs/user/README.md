# User guides

These pages generate website help; the [desktop guide](../../apps/desktop/desktop-app.md)
also supplies the DMG installation instructions. Link to these guides rather
than copying their advice into component READMEs.

## Pages

1. [Start here](start-here.md): choose an app.
2. [Website](website.md): save from a browser.
3. [Browser extension](browser-extension.md): use your source-page session.
4. [Desktop](../../apps/desktop/desktop-app.md): larger images and installation.
5. [Command line](command-line.md): scripts and bulk saving.
6. [Finding the image address](finding-the-image-address.md).
7. [Troubleshooting](troubleshooting.md).
8. [Supported formats](supported-formats.md).

## When to add or edit

Follow the root [documentation rule](../../AGENTS.md#documentation). Lead with
the user's next action and outcome; omit implementation vocabulary. Fix advice
when it becomes wrong or incomplete. New error variants and internal refactors
do not each need documentation.

## Editing rules

- Filenames and heading slugs are public help addresses used by the apps.
  Preserve them or update every reference together.
- Keep the initial filename marker line in published guide sources; the help
  builder removes it before rendering. Use standard Markdown and relative links
  between source pages; the builder rewrites them for publication.
- Page registration and navigation order live in `scripts/build-help.mjs`.
  Run `node scripts/build-help.mjs` after edits; never commit generated `help/`.
- Keep the desktop guide in its current location. Its macOS installation heading,
  ordered steps, and following note are consumed by the DMG background generator.
