import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file }) {
  const url = new URL(request.url);
  if (url.hostname !== "fixtures.test") return null;
  if (url.pathname === "/edge/cache-304/pyramid.dzi")
    return fileResponse(file, { headers: { ETag: "edge-meta-v1" } });
  const tile = url.pathname.match(/^\/edge\/cache-304\/pyramid_files\/9\/([01])_([01])\.png$/);
  if (!tile) return null;
  const headers = { ETag: `t${tile[1]}${tile[2]}` };
  return tile[1] === "1" && tile[2] === "1"
    ? new Response(null, { status: 304, headers })
    : fileResponse(file, { headers });
}
