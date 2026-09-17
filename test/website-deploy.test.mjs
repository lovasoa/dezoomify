import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(new URL("../.github/workflows/website-deploy.yml", import.meta.url), "utf8");

test("website deployment exposes stable same-repository PR previews", () => {
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /pull_request:\n\s+branches: \[master\]\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(
    workflow,
    /SITE_HOST: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}\.dezoomify\.pages\.dev', github\.event\.pull_request\.number\)/,
  );
  assert.match(workflow, /name: \$\{\{ github\.event_name == 'pull_request' && 'preview' \|\| 'production' \}\}/);
});
