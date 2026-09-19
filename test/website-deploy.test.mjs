import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(new URL("../.github/workflows/website-deploy.yml", import.meta.url), "utf8");
const builder = fs.readFileSync(new URL("../scripts/build-site.mjs", import.meta.url), "utf8");

test("website deployment exposes stable same-repository PR previews", () => {
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /pull_request:\n\s+branches: \[master\]\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(
    workflow,
    /SITE_HOST: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}\.dezoomify\.pages\.dev', github\.event\.pull_request\.number\)/,
  );
  assert.match(workflow, /name: \$\{\{ github\.event_name == 'pull_request' && 'preview' \|\| 'production' \}\}/);
});

test("website deployment builds through the single site builder", () => {
  assert.match(workflow, /node scripts\/build-site\.mjs/);
  assert.match(builder, /const BETA = "beta"/);
});

test("legacy site stays at /, the new app stays at /beta", () => {
  // The builder copies the vendored legacy tree byte-identical to the dist
  // root and emits the Vite app under dist/beta.
  assert.match(builder, /copyLegacy\(\)/);
  assert.match(builder, /copyTree\("help", path\.join\(BETA, "help"\)\)/);
  // The live verify probes the legacy markers at / and the app markers at
  // /beta/; both must stay bound.
  assert.match(workflow, /env\.SITE_HOST \}\}\/"/);
  assert.match(workflow, /env\.SITE_HOST \}\}\/beta\/"/);
  assert.match(workflow, /zoommanager\.js/);
});

test("both proxy routes stay bound and verified", () => {
  assert.match(builder, /"\/api\/proxy"/);
  assert.match(builder, /"\/proxy"/);
  assert.match(workflow, /env\.SITE_HOST \}\}\/api\/proxy/);
  assert.match(workflow, /env\.SITE_HOST \}\}\/proxy"/);
});
