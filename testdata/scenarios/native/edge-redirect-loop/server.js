import { replayUrl } from "../../../../test/fixture-files.mjs";

export function serve(request, { origin }) {
  const url = new URL(request.url);
  return url.hostname === "fixtures.test" && url.pathname === "/edge/redirect-loop/start"
    ? new Response(null, {
        status: 302,
        headers: {
          Location: replayUrl(origin, "https://fixtures.test/edge/redirect-loop/start"),
        },
      })
    : null;
}
