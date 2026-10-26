// The workflow serializes all refs and publishes only changed commits.
// Published dates are immutable; retry failed jobs to resume a partial release.
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { githubApi } from "./store-release.mjs";

async function findRelease(api, path) {
  try {
    return await api(path);
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

export async function shouldRelease(api, version, commit) {
  const release = await findRelease(api, `releases/tags/${encodeURIComponent(version)}`);
  if (release?.draft || release?.prerelease)
    throw new Error(`Release ${version} is not published; reconcile it before retrying`);
  if (release) return false;
  // A build frozen yesterday can finish after midnight. Do not publish a
  // second release on the actual publication day.
  const latest = await findRelease(api, "releases/latest");
  const [year, month, day] = version.split(".").map(Number);
  const date = new Date(Date.UTC(2000 + year, month - 1, day)).toISOString().slice(0, 10);
  if (latest && (latest.target_commitish === commit || latest.published_at?.startsWith(date)))
    return false;
  return true;
}

async function main() {
  const {
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: token,
    DEZOOMIFY_VERSION: version,
    GITHUB_SHA: commit,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!repository || !token || !version || !commit || !output)
    throw new Error("Missing release workflow environment");
  const build = await shouldRelease(githubApi({ repository, token }), version, commit);
  await appendFile(output, `version=${version}\nbuild=${build}\n`);
  console.log(build ? `Build ${version}` : "No new release needed; stopping");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
