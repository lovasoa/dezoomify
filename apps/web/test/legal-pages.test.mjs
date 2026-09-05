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
