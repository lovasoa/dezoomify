import { readFile } from "node:fs/promises";
import { fileResponse } from "../../../../test/fixture-files.mjs";

export async function serve(request, { file }) {
  const url = new URL(request.url);
  if (
    !file &&
    ((url.hostname === "127.0.0.1" && url.pathname.startsWith("/iiif/")) ||
      (url.hostname === "iiif.micr.io" && url.pathname.startsWith("/KEimL/")))
  )
    return fileResponse(new URL("./payloads/127.0.0.1/stub.jpg", import.meta.url));
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/fixtures/generic/tile.jpg") return null;
  const params = url.searchParams;
  const available = ["x", "y"].every((name) => {
    const value = params.get(name);
    return /^-?\d+$/.test(value ?? "") && Number(value) >= 0 && Number(value) < 2;
  });
  if (!available)
    return new Response("fixture error", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  return new Response(
    await readFile(new URL("./payloads/127.0.0.1/fixtures/pnav/image.jpg", import.meta.url)),
    {
      headers: { "content-type": "image/jpeg" },
    },
  );
}
