import { tile } from "../../tiles/server.js";
export function serve(request) {
  return decodeURIComponent(new URL(request.url).pathname) ===
    "/fixtures/generic/basic/tiles/{{X}}-{{Y}}.jpg"
    ? tile(0, 0)
    : new Response(null, { status: 404 });
}
