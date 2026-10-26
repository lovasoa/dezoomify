import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { shouldRelease } from "../scripts/daily-release.mjs";
import {
  downloadAsset,
  freezeRelease,
  githubApi,
  storeSubmitter,
  submitRelease,
} from "../scripts/store-release.mjs";

// One ZIP containing manifest.json with the calendar version, used by both stores.
const zip = Buffer.from(
  "UEsDBBQAAAAAAAAAWl3q1sdJFgAAABYAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbiI6IjI2LjEwLjI2In1QSwECFAMUAAAAAAAAAFpd6tbHSRYAAAAWAAAADQAAAAAAAAAAAAAAgAEAAAAAbWFuaWZlc3QuanNvblBLBQYAAAAAAQABADsAAABBAAAAAAA=",
  "base64",
);
const version = "26.10.26";
const commit = "a".repeat(40);
const digest = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
const env = Object.fromEntries(
  [
    "CHROME_WS_PUBLISHER_ID",
    "EXTENSION_ID",
    "CHROME_WS_CLIENT_ID",
    "CHROME_WS_CLIENT_SECRET",
    "CHROME_WS_REFRESH_TOKEN",
    "AMO_GUID",
    "AMO_JWT_ISSUER",
    "AMO_JWT_SECRET",
  ].map((key) => [key, "fixture"]),
);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function ledgerResponse(s, path, body) {
  if (path.endsWith("/deployments")) {
    if (!body) return json(s.records);
    const record = { ...body, id: s.records.length + 1, sha: body.ref, statuses: [] };
    s.records.unshift(record);
    return json(record, 201);
  }
  const id = Number(/deployments\/(\d+)/.exec(path)?.[1]);
  const record = s.records.find((entry) => entry.id === id);
  if (!body) return json(record.statuses);
  if (
    (body.state === "success" && s.fault === "ledger") ||
    (body.state === "error" && s.denyOutcome)
  )
    return json({ error: "write denied" }, 403);
  record.statuses.unshift(body);
  return json(body, 201);
}

function chromeStatus(s) {
  if (!s.published) return json({ lastAsyncUploadState: "SUCCEEDED" });
  if (s.fault === "confirmation") return json({ error: "read denied" }, 403);
  return json({
    submittedItemRevisionStatus: {
      state: "PENDING_REVIEW",
      distributionChannels: [{ crxVersion: version }],
    },
  });
}

async function storeResponse(s, url, body) {
  const crxVersion = s.fault === "version" ? "26.10.25" : undefined;
  if (url.includes("oauth2.googleapis.com")) return json({ access_token: "fixture" });
  if (url.includes("/upload/upload/")) return json({ processed: true, valid: true, version });
  if (url.includes(":upload") || url.endsWith("/upload/")) {
    s.uploads++;
    s.published = false;
    s.recordedBeforeUpload = s.records[0]?.statuses[0]?.state;
    s.uploaded =
      s.browser === "firefox" ? Buffer.from(await body.get("upload").arrayBuffer()) : body;
    s.afterUpload?.();
    return json(
      s.browser === "firefox"
        ? { uuid: "upload" }
        : {
            itemId: "fixture",
            uploadState: "IN_PROGRESS",
            crxVersion,
          },
    );
  }
  if (url.includes(":fetchStatus")) return chromeStatus(s);
  if (!/:publish$|\/versions\/$/.test(url)) throw new Error(`Unexpected store URL: ${url}`);
  if (s.fault === "rejection") return json({ error: "rejected" }, 400);
  s.publications++;
  s.published = true;
  if (s.fault === "network") throw new Error("response lost after acceptance");
  return json({ id: 1, version: s.fault === "version" ? "26.10.25" : version });
}

async function scenario(browser = "chromium") {
  const s = {
    browser,
    records: [],
    fault: "",
    uploads: 0,
    publications: 0,
  };
  const fixtures = {
    [`/repos/owner/repo/releases/tags/${version}`]: {
      tag_name: version,
      assets: ["chromium", "firefox"].map((name, id) => ({
        id,
        name: `dezoomify-${name}-v${version}.zip`,
        digest,
      })),
    },
    [`/repos/owner/repo/git/ref/tags/${version}`]: {
      object: { type: "tag", sha: "annotated" },
    },
    "/repos/owner/repo/git/tags/annotated": { object: { type: "commit", sha: commit } },
  };
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    if (fixtures[path]) return json(fixtures[path]);
    if (url.startsWith("https://api.github.com/")) {
      if (path.includes("/releases/assets/")) {
        s.afterDownload?.();
        return new Response(s.fault === "digest" ? "changed bytes" : zip);
      }
      return ledgerResponse(s, path, body);
    }
    return storeResponse(s, url, body);
  };
  const github = { repository: "owner/repo", token: "fixture", fetcher };
  const api = githubApi(github);
  s.plan = await freezeRelease(api, version);
  s.run = () =>
    submitRelease({
      api,
      browser,
      plan: s.plan,
      download: (asset) => downloadAsset(github, asset),
      submit: storeSubmitter({ env, fetcher, sleep: async () => {} }),
    });
  return s;
}

test("both stores reuse the daily ZIP and reruns skip accepted versions, even from another commit", async () => {
  for (const browser of ["chromium", "firefox"]) {
    const s = await scenario(browser);
    assert.equal(await s.run(), "submitted");
    assert.deepEqual(s.uploaded, zip);
    assert.equal(s.recordedBeforeUpload, "in_progress");
    assert.equal(s.records[0].statuses[0].state, "success");
    assert.equal(await s.run(), "already submitted");
    s.plan.commit = "b".repeat(40);
    assert.equal(await s.run(), "already submitted");
    assert.equal(s.uploads, 1);
  }
});

test("a definite rejection can retry the same immutable release", async () => {
  const s = await scenario();
  s.fault = "rejection";
  await assert.rejects(s.run(), /HTTP 400/);
  assert.equal(s.records[0].statuses[0].state, "failure");
  s.fault = "";
  assert.equal(await s.run(), "submitted");
});

test("uncertain acceptance blocks retries until the deployment ledger is reconciled", async (t) => {
  const s = await scenario("firefox");
  s.fault = "network";
  s.denyOutcome = true;
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(s.run(), /response lost/);
  assert.match(log.mock.calls[0].arguments[0], /Recording store outcome failed:.*write denied/);
  assert.equal(s.records[0].statuses[0].state, "in_progress");
  await assert.rejects(s.run(), /reconcile/);
  s.fault = "";
  s.denyOutcome = false;
  await assert.rejects(s.run(), /reconcile/);
  s.records[0].statuses.unshift({ state: "success" });
  assert.equal(await s.run(), "already submitted");
});

test("confirmation or ledger write failures never turn accepted submissions into retryable failures", async () => {
  for (const fault of ["confirmation", "ledger"]) {
    const s = await scenario();
    s.fault = fault;
    await assert.rejects(s.run(), /HTTP 403/);
    assert.equal(s.publications, 1);
    assert.equal(s.records[0].statuses[0].state, fault === "ledger" ? "in_progress" : "error");
    await assert.rejects(s.run(), /reconcile/);
  }
});

test("tampered ZIPs and mismatched manifest versions fail before contacting a store", async () => {
  const s = await scenario();
  s.fault = "digest";
  await assert.rejects(s.run(), /digest changed/);
  s.fault = "";
  s.plan.version = "26.10.27";
  await assert.rejects(s.run(), /manifest version differs/);
  assert.equal(s.uploads, 0);
  assert.equal(s.records.length, 0);
});

test("published dates stop early; drafts and failed lookups never authorize a rebuild", async () => {
  const api = githubApi({
    repository: "owner/repo",
    token: "fixture",
    fetcher: async () => json({}, 404),
  });
  assert.equal(await shouldRelease(api, version, commit), true);
  assert.equal(await shouldRelease(async () => ({ draft: false }), version, commit), false);
  await assert.rejects(
    shouldRelease(async () => ({ draft: true }), version, commit),
    /reconcile/,
  );
  const forbidden = githubApi({
    repository: "owner/repo",
    token: "fixture",
    fetcher: async () => json({}, 403),
  });
  await assert.rejects(shouldRelease(forbidden, version, commit), /HTTP 403/);
});

test("a release that finished after midnight prevents a second publication that day", async () => {
  const api = githubApi({
    repository: "owner/repo",
    token: "fixture",
    fetcher: async (url) =>
      url.endsWith("/releases/latest")
        ? json({ tag_name: "26.10.25", published_at: "2026-10-26T00:02:00Z" })
        : json({}, 404),
  });
  assert.equal(await shouldRelease(api, version, commit), false);
});

test("unchanged days do nothing; the next changed commit can be released", async () => {
  const api = githubApi({
    repository: "owner/repo",
    token: "fixture",
    fetcher: async (url) =>
      url.endsWith("/releases/latest")
        ? json({
            tag_name: "26.10.25",
            target_commitish: commit,
            published_at: "2026-10-25T03:00:00Z",
          })
        : json({}, 404),
  });
  for (const date of ["26.10.26", "26.10.27", "26.10.28"]) {
    assert.equal(await shouldRelease(api, date, commit), false);
  }
  assert.equal(await shouldRelease(api, "26.10.29", "b".repeat(40)), true);
});

test("neither store records acceptance of another version", async () => {
  for (const browser of ["chromium", "firefox"]) {
    const s = await scenario(browser);
    s.fault = "version";
    await assert.rejects(s.run(), /Unconfirmed Chrome upload|did not confirm submitted version/);
    assert.equal(s.records[0].statuses[0].state, "error");
  }
});
