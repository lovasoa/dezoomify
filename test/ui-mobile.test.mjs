import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

// The extension modal links the vendored canonical theme
// (`vendor/theme.css`, generated at build time by
// scripts/sync-web-js.mjs from packages/shared-ui/src/styles/theme.css) and
// ships no inline theme subset. These gates read the canonical theme (the
// single source of truth, byte-identical to the vendor copy per the
// extension shared-ui parity suite) plus the page shell.

/** Normalize one CSS declaration for cross-file comparison. */
function normDecl(decl) {
  return decl.replace(/\s+/g, " ").trim().toLowerCase();
}

test("mobile: website theme keeps the 768/560/380px breakpoint stack", () => {
  const css = read("packages/shared-ui/src/styles/theme.css");
  assert.match(css, /@media\s*\(max-width:\s*768px\)/, "768px breakpoint exists");
  assert.match(css, /@media\s*\(max-width:\s*560px\)/, "560px breakpoint exists");
  assert.match(css, /@media\s*\(max-width:\s*380px\)/, "380px breakpoint exists");

  const small = css.slice(css.indexOf("max-width: 560px"));
  for (const decl of [
    ".dz-progress-controls",
    "flex-direction: column",
    ".dz-job-actions",
    ".dz-actions-row",
    "width: 100%",
  ]) {
    assert.ok(small.includes(decl), `560px rules cover ${decl}`);
  }
  const narrow = css.slice(css.indexOf("max-width: 380px"));
  for (const decl of [".dz-card", "padding: 1.25rem 0.85rem", "font-size: 1.45rem", "flex-direction: column"]) {
    assert.ok(narrow.includes(decl), `380px rules cover ${decl}`);
  }
});

test("mobile: extension modal links the canonical theme with no inline fork", () => {
  const html = read("apps/extension/src/modal/modal.html");
  assert.match(html, /<link rel="stylesheet" href="\.\.\/vendor\/theme\.css" \/>/, "modal links the vendored canonical theme");
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.ok(!styles.includes(".dz-"), "page ships no inline theme subset (theme owns all dz-* geometry)");
  assert.ok(!styles.includes("@media"), "page ships no breakpoint fork (theme owns every breakpoint)");
});

test("mobile CSS contract: 360px rules avoid known reachability blockers", () => {
  // The themed job card comes from the vendored renderView mount, styled by
  // the canonical theme; the static shell only adds the scan tab list.
  const css = read("packages/shared-ui/src/styles/theme.css");
  const html = read("apps/extension/src/modal/modal.html");
  assert.match(html, /name="viewport"[^>]*width=device-width[^>]*initial-scale=1/, "viewport stays device-width");

  // No fixed-width layout container wider than a 360px phone.
  for (const m of css.matchAll(/(?:^|[{};])\s*(?:min-width|width)\s*:\s*([0-9.]+)px/gi)) {
    assert.ok(Number(m[1]) <= 360, `no fixed layout width above 360px (saw ${m[1]}px)`);
  }
  // The tactile primary action goes full-width on phones instead of
  // keeping its 200px desktop minimum.
  assert.match(
    css,
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.dz-btn-tactile\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/,
    "primary action stretches full-width at phone sizes",
  );
  // Stacked action rows and job controls at 560px and below.
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.dz-actions-row\s*\{[^}]*flex-direction:\s*column;/,
    "action rows stack at 560px",
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.dz-progress-controls\s*\{[^}]*flex-direction:\s*column;/,
    "progress controls stack at 560px",
  );
  // Narrowest phones stack the job actions vertically.
  assert.match(
    css,
    /@media\s*\(max-width:\s*380px\)[\s\S]*?\.dz-job-actions\s*\{[^}]*flex-direction:\s*column;/,
    "job actions stack at 380px",
  );
  // The card clips instead of scrolling sideways, and the fluid main
  // column stays within the viewport at every breakpoint.
  assert.match(css, /\.dz-card\s*\{[^}]*overflow:\s*hidden;/, "card never scrolls sideways");
  assert.match(css, /\.dz-main\s*\{[^}]*width:\s*min\(9[24]%,\s*960px\);/, "main column stays fluid");
  // Page-owned chrome stays limited to the close control; interactive job
  // actions are rendered by the shared UI and covered by the rules above.
  assert.match(html, /id="dz-modal-dismiss"/, "close control stays mounted");
});
