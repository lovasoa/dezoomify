#!/usr/bin/env node
// Generates the website help section under help/ from docs/user/*.md.
// docs/user is the single source of truth: never hand-edit help/; run
// `node scripts/build-help.mjs` after editing any page.
// Deterministic: same inputs produce byte-identical output.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, "docs", "user");
const outDir = path.join(root, "help");

// Render order; keep in sync with docs/user/README.md.
const PAGES = [
  { stem: "start-here", blurb: "What Dezoomify does and which app to pick." },
  { stem: "website", blurb: "The website: how to use it and what it cannot do." },
  { stem: "browser-extension", blurb: "Find images while you browse, including signed-in pages." },
  {
    stem: "desktop-app",
    blurb: "Very large images, more file formats, resuming, protected pages.",
  },
  { stem: "command-line", blurb: "Scripts and downloading many images at once." },
  { stem: "finding-the-image-address", blurb: "What to paste when no image is found." },
  { stem: "troubleshooting", blurb: "Something did not work? Start here." },
  { stem: "supported-formats", blurb: "Every site format Dezoomify understands." },
];

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Rewrite a markdown link target for publication under /help/.
function rewriteHref(href) {
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  let m = href.match(/^\.\/([a-z0-9-]+)\.md(#.*)?$/);
  if (m) return { href: `${m[1]}.html${m[2] ?? ""}` };
  // Site pages (index.html, privacy.html, terms.html) live one level up.
  m = href.match(/^\.\/([a-z0-9-]+\.[a-z]+)(#.*)?$/);
  if (m) return { href: `../${m[1]}${m[2] ?? ""}` };
  return { href };
}

// Markdown rendering is the markdown-it dependency (deterministic:
// same inputs produce byte-identical output). Headings get stable ids
// from slugify so error messages and apps can deep-link to
// help/<page>.html#<heading-slug>; links are rewritten for publication
// under /help/ with external targets opened in a new tab.
const mdIt = new MarkdownIt({ html: false, linkify: false, typographer: false });

const defaultHeadingOpen = mdIt.renderer.rules.heading_open;
mdIt.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const next = tokens[idx + 1];
  let title = "";
  if (next && next.type === "inline" && Array.isArray(next.children)) {
    title = next.children
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join(" ");
  } else if (next && next.type === "inline") {
    title = next.content;
  }
  tokens[idx].attrSet("id", slugify(title));
  if (defaultHeadingOpen) return defaultHeadingOpen(tokens, idx, options, env, self);
  return self.renderToken(tokens, idx, options);
};

const defaultLinkOpen = mdIt.renderer.rules.link_open;
mdIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href");
  if (href) {
    const { href: out, external } = rewriteHref(href);
    tokens[idx].attrSet("href", out);
    if (external) {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener");
    }
  }
  if (defaultLinkOpen) return defaultLinkOpen(tokens, idx, options, env, self);
  return self.renderToken(tokens, idx, options);
};

function renderMarkdown(src) {
  return mdIt.render(src).trim();
}

const LOGO_SVG = readFileSync(path.join(root, "favicon.svg"), "utf8").replace(
  "<svg ",
  '<svg width="20" height="20" aria-hidden="true" style="vertical-align: middle;" ',
);

const pageStyle = `
    <style>
      .dz-help-layout {
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        gap: 2.5rem;
        align-items: start;
        max-width: 1120px;
        margin: 0 auto;
        width: 100%;
      }
      @media (max-width: 820px) {
        .dz-help-layout { grid-template-columns: 1fr; gap: 1.5rem; }
      }
      .dz-help-topics {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: 0.95rem;
      }
      .dz-help-topics li { margin: 0 0 0.55rem 0; }
      .dz-help-topics a { text-decoration: none; }
      .dz-help-topics a[aria-current="page"] {
        color: var(--dz-text-primary);
        font-weight: 600;
      }
      .dz-help-article h1 { font-size: 1.9rem; margin: 0 0 1.2rem 0; }
      .dz-help-article h2 { font-size: 1.3rem; margin: 2.2rem 0 0.7rem 0; }
      .dz-help-article h3 { font-size: 1.1rem; margin: 1.6rem 0 0.5rem 0; }
      .dz-help-article p, .dz-help-article li { line-height: 1.65; }
      .dz-help-article ul, .dz-help-article ol { padding-left: 1.4rem; margin: 0.6rem 0; }
      .dz-help-article li { margin: 0.35rem 0; }
      .dz-help-article table {
        border-collapse: collapse;
        width: 100%;
        margin: 1rem 0;
        font-size: 0.92rem;
      }
      .dz-help-article th, .dz-help-article td {
        border: 1px solid var(--dz-surface-border);
        padding: 0.45rem 0.7rem;
        text-align: left;
        vertical-align: top;
      }
      .dz-help-article th { background: rgba(161, 151, 151, 0.08); }
      .dz-help-article pre {
        background: rgba(161, 151, 151, 0.1);
        border: 1px solid var(--dz-surface-border);
        border-radius: var(--dz-radius);
        padding: 0.8rem 1rem;
        overflow-x: auto;
        font-size: 0.88rem;
      }
      .dz-help-article blockquote {
        margin: 1rem 0;
        padding: 0.2rem 0 0.2rem 1rem;
        border-left: 3px solid var(--dz-surface-border);
        color: var(--dz-text-secondary);
      }
      .dz-help-article code {
        font-family: var(--dz-font-mono);
        font-size: 0.88em;
        background: rgba(161, 151, 151, 0.12);
        border-radius: 3px;
        padding: 0.1em 0.35em;
      }
      .dz-help-article pre code { background: none; padding: 0; }
      .dz-help-index-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 1.4rem 2.4rem;
        margin-top: 1.6rem;
      }
      .dz-help-index-item-title { font-weight: 600; margin: 0 0 0.25rem 0; }
      .dz-help-index-item-title a { text-decoration: none; }
      .dz-help-index-item-desc { margin: 0; color: var(--dz-text-secondary); }
    </style>`;

function chrome({ title, description, topicsHtml, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(description)}" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/svg+xml" href="../favicon.svg" />
    <link rel="alternate icon" type="image/png" href="../favicon.png" />
    <link rel="stylesheet" href="theme.css" />
${pageStyle}
  </head>
  <body>
    <header class="dz-nav">
      <a href="../index.html" class="dz-brand" title="Online zoomable image download">
        ${LOGO_SVG}
        <span>Dezoomify</span>
      </a>
      <nav class="dz-nav-links" aria-label="Main Navigation">
        <a href="../index.html" class="dz-nav-link">Dezoomify</a>
        <a href="index.html" class="dz-nav-link help-link" aria-current="page" title="Help &amp; documentation">Help</a>
        <a href="https://github.com/sponsors/lovasoa/" class="dz-nav-link donate" target="_blank" rel="noopener" title="Support hosting costs">Donate</a>
      </nav>
    </header>

    <main class="dz-main">
      <div class="dz-card">
        <div class="dz-help-layout">
          <nav class="dz-help-nav" aria-label="Help topics">
            ${topicsHtml}
          </nav>
          <article class="dz-help-article">
${bodyHtml}
          </article>
        </div>
      </div>
    </main>

    <footer class="dz-site-footer dz-footer">
      <div class="dz-footer-links">
        <a href="../index.html">Dezoomify</a>
        <a href="../privacy.html">Privacy</a>
        <a href="../terms.html">Terms</a>
        <a href="https://github.com/lovasoa/dezoomify" target="_blank" rel="noopener">Open Source (GPL)</a>
        <a href="https://github.com/sponsors/lovasoa/" target="_blank" rel="noopener">Donate</a>
      </div>
    </footer>
  </body>
</html>
`;
}

function topicsNav(currentStem) {
  const items = PAGES.map(
    (p) =>
      `                <li><a href="${p.stem}.html"${
        p.stem === currentStem ? ' aria-current="page"' : ""
      }>${escapeHtml(pageMeta.get(p.stem).title)}</a></li>`,
  );
  return `\n              <ul class="dz-help-topics">\n${items.join("\n")}\n              </ul>\n            `;
}

// Parse a page: the first line `# <stem>` is a marker; the next `# ...` is
// the page title.
const pageMeta = new Map();
const rendered = new Map();
for (const { stem } of PAGES) {
  const md = readFileSync(path.join(srcDir, `${stem}.md`), "utf8");
  const marker = md.match(/^# (\S+)\n/m);
  if (!marker || marker[1] !== stem) {
    throw new Error(`${stem}.md must start with a "# ${stem}" marker line`);
  }
  const titleMatch = md.slice(marker[0].length).match(/^# (.+)$/m);
  if (!titleMatch) throw new Error(`${stem}.md lacks an H1 title after the marker`);
  const title = titleMatch[1].trim();
  pageMeta.set(stem, { title });
  rendered.set(stem, renderMarkdown(md.slice(marker[0].length).trimStart()));
}

mkdirSync(outDir, { recursive: true });
// Publish the app's actual theme beside the pages: dist/ never serves sources.
copyFileSync(
  path.join(root, "packages/shared-ui/src/styles/theme.css"),
  path.join(outDir, "theme.css"),
);

for (const { stem, blurb } of PAGES) {
  const { title } = pageMeta.get(stem);
  writeFileSync(
    path.join(outDir, `${stem}.html`),
    chrome({
      title: `${title}: Dezoomify Help`,
      description: blurb,
      topicsHtml: topicsNav(stem),
      bodyHtml: rendered.get(stem),
    }),
  );
}

const indexItems = PAGES.map(
  ({ stem, blurb }) => `            <div class="dz-help-index-item">
              <p class="dz-help-index-item-title"><a href="${stem}.html">${escapeHtml(pageMeta.get(stem).title)}</a></p>
              <p class="dz-help-index-item-desc">${escapeHtml(blurb)}</p>
            </div>`,
);

writeFileSync(
  path.join(outDir, "index.html"),
  chrome({
    title: "Help & documentation: Dezoomify",
    description:
      "How to download zoomable images with Dezoomify: the website, browser extension, desktop app, troubleshooting, and supported formats.",
    topicsHtml: topicsNav(null),
    bodyHtml: `<h1>Help &amp; documentation</h1>
<p>Everything you need to save zoomable images with Dezoomify. New here?
Start with <a href="start-here.html">Start here</a>: it explains which of
the four apps fits your situation.</p>
<div class="dz-help-index-grid">
${indexItems.join("\n")}
</div>`,
  }),
);
