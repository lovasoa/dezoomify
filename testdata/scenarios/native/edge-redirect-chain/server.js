import { replayUrl } from "../../../../test/fixture-files.mjs";

export function serve(request, { origin }) {
  const url = new URL(request.url);
  if (url.hostname !== "fixtures.test") return null;
  const step = ["start", "r1", "r2", "r3", "r4"].indexOf(
    url.pathname.replace("/edge/redirect-chain/", ""),
  );
  if (step < 0 || !url.pathname.startsWith("/edge/redirect-chain/")) return null;
  const next = step === 4 ? "final.dzi" : `r${step + 1}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: replayUrl(origin, `https://fixtures.test/edge/redirect-chain/${next}`),
    },
  });
}
