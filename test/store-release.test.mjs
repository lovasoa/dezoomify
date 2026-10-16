import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  downloadAsset,
  freezeRelease,
  githubApi,
  storeSubmitter,
  submitRelease,
} from "../scripts/store-release.mjs";

// One ZIP containing manifest.json with version 3.1.300, used by both stores.
const zip = Buffer.from(
  "UEsDBBQAAAAAAIlFUF0roFBbFQAAABUAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbiI6IjMuMS4zMDAifVBLAQIUAxQAAAAAAIlFUF0roFBbFQAAABUAAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsFBgAAAAABAAEAOwAAAEAAAAAAAA==",
  "base64",
);
const version = "3.1.300";
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
  const crxVersion = s.fault === "version" ? "3.1.299" : undefined;
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
  return json({ id: 1, version: s.fault === "version" ? "3.1.299" : version });
}

async function scenario(browser = "chromium") {
  const s = {
    browser,
    time: "2026-10-16T02:30:00Z",
    records: [],
    fault: "",
    uploads: 0,
    publications: 0,
  };
  const fixtures = {
    "/repos/owner/repo/releases/latest": {
      tag_name: `rolling-v${version}`,
      assets: ["chromium", "firefox"].map((name, id) => ({
        id,
        name: `dezoomify-${name}-v${version}.zip`,
        digest,
      })),
    },
    [`/repos/owner/repo/git/ref/tags/rolling-v${version}`]: {
      object: { type: "tag", sha: "annotated" },
    },
    "/repos/owner/repo/git/tags/annotated": { object: { type: "commit", sha: "a".repeat(40) } },
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
  s.plan = await freezeRelease(api);
  s.run = (automatic = true) =>
    submitRelease({
      api,
      browser,
      plan: s.plan,
      automatic,
      now: () => new Date(s.time),
      download: (asset) => downloadAsset(github, asset),
      submit: storeSubmitter({ env, fetcher, sleep: async () => {} }),
    });
  return s;
}

test("both stores reuse a frozen ZIP, skip unchanged commits, and submit at most daily", async () => {
  for (const browser of ["chromium", "firefox"]) {
    const s = await scenario(browser);
    assert.equal(await s.run(), "submitted");
    assert.deepEqual(s.uploaded, zip);
    assert.equal(s.recordedBeforeUpload, "in_progress");
    assert.equal(s.records[0].statuses[0].state, "success");
    assert.equal(await s.run(), "unchanged released commit");
    s.plan.commit = "b".repeat(40);
    assert.equal(await s.run(), "already attempted today");
    s.time = "2026-10-18T02:30:00Z";
    assert.equal(await s.run(), "submitted");
    assert.equal(s.uploads, 2);
  }
});

test("late automatic runs skip; manual submissions override the time and daily limits", async () => {
  const s = await scenario();
  s.time = "2026-10-16T06:00:00Z";
  assert.equal(await s.run(), "outside nightly window");
  assert.equal(s.uploads, 0);
  assert.equal(await s.run(false), "submitted");
  assert.equal(await s.run(false), "submitted");
  assert.equal(s.records[0].payload.automatic, false);
});

test("the nightly window is checked after download and again before publishing", async () => {
  const s = await scenario();
  s.afterDownload = () => {
    s.time = "2026-10-16T06:00:00Z";
  };
  assert.equal(await s.run(), "outside nightly window");
  assert.equal(s.records.length, 0);
  s.time = "2026-10-16T05:59:59Z";
  s.afterDownload = undefined;
  s.afterUpload = () => {
    s.time = "2026-10-16T06:00:00Z";
  };
  await assert.rejects(s.run(), /window expired/);
  assert.equal(s.publications, 0);
  assert.equal(s.records[0].statuses[0].state, "failure");
});

test("definite rejection consumes the day; a later night may retry", async () => {
  const s = await scenario();
  s.fault = "rejection";
  await assert.rejects(s.run(), /HTTP 400/);
  assert.equal(s.records[0].statuses[0].state, "failure");
  assert.equal(await s.run(), "already attempted today");
  s.time = "2026-10-17T02:30:00Z";
  s.fault = "";
  assert.equal(await s.run(), "submitted");
});

test("uncertain acceptance blocks retries until a manual submission establishes a baseline", async (t) => {
  const s = await scenario("firefox");
  s.fault = "network";
  s.denyOutcome = true;
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(s.run(), /response lost/);
  assert.match(log.mock.calls[0].arguments[0], /Recording store outcome failed:.*write denied/);
  assert.equal(s.records[0].statuses[0].state, "in_progress");
  s.time = "2026-10-17T02:30:00Z";
  await assert.rejects(s.run(), /reconcile/);
  s.fault = "";
  s.denyOutcome = false;
  assert.equal(await s.run(false), "submitted");
  assert.equal(await s.run(), "unchanged released commit");
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
  s.plan.version = "3.1.301";
  await assert.rejects(s.run(), /manifest version differs/);
  assert.equal(s.uploads, 0);
  assert.equal(s.records.length, 0);
});

test("neither store records acceptance of another version", async () => {
  for (const browser of ["chromium", "firefox"]) {
    const s = await scenario(browser);
    s.fault = "version";
    await assert.rejects(s.run(), /Unconfirmed Chrome upload|did not confirm submitted version/);
    assert.equal(s.records[0].statuses[0].state, "error");
  }
});
