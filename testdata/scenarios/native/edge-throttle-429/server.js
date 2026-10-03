import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request) {
  const url = new URL(request.url);
  if (
    url.hostname !== "fixtures.test" ||
    !/^\/edge\/throttle-429\/pyramid_files\/9\/[01]_1\.png$/.test(url.pathname)
  )
    return null;
  return fileResponse(
    new URL("./payloads/fixtures.test/edge/throttle-429/limited.txt", import.meta.url),
    {
      status: 429,
      headers: { "Retry-After": "1" },
    },
  );
}
