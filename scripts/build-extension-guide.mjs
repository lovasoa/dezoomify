#!/usr/bin/env node
// Build the extension's first-run guide from the canonical user documentation.
// The extension displays this fragment inside its own page; the Markdown in
// docs/user remains the only source of user-facing guidance.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, "docs", "user", "browser-extension.md");
const outputPath = process.argv[2];
const GUIDE_STEPS = new Map([
  ["1. Click the Dezoomify icon", "guide-step-1.png"],
  ["2. Let the page settle", "guide-step-2.png"],
  ["3. Start dezooming", "guide-step-3.png"],
]);
const GUIDE_NOTE = "Tiled or static?";

if (!outputPath) {
  console.error("usage: node scripts/build-extension-guide.mjs <output.html>");
  process.exit(1);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rewriteHref(href) {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  const match = href.match(/^\.\/([a-z0-9-]+)\.md(#.*)?$/i);
  if (match) {
    return `https://dezoomify.ophir.dev/beta/help/${match[1]}.html${match[2] ?? ""}`;
  }
  return href;
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const destination = escapeHtml(rewriteHref(href));
    return `<a href="${destination}" target="_blank" rel="noopener">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}

function visualFor(title) {
  const image = GUIDE_STEPS.get(title);
  if (!image) return "";
  return `<img class="dz-guide-screenshot" src="${image}" alt="" aria-hidden="true">`;
}

function renderMarkdown(source) {
  const lines = source.trim().split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let list = null;
  let sectionOpen = false;
  let stepsOpen = false;
  let sectionTag = "section";

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list !== null) {
      output.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      if (sectionOpen) output.push(`</${sectionTag}>`);
      if (stepsOpen && heading[2] === GUIDE_NOTE) {
        output.push("</div>");
        stepsOpen = false;
      }
      if (!stepsOpen && GUIDE_STEPS.has(heading[2])) {
        output.push('<div class="dz-guide-steps">');
        stepsOpen = true;
      }
      const note = heading[2] === GUIDE_NOTE;
      const tag = note ? "aside" : "article";
      const className = note ? "dz-guide-note" : "dz-guide-step";
      output.push(`<${tag} class="${className}">${visualFor(heading[2])}`);
      sectionOpen = true;
      sectionTag = tag;
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (bullet || ordered) {
      closeParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        output.push(`<${kind}>`);
        list = kind;
      }
      output.push(`<li>${inlineMarkdown((bullet ?? ordered)[1])}</li>`);
    } else if (line.trim() === "") {
      closeParagraph();
      closeList();
    } else if (list !== null) {
      const last = output.length - 1;
      if (last >= 0 && output[last].endsWith("</li>")) {
        output[last] = output[last].replace("</li>", ` ${inlineMarkdown(line.trim())}</li>`);
      } else {
        paragraph.push(line.trim());
      }
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  closeParagraph();
  closeList();
  if (sectionOpen) output.push(`</${sectionTag}>`);
  if (stepsOpen) output.push("</div>");
  return output.join("\n");
}

function guideSource(source) {
  const lines = source.split(/\r?\n/);
  const selected = [];
  let section = "skip";
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      section = GUIDE_STEPS.has(heading[1]) || heading[1] === GUIDE_NOTE ? heading[1] : "skip";
    }
    if (GUIDE_STEPS.has(section) || section === GUIDE_NOTE) selected.push(line);
  }
  return selected.join("\n");
}

const body = renderMarkdown(guideSource(readFileSync(sourcePath, "utf8")));
const output = `${body}\n`;
mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, output);
console.log(`build-extension-guide: ${sourcePath} -> ${outputPath}`);
