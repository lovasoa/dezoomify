// Synthetic transient failures reuse the shared four-tile PNG image.
import { fileResponse } from "../../../test/fixture-files.mjs";

const attempts = new Map();
const source = "../../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli/";

export function serve(request) {
  const url = new URL(request.url);
  if (url.pathname === "/fixtures/failures/retry-approval/retry.dzi") {
    attempts.clear();
    return fileResponse(new URL(`${source}pyramid.dzi`, import.meta.url));
  }
  const tile = url.pathname.match(
    /^\/fixtures\/failures\/retry-approval\/retry_files\/9\/([01])_([01])\.png$/,
  );
  if (!tile) return null;
  const count = (attempts.get(url.pathname) ?? 0) + 1;
  attempts.set(url.pathname, count);
  if (tile[2] === "1" && count <= 4) return new Response("temporary tile failure", { status: 503 });
  return fileResponse(new URL(`${source}tile-${tile[1]}_${tile[2]}.png`, import.meta.url));
}
