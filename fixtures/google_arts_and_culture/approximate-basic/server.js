import { createHmac } from "node:crypto";
import { tile } from "../../tiles/server.js";

export function serve(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/google_arts_and_culture/approximate-basic/"))
    return new Response(null, { status: 404 });
  if (url.pathname.endsWith(".html")) {
    const base = `${url.host}/fixtures/google_arts_and_culture/approximate-basic/tiles`;
    return new Response(`],"//${base}","sample-token"`, {
      headers: { "content-type": "text/html" },
    });
  }
  if (url.pathname.endsWith("=g"))
    return new Response(
      '<TileInfo tile_width="256" tile_height="256"><pyramid_level num_tiles_x="2" num_tiles_y="2" empty_pels_x="0" empty_pels_y="0" /></TileInfo>',
      { headers: { "content-type": "application/xml" } },
    );
  const match = url.pathname.match(/=x(\d+)-y(\d+)-z0-t(.+)$/);
  if (!match) return new Response(null, { status: 404 });
  const path = url.pathname.slice(1, url.pathname.lastIndexOf("-t"));
  const signature = createHmac("sha1", Buffer.from("7b2b4e23de2cc5c5", "hex"))
    .update(`${path}-tsample-token`)
    .digest("base64")
    .replace(/[+/]/g, "_")
    .replace(/=+$/, "");
  return signature === match[3]
    ? tile(Number(match[1]), Number(match[2]))
    : new Response(null, { status: 403 });
}
