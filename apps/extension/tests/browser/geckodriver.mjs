import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GECKODRIVER_VERSION = "0.37.1";
const cacheDir = process.env.GECKODRIVER_CACHE_DIR || tmpdir();
export const GECKODRIVER = path.resolve(
  cacheDir,
  `geckodriver-${GECKODRIVER_VERSION}${process.platform === "win32" ? ".exe" : ""}`,
);

// Setup owns downloads. Importing this module in deterministic tests is offline.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { download } = await import("geckodriver");
  const installed = await download(GECKODRIVER_VERSION, cacheDir);
  if (installed !== GECKODRIVER) throw new Error(`Unexpected geckodriver path: ${installed}`);
  console.log(`geckodriver ${GECKODRIVER_VERSION}: ${installed}`);
}
