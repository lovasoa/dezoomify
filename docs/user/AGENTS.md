- Write the user's next action and outcome; omit implementation details.
- Filenames and heading slugs are published help addresses used by the apps.
  Preserve them or update their references together.
- Keep the initial filename marker in each published page; the builder removes
  it. Use relative Markdown links for other guides.
- Register pages in `scripts/build-help.mjs` and regenerate with
  `node scripts/build-help.mjs`; never commit `help/`.
