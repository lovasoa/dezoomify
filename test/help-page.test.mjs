import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(webDir, "docs", "user");
const helpDir = path.join(webDir, "help");
const PAGES = readdirSync(srcDir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => f.replace(/\.md$/, ""));

test("help/ is generated from docs/user and up to date", () => {
  const before = mkdtempSync(path.join(os.tmpdir(), "help-before-"));
  const after = mkdtempSync(path.join(os.tmpdir(), "help-after-"));
  cpSync(helpDir, before, { recursive: true });
  try {
    execFileSync(process.execPath, [path.join(webDir, "scripts", "build-help.mjs")], {
      cwd: webDir,
    });
    cpSync(helpDir, after, { recursive: true });
    const namesBefore = readdirSync(before).sort();
    const namesAfter = readdirSync(after).sort();
    assert.deepEqual(namesAfter, namesBefore, "generated file set changed");
    for (const name of namesAfter) {
      assert.equal(
        readFileSync(path.join(after, name), "utf8"),
        readFileSync(path.join(before, name), "utf8"),
        `${name} is stale; run: node scripts/build-help.mjs`,
      );
    }
  } finally {
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
});

test("every generated page exists with chrome, topics, and no legacy doc links", () => {
  for (const stem of PAGES) {
    const html = readFileSync(path.join(helpDir, `${stem}.html`), "utf8");
    assert.ok(html.includes('class="dz-nav"'), `${stem}.html has site chrome`);
    assert.ok(html.includes('class="dz-help-topics"'), `${stem}.html lists topics`);
    const h1s = [...html.matchAll(/<h1 id="[^"]*">/g)].length;
    assert.equal(h1s, 1, `${stem}.html has exactly one h1 (marker line dropped)`);
    for (const legacy of [
      "github.com/lovasoa/dezoomify/wiki",
      "dezoomify-rs.ophir.dev",
      "lovasoa.github.io",
      "ophir.alwaysdata.net",
    ]) {
      assert.ok(!html.includes(legacy), `${stem}.html must not link legacy doc site ${legacy}`);
    }
  }
  assert.ok(readFileSync(path.join(helpDir, "index.html"), "utf8").includes("start-here.html"));
});

test("all help links resolve within the generated site", () => {
  for (const file of readdirSync(helpDir)) {
    const html = readFileSync(path.join(helpDir, file), "utf8");
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [rel, anchor] = href.split("#");
      const target = path.resolve(helpDir, rel);
      assert.ok(
        !target.startsWith(webDir + path.sep + "docs"),
        `${file} must not link into docs/ source`,
      );
      assert.ok(
        target.startsWith(webDir) && (rel === "" || exists(target)),
        `${file} links unresolvable ${href}`,
      );
      if (anchor && target.endsWith(".html")) {
        const targetHtml = readFileSync(target, "utf8");
        assert.ok(
          targetHtml.includes(`id="${anchor}"`),
          `${file} anchors to missing id "${anchor}"`,
        );
      }
    }
  }
});

function exists(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

test("docs/user pages carry their stem marker and unique title", () => {
  const seen = new Set();
  for (const stem of PAGES) {
    const md = readFileSync(path.join(srcDir, `${stem}.md`), "utf8");
    assert.match(md, new RegExp(`^# ${stem}\\n`), `${stem}.md starts with its marker line`);
    const title = md.match(/^# (.+)$/m)[1];
    assert.ok(!seen.has(title), `duplicate doc title: ${title}`);
    seen.add(title);
  }
});
