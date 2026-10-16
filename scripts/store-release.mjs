// Store submissions consume a frozen GitHub release, never a fresh build.
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export class Rejected extends Error {}

export async function request(fetcher, url, options = {}) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(300_000), ...options });
  const body = await response.text();
  if (!response.ok) {
    const definiteRejection =
      response.status >= 400 && response.status < 500 && ["POST", "PUT"].includes(options.method);
    const ErrorType = definiteRejection ? Rejected : Error;
    throw new ErrorType(
      `${options.method || "GET"} ${url}: HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return JSON.parse(body);
}

export function githubApi({ repository, token, fetcher = fetch }) {
  return (path, method = "GET", body) =>
    request(fetcher, `https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

export async function freezeRelease(api, tag) {
  const release = await api(tag ? `releases/tags/${encodeURIComponent(tag)}` : "releases/latest");
  if (release.draft || release.prerelease)
    throw new Error("Store releases must be published releases");
  const version = /^(?:rolling-)?v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
  if (!version) throw new Error(`Invalid release tag: ${release.tag_name}`);
  let { object } = await api(`git/ref/tags/${encodeURIComponent(release.tag_name)}`);
  for (let depth = 0; object.type === "tag" && depth < 10; depth++) {
    ({ object } = await api(`git/tags/${object.sha}`));
  }
  if (object.type !== "commit") throw new Error("Release tag does not resolve to a commit");
  const assets = {};
  for (const browser of ["chromium", "firefox"]) {
    const asset = release.assets.find(
      (entry) => entry.name === `dezoomify-${browser}-v${version}.zip`,
    );
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      throw new Error(`Release lacks a checksummed ${browser} ZIP`);
    }
    assets[browser] = { id: asset.id, name: asset.name, digest: asset.digest };
  }
  return { tag: release.tag_name, commit: object.sha, version, assets };
}

function nightly(now, date) {
  return now.getUTCHours() < 6 && (!date || now.toISOString().slice(0, 10) === date);
}

export async function verifyPackage(bytes, version) {
  const directory = await mkdtemp(join(tmpdir(), "dezoomify-store-"));
  try {
    const zip = join(directory, "extension.zip");
    await writeFile(zip, bytes);
    const { stdout } = await promisify(execFile)("unzip", ["-p", zip, "manifest.json"], {
      maxBuffer: 1024 * 1024,
    });
    if (JSON.parse(stdout).version !== version)
      throw new Error("Release ZIP manifest version differs from frozen release");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function automaticSkip(records, commit, now, date) {
  if (!nightly(now)) return "outside nightly window";
  if (records.some((record) => !["success", "failure"].includes(record.state))) {
    throw new Error(
      "Unresolved store attempt: reconcile its deployment status before automatic submission",
    );
  }
  if (records.find((record) => record.state === "success")?.sha === commit)
    return "unchanged released commit";
  if (records.some((record) => record.payload.attempt_date === date))
    return "already attempted today";
  return undefined;
}

export async function submissionState(api, browser) {
  const records = [];
  for (let page = 1; ; page++) {
    const batch = await api(`deployments?environment=store-${browser}&per_page=100&page=${page}`);
    for (const deployment of batch) {
      if (deployment.task !== "store-submit" || deployment.payload?.schema !== 1) continue;
      const statuses = await api(`deployments/${deployment.id}/statuses?per_page=1`);
      records.push({ ...deployment, state: statuses[0]?.state });
      // A confirmed submission establishes the baseline and reconciles older
      // attempts. Bound API work to attempts since that checkpoint.
      if (statuses[0]?.state === "success") return records;
    }
    if (batch.length < 100) return records;
  }
}

export async function submitRelease({
  api,
  browser,
  plan,
  automatic,
  download,
  submit,
  verify = verifyPackage,
  now = () => new Date(),
}) {
  if (!["chromium", "firefox"].includes(browser)) throw new Error("Unknown browser");
  const records = await submissionState(api, browser);
  const date = now().toISOString().slice(0, 10);
  if (automatic) {
    const skip = automaticSkip(records, plan.commit, now(), date);
    if (skip) return skip;
  }
  const bytes = await download(plan.assets[browser]);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== plan.assets[browser].digest) throw new Error("Release ZIP digest changed");
  await verify(bytes, plan.version);
  if (automatic && !nightly(now(), date)) return "outside nightly window";
  const deployment = await api("deployments", "POST", {
    ref: plan.commit,
    environment: `store-${browser}`,
    task: "store-submit",
    auto_merge: false,
    required_contexts: [],
    production_environment: false,
    payload: {
      schema: 1,
      browser,
      release_tag: plan.tag,
      version: plan.version,
      attempt_date: date,
      automatic,
      asset_id: plan.assets[browser].id,
      asset_digest: digest,
    },
    description: `Submit ${plan.tag} to ${browser}`,
  });
  const status = (state, description) =>
    api(`deployments/${deployment.id}/statuses`, "POST", {
      state,
      description,
      auto_inactive: false,
    });
  await status("in_progress", "Attempt recorded before contacting store");
  let started = false;
  const beforeMutation = () => {
    if (automatic && !nightly(now(), date))
      throw new Rejected("Nightly window expired before store mutation");
    started = true;
  };
  try {
    await submit({ browser, version: plan.version, bytes, beforeMutation });
  } catch (error) {
    const ambiguous = started && !(error instanceof Rejected);
    await status(
      ambiguous ? "error" : "failure",
      ambiguous
        ? "Acceptance uncertain: reconcile with store before retrying"
        : "Store submission failed; see workflow log",
    );
    throw error;
  }
  // If this write fails, leave the attempt unresolved. The store has already
  // accepted it, so recording a retryable failure would permit a duplicate.
  await status("success", `Store accepted version ${plan.version}; approval may still be pending`);
  return "submitted";
}

function required(env, key) {
  if (!env[key]) throw new Rejected(`Missing ${key}`);
  return env[key];
}

async function chromium({ version, bytes, beforeMutation }, { env, fetcher, sleep }) {
  const publisher = required(env, "CHROME_WS_PUBLISHER_ID");
  const item = required(env, "EXTENSION_ID");
  const token = await request(fetcher, "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: required(env, "CHROME_WS_CLIENT_ID"),
      client_secret: required(env, "CHROME_WS_CLIENT_SECRET"),
      refresh_token: required(env, "CHROME_WS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!token.access_token) throw new Rejected("OAuth response lacks access token");
  const name = `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;
  const base = `https://chromewebstore.googleapis.com/v2/${name}`;
  const headers = { Authorization: `Bearer ${token.access_token}` };
  beforeMutation();
  const upload = await request(
    fetcher,
    `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: bytes,
    },
  );
  if (upload.itemId !== item || (upload.crxVersion && upload.crxVersion !== version)) {
    throw new Error(
      `Unconfirmed Chrome upload for ${version}: ${JSON.stringify(upload).slice(0, 500)}`,
    );
  }
  await waitForChromeUpload(upload, { base, headers, fetcher, sleep });
  beforeMutation();
  await request(fetcher, `${base}:publish`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
      deployInfos: [{ deployPercentage: 100 }],
    }),
  });
  for (let attempt = 0; attempt < 12; attempt++) {
    const status = await request(fetcher, `${base}:fetchStatus`, { headers });
    const revisions = [status.submittedItemRevisionStatus, status.publishedItemRevisionStatus];
    if (
      revisions.some(
        (revision) =>
          ["PENDING_REVIEW", "STAGED", "PUBLISHED"].includes(revision?.state) &&
          revision.distributionChannels?.some((channel) => channel.crxVersion === version),
      )
    )
      return;
    await sleep(5000);
  }
  throw new Error(`Chrome did not confirm submitted version ${version}`);
}

async function waitForChromeUpload(upload, { base, headers, fetcher, sleep }) {
  let state = upload.uploadState;
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < 60; attempt++) {
    await sleep(5000);
    const status = await request(fetcher, `${base}:fetchStatus`, { headers });
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Unconfirmed Chrome upload state: ${state}`);
  // fetchStatus omits draft versions. The SHA-256 and ZIP manifest were
  // verified before upload; the submitted revision is checked after publish.
}

function amoToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: required(env, "AMO_JWT_ISSUER"), jti: randomUUID(), iat: now, exp: now + 300 })}`;
  return `${data}.${createHmac("sha256", required(env, "AMO_JWT_SECRET")).update(data).digest("base64url")}`;
}

async function firefox({ version, bytes, beforeMutation }, { env, fetcher, sleep }) {
  const base = "https://addons.mozilla.org/api/v5/addons/";
  const addon = encodeURIComponent(required(env, "AMO_GUID"));
  const auth = () => ({ Authorization: `JWT ${amoToken(env)}` });
  const body = new FormData();
  body.set("upload", new Blob([bytes], { type: "application/zip" }), "extension.zip");
  body.set("channel", "listed");
  beforeMutation();
  const upload = await request(fetcher, `${base}upload/`, {
    method: "POST",
    headers: auth(),
    body,
  });
  if (!upload.uuid) throw new Error("AMO upload response lacks uuid");
  const uploadUrl = `${base}upload/${encodeURIComponent(upload.uuid)}/`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const detail = await request(fetcher, uploadUrl, { headers: auth() });
    if (!detail.processed) {
      await sleep(5000);
      continue;
    }
    if (!detail.valid || detail.version !== version)
      throw new Rejected(`AMO did not validate intended version ${version}`);
    beforeMutation();
    const result = await request(fetcher, `${base}addon/${addon}/versions/`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ upload: upload.uuid }),
    });
    if (result.version !== version || !result.id)
      throw new Error(`AMO did not confirm submitted version ${version}`);
    return;
  }
  throw new Error("AMO validation timed out");
}

export function storeSubmitter({
  env = process.env,
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return (input) =>
    (input.browser === "chromium" ? chromium : firefox)(input, { env, fetcher, sleep });
}

async function main() {
  const env = process.env;
  const api = githubApi({
    repository: required(env, "GITHUB_REPOSITORY"),
    token: required(env, "GH_TOKEN"),
  });
  if (process.argv[2] === "freeze") {
    const plan = await freezeRelease(api, env.RELEASE_TAG || undefined);
    await appendFile(required(env, "GITHUB_OUTPUT"), `plan=${JSON.stringify(plan)}\n`);
    console.log(`Frozen ${plan.tag} at ${plan.commit}`);
    return;
  }
  if (process.argv[2] !== "submit") throw new Error("Expected freeze or submit command");
  const config = await readFile("release/config.toml", "utf8");
  env.EXTENSION_ID = /\[extension.chromium\][\s\S]*?\nid = "([^"]+)"/.exec(config)?.[1];
  env.AMO_GUID = /\[extension.firefox\][\s\S]*?\nid = "([^"]+)"/.exec(config)?.[1];
  const download = async (asset) => {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,
      {
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) throw new Error(`Release asset ${asset.id}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  console.log(
    await submitRelease({
      api,
      browser: env.BROWSER,
      plan: JSON.parse(required(env, "RELEASE_PLAN")),
      automatic: env.AUTOMATIC === "true",
      download,
      submit: storeSubmitter(),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
