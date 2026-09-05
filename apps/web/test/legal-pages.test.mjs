import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("privacy and terms pages exist and are linked", () => {
  for (const page of ["privacy.html", "terms.html"]) {
    assert.ok(existsSync(path.join(webDir, page)), `${page} exists`);
  }
  const index = readFileSync(path.join(webDir, "index.html"), "utf8");
  assert.ok(index.includes("./privacy.html"), "index links privacy");
  assert.ok(index.includes("./terms.html"), "index links terms");
  for (const page of ["privacy.html", "terms.html"]) {
    const text = readFileSync(path.join(webDir, page), "utf8");
    assert.ok(text.includes("./index.html"), `${page} links back to app`);
    assert.ok(
      text.includes("github.com/lovasoa/dezoomify"),
      `${page} names a contact`,
    );
  }
});

test("header bar has consistent thin structure and styling across pages", () => {
  const themeCssPath = path.resolve(webDir, "../../packages/shared-ui/src/styles/theme.css");
  const themeCss = readFileSync(themeCssPath, "utf8");

  // .dz-nav has thin constant height and cannot shrink
  assert.match(themeCss, /\.dz-nav\s*\{[^}]*height:\s*36px;/);
  assert.match(themeCss, /\.dz-nav\s*\{[^}]*flex-shrink:\s*0;/);

  for (const page of ["index.html", "privacy.html", "terms.html"]) {
    const html = readFileSync(path.join(webDir, page), "utf8");
    assert.ok(html.includes('class="dz-nav"'), `${page} has header.dz-nav`);
    assert.ok(html.includes('class="dz-brand"'), `${page} has brand`);
    assert.ok(html.includes('width="20" height="20"'), `${page} has consistent 20x20 logo`);
  }
});
