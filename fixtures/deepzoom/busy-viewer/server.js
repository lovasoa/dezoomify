import { readFileSync } from "node:fs";

export function serve(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/deepzoom/busy-viewer/")) return null;
  if (url.pathname.includes("/assets/"))
    return new Response("/* unrelated asset */", {
      headers: { "content-type": "text/javascript" },
    });
  if (!url.pathname.endsWith("/imageproxy.aspx")) return null;
  const filename = url.searchParams.get("filename");
  if (filename === "objectimages/painting.dzi")
    return new Response(readFileSync(new URL("../basic/image.dzi", import.meta.url)), {
      headers: { "content-type": "text/xml" },
    });
  const tile = filename?.match(/^objectimages\/painting_files\/9\/(\d)_(\d)\.png$/);
  return tile
    ? new Response(
        readFileSync(new URL(`../../tiles/${tile[1]}-${tile[2]}.png`, import.meta.url)),
        {
          headers: { "content-type": "image/png" },
        },
      )
    : new Response("Not found", { status: 404 });
}
