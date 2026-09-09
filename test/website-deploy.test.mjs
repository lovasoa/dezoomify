import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(new URL("../.github/workflows/website-deploy.yml", import.meta.url), "utf8");

test("website deployment exposes stable same-repository PR previews", () => {
  assert.match(workflow, /pull_request:\n\s+branches: \[master\]\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(
    workflow,
    /SITE_HOST: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}\.dezoomify\.pages\.dev', github\.event\.pull_request\.number\)/,
  );
  assert.match(
    workflow,
    /DEPLOY_BRANCH: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\)/,
  );
  assert.match(workflow, /--branch "\$DEPLOY_BRANCH"/);
  assert.match(
    workflow,
    /if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(workflow, /name: \$\{\{ github\.event_name == 'pull_request' && 'preview' \|\| 'production' \}\}/);
  assert.match(
    workflow,
    /url: \$\{\{ github\.event_name == 'pull_request' && format\('https:\/\/pr-\{0\}\.dezoomify\.pages\.dev'/,
  );
  assert.doesNotMatch(workflow, /pull_request_target/);
});
