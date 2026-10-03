import { tile } from "../../tiles/server.js";
export function serve(request) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/fixtures/pnav/approximate-basic/image.jpg"))
    return new Response(null, { status: 404 });
  return tile(Number(url.searchParams.get("cl")) / 512, Number(url.searchParams.get("ct")) / 512);
}
