import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file }) {
  const url = new URL(request.url);
  if (url.hostname !== "fixtures.test") return null;
  const tile = url.pathname.match(/^\/edge\/range-truncate\/pyramid_files\/9\/([01])_([01])\.png$/);
  if (!tile || (tile[1] === "1" && tile[2] === "1")) return null;
  const partial = tile[1] === "0" && tile[2] === "1";
  return fileResponse(file, {
    status: partial ? 206 : 200,
    headers: {
      "Accept-Ranges": "bytes",
      ...(partial ? { "Content-Range": "bytes 0-99/569" } : {}),
    },
  });
}
