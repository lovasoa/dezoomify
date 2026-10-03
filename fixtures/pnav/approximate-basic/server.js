import { tile } from "../../tiles/server.js";
export function serve(request, { file }) {
  if (file) return null;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/fixtures/pnav/approximate-basic/image.jpg")) return null;
  return tile(Number(url.searchParams.get("cl")) / 512, Number(url.searchParams.get("ct")) / 512);
}
