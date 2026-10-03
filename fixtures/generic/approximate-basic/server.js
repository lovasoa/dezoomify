import { tile } from "../../tiles/server.js";
export function serve(request, { file }) {
  if (file) return null;
  return decodeURIComponent(new URL(request.url).pathname) ===
    "/fixtures/generic/approximate-basic/tiles/{{X}}-{{Y}}.jpg"
    ? tile(0, 0)
    : null;
}
