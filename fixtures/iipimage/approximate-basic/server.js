import { readFileSync } from "node:fs";
import { tile } from "../../tiles/server.js";
export function serve(request, { file }) {
  if (file) return null;
  if (!new URL(request.url).pathname.startsWith("/fixtures/iipimage/approximate-basic/"))
    return null;
  const query = new URL(request.url).searchParams;
  if (query.has("JTL")) {
    const [level, index] = query.get("JTL").split(",").map(Number);
    return level === 1
      ? tile(index % 2, Math.floor(index / 2))
      : new Response(null, { status: 404 });
  }
  return new Response(readFileSync(new URL("metadata.txt", import.meta.url)));
}
