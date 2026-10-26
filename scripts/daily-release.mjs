// The release workflow serializes all refs. A published date is immutable:
// reruns resume its store submissions, never build another commit under it.
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

export async function prepareRelease(api, version) {
  const release = await findRelease(api, `releases/tags/${encodeURIComponent(version)}`);
  if (release?.draft || release?.prerelease)
    throw new Error(`Release ${version} is not published; reconcile it before retrying`);
  if (release) return { version, build: false };
  // A build frozen yesterday can finish after midnight. Reuse it rather than
  // publishing a second release on the actual publication day.
  const latest = await findRelease(api, "releases/latest");
  const [year, month, day] = version.split(".").map(Number);
  const date = new Date(Date.UTC(2000 + year, month - 1, day)).toISOString().slice(0, 10);
  if (latest?.published_at?.startsWith(date)) return { version: latest.tag_name, build: false };
  return { version, build: true };
}

async function main() {
  const {
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: token,
    DEZOOMIFY_VERSION: version,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!repository || !token || !version || !output)
    throw new Error("Missing release workflow environment");
  const release = await prepareRelease(githubApi({ repository, token }), version);
  await appendFile(output, `version=${release.version}\nbuild=${release.build}\n`);
  console.log(`${release.build ? "Build" : "Reuse published release"} ${release.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
