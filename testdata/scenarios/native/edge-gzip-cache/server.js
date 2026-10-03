import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file }) {
  const url = new URL(request.url);
  if (url.hostname !== "fixtures.test") return null;
  if (url.pathname === "/edge/gzip-cache/pyramid.dzi")
    return fileResponse(file, {
      headers: {
        "Content-Encoding": "gzip",
        ETag: "edge-gzip-v1",
        "Cache-Control": "max-age=60",
      },
    });
  const tile = url.pathname.match(/^\/edge\/gzip-cache\/pyramid_files\/9\/([01])_([01])\.png$/);
  return tile
    ? fileResponse(file, {
        headers: {
          ETag: `edge-tile-${tile[1]}${tile[2]}`,
          "Cache-Control": "max-age=60",
        },
      })
    : null;
}
