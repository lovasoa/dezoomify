import { readFileSync } from "node:fs";
export function serve(request, { file }) {
  if (file) return null;
  if (
    !new URL(request.url).pathname.startsWith(
      "/fixtures/hungaricana/approximate-basic/image/image.ecw/",
    )
  )
    return null;
  return new Response(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)), {
    headers: { "content-type": "image/jpeg" },
  });
}
