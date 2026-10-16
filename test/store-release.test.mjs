import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  freezeRelease,
  Rejected,
  request,
  storeSubmitter,
  submitRelease,
  verifyPackage,
} from "../scripts/store-release.mjs";

const bytes = Buffer.from("immutable release zip");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const plan = {
  tag: "rolling-v3.1.300",
  commit: "a".repeat(40),
  version: "3.1.300",
  assets: { chromium: { id: 11, digest }, firefox: { id: 12, digest } },
};
const morning = () => new Date("2026-10-16T02:30:00Z");

function harness({ records = [], date = morning, submit } = {}) {
  const calls = [];
  let id = 100;
  const api = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.startsWith("deployments?")) return records;
    if (!method && path.endsWith("statuses?per_page=1")) {
      const deployment = records.find((entry) => path.startsWith(`deployments/${entry.id}/`));
      return deployment.state ? [{ state: deployment.state }] : [];
    }
    if (path === "deployments") return { id: id++ };
    return {};
  };
  return {
    api,
    calls,
    run: (override = {}) =>
      submitRelease({
        api,
        plan,
        browser: "chromium",
        automatic: true,
        now: date,
        download: async () => bytes,
        verify: async () => {},
        submit: submit || (async ({ beforeMutation }) => beforeMutation()),
        ...override,
      }),
  };
}

function record(state, overrides = {}) {
  return {
    id: 1,
    task: "store-submit",
    sha: "b".repeat(40),
    state,
    payload: { schema: 1, attempt_date: "2026-10-15" },
    ...overrides,
  };
}

test("first nightly submission records the attempt before store mutation and success", async () => {
  const h = harness({
    submit: async ({ beforeMutation, version, bytes: actual }) => {
      assert.equal(h.calls.at(-1).body.state, "in_progress");
      assert.equal(version, plan.version);
      assert.deepEqual(actual, bytes);
      beforeMutation();
    },
  });
  assert.equal(await h.run(), "submitted");
  const deployment = h.calls.find((entry) => entry.path === "deployments").body;
  assert.equal(deployment.ref, plan.commit);
  assert.equal(deployment.payload.asset_id, 11);
  assert.equal(deployment.payload.attempt_date, "2026-10-16");
  assert.deepEqual(
    h.calls.filter((entry) => entry.body?.state).map((entry) => entry.body.state),
    ["in_progress", "success"],
  );
  assert.equal(h.calls.at(-1).body.auto_inactive, false);
});

test("unchanged commit skips even when the tag was promoted", async () => {
  const h = harness({ records: [record("success", { sha: plan.commit })] });
  assert.equal(await h.run(), "unchanged released commit");
  assert.ok(h.calls.every((entry) => !entry.method));
});

test("a failed or manual attempt today prevents another automatic attempt", async () => {
  for (const state of ["failure", "success"]) {
    const h = harness({
      records: [
        record(state, { payload: { schema: 1, attempt_date: "2026-10-16", automatic: false } }),
      ],
    });
    assert.equal(await h.run(), "already attempted today");
  }
});

test("missed nights submit the newest frozen commit after previous failure", async () => {
  const h = harness({ records: [record("failure"), record("success", { id: 2 })] });
  assert.equal(await h.run(), "submitted");
});

test("unresolved or cancelled attempts since the last success require manual reconciliation", async () => {
  for (const state of ["error", "in_progress", undefined]) {
    const h = harness({ records: [record(state), record("success", { id: 2 })] });
    await assert.rejects(h.run(), /reconcile/);
    assert.ok(h.calls.every((entry) => !entry.method));
  }
});

test("a confirmed manual submission reconciles older uncertainty and bounds ledger reads", async () => {
  const h = harness({
    records: [record("success", { sha: plan.commit }), record("error", { id: 2 })],
  });
  assert.equal(await h.run(), "unchanged released commit");
  assert.equal(h.calls.filter((entry) => entry.path.includes("/statuses")).length, 1);
});

test("failure to record store acceptance leaves the attempt unresolved", async () => {
  const h = harness();
  const api = async (path, method, body) => {
    if (body?.state === "success") throw new Rejected("GitHub refused success status");
    return h.api(path, method, body);
  };
  await assert.rejects(h.run({ api }), /GitHub refused/);
  assert.equal(h.calls.at(-1).body.state, "in_progress");
  assert.ok(h.calls.every((entry) => entry.body?.state !== "failure"));
});

test("outside window and exact 06:00 UTC skip", async () => {
  for (const value of ["2026-10-16T06:00:00Z", "2026-10-16T22:00:00Z"]) {
    const h = harness({ date: () => new Date(value) });
    assert.equal(await h.run(), "outside nightly window");
    assert.ok(h.calls.every((entry) => !entry.method));
  }
});

test("manual submissions bypass window, unchanged commit, and daily limits", async () => {
  const h = harness({
    date: () => new Date("2026-10-16T22:00:00Z"),
    records: [
      record("success", { sha: plan.commit, payload: { schema: 1, attempt_date: "2026-10-16" } }),
    ],
  });
  assert.equal(await h.run({ automatic: false }), "submitted");
  assert.equal(h.calls.find((entry) => entry.path === "deployments").body.payload.automatic, false);
});

test("checks time again after download and before every store mutation", async () => {
  let clock = "2026-10-16T05:59:59Z";
  const h = harness({ date: () => new Date(clock) });
  assert.equal(
    await h.run({
      download: async () => {
        clock = "2026-10-16T06:00:00Z";
        return bytes;
      },
    }),
    "outside nightly window",
  );
  assert.ok(h.calls.every((entry) => !entry.method));
  clock = "2026-10-16T05:59:59Z";
  await assert.rejects(
    h.run({
      submit: async ({ beforeMutation }) => {
        beforeMutation();
        clock = "2026-10-16T06:00:00Z";
        beforeMutation();
      },
    }),
    /window expired/,
  );
  assert.equal(h.calls.at(-1).body.state, "failure");
});

test("network ambiguity blocks future retries while explicit rejection is a failure", async () => {
  for (const [error, state] of [
    [new Error("connection lost"), "error"],
    [new Rejected("bad upload"), "failure"],
  ]) {
    const h = harness({
      submit: async ({ beforeMutation }) => {
        beforeMutation();
        throw error;
      },
    });
    await assert.rejects(h.run(), error);
    assert.equal(h.calls.at(-1).body.state, state);
  }
});

test("changed asset bytes fail before an attempt or store request", async () => {
  const h = harness();
  await assert.rejects(
    h.run({ download: async () => Buffer.from("replacement") }),
    /digest changed/,
  );
  assert.ok(h.calls.every((entry) => !entry.method));
});

test("verifies the version inside the release ZIP before store upload", async () => {
  const archive = Buffer.from(
    "UEsDBBQAAAAAAIlFUF0roFBbFQAAABUAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbiI6IjMuMS4zMDAifVBLAQIUAxQAAAAAAIlFUF0roFBbFQAAABUAAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsFBgAAAAABAAEAOwAAAEAAAAAAAA==",
    "base64",
  );
  await verifyPackage(archive, plan.version);
  await assert.rejects(verifyPackage(archive, "3.1.301"), /manifest version differs/);
});

test("failure to read confirmation after submission is ambiguous even on HTTP 403", async () => {
  const fetcher = async () => new Response('{"error":"forbidden"}', { status: 403 });
  await assert.rejects(
    request(fetcher, "https://store.example/status"),
    (error) => !(error instanceof Rejected),
  );
  await assert.rejects(
    request(fetcher, "https://store.example/submit", { method: "POST" }),
    Rejected,
  );
});

test("deployment ledger reads all pages and skips unrelated environment deployment tasks", async () => {
  let pages = 0;
  const api = async (path) => {
    if (!path.startsWith("deployments?")) return [{ state: "success" }];
    pages++;
    return pages === 1
      ? Array.from({ length: 100 }, () => ({ task: "deploy" }))
      : [record("success", { sha: plan.commit })];
  };
  assert.equal(await harness().run({ api }), "unchanged released commit");
  assert.equal(pages, 2);
});

test("stores fail independently and use distinct deployment environments", async () => {
  const chrome = harness({
    submit: async () => {
      throw new Error("chrome failed");
    },
  });
  const firefox = harness();
  const outcomes = await Promise.allSettled([chrome.run(), firefox.run({ browser: "firefox" })]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(
    firefox.calls.find((entry) => entry.path === "deployments").body.environment,
    "store-firefox",
  );
});

test("freezes latest once, resolves annotated tags, and pins IDs and digests", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path === "releases/latest")
      return {
        tag_name: plan.tag,
        assets: Object.entries(plan.assets).map(([browser, asset]) => ({
          ...asset,
          name: `dezoomify-${browser}-v${plan.version}.zip`,
        })),
      };
    if (path.startsWith("git/ref")) return { object: { type: "tag", sha: "tag-sha" } };
    return { object: { type: "commit", sha: plan.commit } };
  };
  const frozen = await freezeRelease(api);
  assert.equal(frozen.commit, plan.commit);
  assert.equal(frozen.assets.firefox.id, 12);
  assert.equal(paths.filter((path) => path === "releases/latest").length, 1);
});

test("rejects release metadata without digest or a required ZIP", async () => {
  await assert.rejects(
    freezeRelease(async (path) =>
      path.startsWith("releases/")
        ? { tag_name: plan.tag, assets: [] }
        : { object: { type: "commit", sha: plan.commit } },
    ),
    /checksummed/,
  );
});

function mockStore(responses) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      calls.push({ url, ...options });
      const response = responses.shift();
      assert.ok(response, `Unexpected request: ${url}`);
      return new Response(JSON.stringify(response.body ?? response), {
        status: response.http || 200,
      });
    },
  };
}
const chromeEnv = {
  CHROME_WS_PUBLISHER_ID: "publisher",
  EXTENSION_ID: "extension",
  CHROME_WS_CLIENT_ID: "client",
  CHROME_WS_CLIENT_SECRET: "secret",
  CHROME_WS_REFRESH_TOKEN: "refresh",
};
const upload = { uploadState: "SUCCEEDED", crxVersion: plan.version, itemId: "extension" };

test("Chrome v2 confirms uploaded and submitted version", async () => {
  const mock = mockStore([
    { access_token: "access" },
    upload,
    { state: "PENDING_REVIEW" },
    {
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: plan.version }],
      },
    },
  ]);
  let mutations = 0;
  await storeSubmitter({ env: chromeEnv, fetcher: mock.fetcher, sleep: async () => {} })({
    browser: "chromium",
    version: plan.version,
    bytes,
    beforeMutation: () => {
      mutations++;
    },
  });
  assert.equal(mutations, 2);
  assert.match(mock.calls[1].url, /upload\/v2\/publishers\/publisher\/items\/extension:upload$/);
  assert.match(mock.calls[3].url, /:fetchStatus$/);
});

test("Chrome never publishes a mismatched or unknown uploaded version", async () => {
  for (const result of [{ ...upload, crxVersion: "3.1.299" }, { uploadState: "FAILED" }]) {
    const mock = mockStore([{ access_token: "access" }, result]);
    await assert.rejects(
      storeSubmitter({ env: chromeEnv, fetcher: mock.fetcher })({
        browser: "chromium",
        version: plan.version,
        bytes,
        beforeMutation() {},
      }),
      /Unconfirmed/,
    );
    assert.equal(mock.calls.length, 2);
  }
});

test("Chrome polls a normal async upload before publishing", async () => {
  const mock = mockStore([
    { access_token: "access" },
    { uploadState: "IN_PROGRESS", itemId: "extension" },
    { lastAsyncUploadState: "IN_PROGRESS" },
    { lastAsyncUploadState: "SUCCEEDED" },
    { state: "PENDING_REVIEW" },
    {
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: plan.version }],
      },
    },
  ]);
  await storeSubmitter({ env: chromeEnv, fetcher: mock.fetcher, sleep: async () => {} })({
    browser: "chromium",
    version: plan.version,
    bytes,
    beforeMutation() {},
  });
  assert.match(mock.calls[2].url, /:fetchStatus$/);
  assert.match(mock.calls[3].url, /:fetchStatus$/);
  assert.match(mock.calls[4].url, /:publish$/);
});

test("Chrome pending review for a different version is ambiguous", async () => {
  const mock = mockStore([
    { access_token: "access" },
    upload,
    { state: "PENDING_REVIEW" },
    ...Array.from({ length: 12 }, () => ({
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: "3.1.299" }],
      },
    })),
  ]);
  await assert.rejects(
    storeSubmitter({ env: chromeEnv, fetcher: mock.fetcher, sleep: async () => {} })({
      browser: "chromium",
      version: plan.version,
      bytes,
      beforeMutation() {},
    }),
    /did not confirm/,
  );
});

test("Firefox validates and confirms the exact listed version", async () => {
  const mock = mockStore([
    { uuid: "upload-id" },
    { processed: false },
    { processed: true, valid: true, version: plan.version },
    { id: 10, version: plan.version },
  ]);
  let mutations = 0;
  await storeSubmitter({
    env: { AMO_GUID: "{addon}", AMO_JWT_ISSUER: "issuer", AMO_JWT_SECRET: "secret" },
    fetcher: mock.fetcher,
    sleep: async () => {},
  })({
    browser: "firefox",
    version: plan.version,
    bytes,
    beforeMutation: () => {
      mutations++;
    },
  });
  assert.equal(mutations, 2);
  assert.equal(mock.calls[0].body.get("channel"), "listed");
  assert.match(mock.calls.at(-1).url, /addon\/%7Baddon%7D\/versions\/$/);
  assert.deepEqual(JSON.parse(mock.calls.at(-1).body), { upload: "upload-id" });
});

test("workflow keeps manual and automatic mutations under the same per-store lock", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/store-submit.yml", import.meta.url),
    "utf8",
  );
  const nightly = await readFile(
    new URL("../.github/workflows/store-nightly.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /group: store-submit-\$\{\{ inputs.browser \}\}/);
  assert.match(workflow, /deployments: write/);
  assert.match(nightly, /cron: '30 2 \* \* \*'/);
  assert.match(nightly, /release_plan: \$\{\{ needs.freeze.outputs.plan \}\}/);
});
