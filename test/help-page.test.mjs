import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { presentFailure } from "../packages/shared-ui/src/presentation.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { act } from "./react-dom.mjs";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(webDir, "docs", "user");
const helpDir = path.join(webDir, "help");
const PAGES = readdirSync(srcDir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => f.replace(/\.md$/, ""));

test("every generated page exists with chrome, topics, and no legacy doc links", () => {
  for (const stem of PAGES) {
    const html = readFileSync(path.join(helpDir, `${stem}.html`), "utf8");
    // Structure checks use tag names and links only: renaming CSS classes
    // or other implementation details must not break them.
    assert.ok(html.includes("<header"), `${stem}.html has site chrome`);
    assert.ok(html.includes("<nav"), `${stem}.html has site navigation`);
    for (const topic of PAGES) {
      assert.ok(html.includes(`href="${topic}.html"`), `${stem}.html lists the ${topic} topic`);
    }
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
        !target.startsWith(`${webDir + path.sep}docs`),
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

// Pins the documented input contract of scripts/build-help.mjs: each
// docs/user page starts with a `# <stem>` marker line (dropped from the
// generated page) followed by the `# ...` heading that becomes the page
// title. The generator is the authority; this is the source-side tripwire
// for that documented format.
test("docs/user pages carry their stem marker", () => {
  for (const stem of PAGES) {
    const md = readFileSync(path.join(srcDir, `${stem}.md`), "utf8");
    assert.match(md, new RegExp(`^# ${stem}\\n`), `${stem}.md starts with its marker line`);
  }
});

test("app pages link the in-app docs instead of legacy doc sites", () => {
  for (const page of ["index.html", "privacy.html", "terms.html"]) {
    const html = readFileSync(path.join(webDir, page), "utf8");
    assert.ok(html.includes("./help/"), `${page} links ./help/`);
    assert.ok(
      !html.includes("github.com/lovasoa/dezoomify/wiki"),
      `${page} must not link the legacy wiki`,
    );
  }
});

test("failure guidance links the in-app image-address guide", () => {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  act(() =>
    renderView(
      el,
      presentFailure({
        code: "job.discovery-failed",
        phase: "discovery",
        transport: "direct",
        retryable: false,
        message: "No zoomable image could be found.",
      }),
      { onSubmitUrl: () => {}, onCancel: () => {}, onReset: () => {}, onSave: () => {} },
    ),
  );
  assert.ok(
    el.querySelector('a[href="./help/finding-the-image-address.html"]'),
    "failures point at the in-app image-address guide",
  );
});
