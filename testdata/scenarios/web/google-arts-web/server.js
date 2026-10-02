import { readFileSync } from "node:fs";
import { verifiedBase } from "./arts.js";

export function serve(request) {
  const pathname = new URL(request.url).pathname;
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
