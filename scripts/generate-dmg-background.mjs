// Render the canonical macOS installation steps into the DMG's Finder background.
// Build output stays in target/; edit docs/user/desktop-app.md to change the copy.
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const markdown = await readFile(new URL("docs/user/desktop-app.md", root), "utf8");
const tokens = new MarkdownIt().parse(markdown, {});
const start = tokens.findIndex(
  (token, index) =>
    token.type === "heading_open" && tokens[index + 1]?.content === "Opening the macOS app",
);
if (start < 0) throw new Error("Missing macOS installation section in the desktop app guide");
const end = tokens.findIndex((token, index) => index > start && token.type === "heading_open");
const section = tokens.slice(start, end < 0 ? undefined : end);
const listStart = section.findIndex((token) => token.type === "ordered_list_open");
const listEnd = section.findIndex((token) => token.type === "ordered_list_close");
if (listStart < 0 || listEnd < listStart) throw new Error("Missing macOS installation steps");

function plainText(token) {
  return token.children
    .filter((child) => ["text", "code_inline", "softbreak"].includes(child.type))
    .map((child) => (child.type === "softbreak" ? " " : child.content))
    .join("");
}

const steps = section
  .slice(listStart, listEnd)
  .filter((token) => token.type === "inline")
  .map(plainText);
const note = section.slice(listEnd).find((token) => token.type === "inline");
if (!steps.length || !note) throw new Error("Incomplete macOS installation instructions");
const config = JSON.parse(
  await readFile(new URL("apps/desktop/src-tauri/tauri.conf.json", root), "utf8"),
);
const { width, height } = config.bundle.macOS.dmg.windowSize;
const escapeXml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function lines(text) {
  const result = [""];
  for (const word of text.split(/\s+/)) {
    const last = result.length - 1;
    if (result[last].length + word.length + 1 > 65) result.push(word);
    else result[last] += `${result[last] ? " " : ""}${word}`;
  }
  return result;
}

let y = 300;
const text = steps
  .map((step, index) => {
    const rows = lines(step).map((line) => {
      const row = `<text x="84" y="${y}" font-size="19">${escapeXml(line)}</text>`;
      y += 27;
      return row;
    });
    const number = `<text x="48" y="${y - rows.length * 27}" font-size="19" font-weight="bold" fill="#3f51b5">${index + 1}.</text>`;
    y += 17;
    return number + rows.join("");
  })
  .join("");
const noteRows = lines(plainText(note))
  .map(
    (line, index) =>
      `<text x="48" y="${y + index * 24}" font-size="17" fill="#4b5563">${escapeXml(line)}</text>`,
  )
  .join("");
if (y + lines(plainText(note)).length * 24 > height - 35) {
  throw new Error("macOS instructions exceed the DMG window; adjust its layout before bundling");
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#f7f8fc"/>
  <g font-family="Arial, Helvetica, sans-serif" fill="#202637">
    <text x="${width / 2}" y="58" text-anchor="middle" font-size="30" font-weight="bold">Install ${escapeXml(config.productName)}</text>
    <path d="M 330 145 H 430 M 412 130 L 430 145 L 412 160" fill="none" stroke="#3f51b5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 48 253 H ${width - 48}" stroke="#dce0ef"/>
    ${text}${noteRows}
  </g>
</svg>`;
const output = new URL("target/desktop-dmg/", root);
await mkdir(output, { recursive: true });
await sharp(Buffer.from(svg))
  .png()
  .toFile(fileURLToPath(new URL("background.png", output)));
console.log(`DMG installation background: ${fileURLToPath(output)}background.png`);
