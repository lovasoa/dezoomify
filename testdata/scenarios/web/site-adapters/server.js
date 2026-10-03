import { readFileSync } from "node:fs";
import { decryptTile, verifiedBase } from "../google-arts-web/arts.js";

export function serve(request) {
  const pathname = new URL(request.url).pathname;
  if (!/^\/arts\/(path|plain)=x[0-9]+-y[0-9]+-z[0-9]+-t[^/]+$/.test(pathname)) return null;
  const base = verifiedBase(pathname);
  if (!base)
    return new Response("fixture error", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  const stored = readFileSync(
    new URL("./payloads/fixtures.test/arts/encrypted-tile.b64", import.meta.url),
  );
  try {
    const bytes = base === "plain" ? Buffer.from("plain-tile") : decryptTile(stored);
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
  } catch {
    return new Response("fixture error", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
