import { tile } from "../../tiles/server.js";
export function serve(request, { file }) {
  if (file) return null;
  const match = new URL(request.url).pathname.match(
    /^\/fixtures\/arcgis\/approximate-basic\/MapServer\/tile\/0\/(\d+)\/(\d+)$/,
  );
  return match ? tile(Number(match[2]), Number(match[1])) : null;
}
