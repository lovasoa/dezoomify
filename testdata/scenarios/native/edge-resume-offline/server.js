import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file }) {
  const url = new URL(request.url);
  return url.hostname === "fixtures.test" && url.pathname === "/edge/resume-offline/pyramid.dzi"
    ? fileResponse(file, { headers: { ETag: "resume-v1" } })
    : null;
}
