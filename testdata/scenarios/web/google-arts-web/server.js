import { readFileSync } from "node:fs";
import { verifiedBase } from "./arts.js";

export function serve(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (
    url.hostname !== "fixtures.test" ||
    !/^\/arts\/gap\/path=x[0-9]+-y[0-9]+-z[0-9]+-t[^/]+$/.test(pathname)
  )
    return null;
  if (!verifiedBase(pathname))
    return new Response("fixture error", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  const image = pathname.includes("=x1-y0-z0-") ? "padded-edge-tile.bin" : "encrypted-tile.bin";
  return new Response(
    readFileSync(new URL(`./payloads/fixtures.test/arts/${image}`, import.meta.url)),
    {
      headers: { "content-type": "application/octet-stream" },
    },
  );
}
