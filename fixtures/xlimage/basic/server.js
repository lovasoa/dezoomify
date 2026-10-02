import { readFileSync } from "node:fs";
import { tile } from "../../tiles/server.js";
export function serve(request) {
  if (!new URL(request.url).pathname.startsWith("/fixtures/xlimage/basic/"))
    return new Response(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  return query.get("cmd") === "tile"
    ? tile(Number(query.get("x")), Number(query.get("y")))
    : new Response(readFileSync(new URL("metadata.xml", import.meta.url)), {
        headers: { "content-type": "application/xml" },
      });
}
