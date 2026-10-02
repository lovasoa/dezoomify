import { tile } from "../../tiles/server.js";
export function serve(request) {
  const match = new URL(request.url).pathname.match(
    /^\/fixtures\/arcgis\/basic\/MapServer\/tile\/0\/(\d+)\/(\d+)$/,
  );
  return match ? tile(Number(match[2]), Number(match[1])) : new Response(null, { status: 404 });
}
