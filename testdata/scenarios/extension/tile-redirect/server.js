import { fileResponse, replayUrl } from "../../../../test/fixture-files.mjs";

export function serve(request, { origin }) {
  const url = new URL(request.url);
  if (url.hostname === "127.0.0.1") {
    const signed = url.pathname.match(
      /^\/extension-inputs\/signed\/(ImageProperties\.xml|[01]_[01]\.png)$/,
    );
    if (signed)
      return fileResponse(
        new URL(`./payloads/fixtures.test/redirect-tiles/signed/${signed[1]}`, import.meta.url),
      );
    const tile = url.pathname.match(
      /^\/extension-inputs\/(?:signed\/)?TileGroup0\/0-([01])-([01])\.jpg$/,
    );
    const target =
      url.pathname === "/extension-inputs/ImageProperties.xml"
        ? "ImageProperties.xml"
        : tile
          ? `${tile[1]}_${tile[2]}.png`
          : null;
    if (!target) return null;
    const location = new URL(`/extension-inputs/signed/${target}`, origin);
    location.searchParams.set("v", "2");
    return new Response(null, { status: 307, headers: { Location: location.href } });
  }
  if (url.hostname !== "fixtures.test") return null;
  const tile = url.pathname.match(/^\/redirect-tiles\/TileGroup0\/0-([01])-([01])\.jpg$/);
  const target =
    url.pathname === "/redirect-tiles/ImageProperties.xml"
      ? "ImageProperties.xml"
      : tile
        ? `${tile[1]}_${tile[2]}.png`
        : null;
  return target
    ? new Response(null, {
        status: 307,
        headers: {
          Location: replayUrl(origin, `https://fixtures.test/redirect-tiles/signed/${target}?v=2`),
        },
      })
    : null;
}
