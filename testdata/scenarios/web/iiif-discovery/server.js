import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file }) {
  const url = new URL(request.url);
  // Metadata files take precedence over the synthetic tile fallback.
  if (file || url.hostname !== "127.0.0.1") return null;
  if (
    !["/fixtures/iiif-private-id/", "/iiif/", "/digital/iiif/"].some((prefix) =>
      url.pathname.startsWith(prefix),
    )
  )
    return null;
  return fileResponse(new URL("./payloads/127.0.0.1/stub.jpg", import.meta.url));
}
