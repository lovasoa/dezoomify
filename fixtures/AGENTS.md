- Add `format/variant/viewer.html` with minimal metadata and relative links to
  shared images in `tiles/`. Every basic fixture must yield the shared 512×512
  image. A viewer automatically joins all product save matrices.
- Use `input.txt` only to override the relative entry point. For direct inputs,
  link to the shared viewer template; its `{{input}}` token uses that file.
- Set `data-viewer-ready="true"` after response bodies load so extension snapshots
  include them.
- Prefer ordinary files and relative symlinks. Query/authentication protocols
  belong in a local `server.js`; follow the handler contract at
  `test/fixture-server.mjs`, using `tiles/server.js` where appropriate.
- Pixel comparisons are exact. Prefix variants with `approximate-` only for
  JPEG decoding's two-value RGB tolerance; dimensions and alpha stay exact.
- Keep reproductions minimal. Record the original URL, issue, and license in a
  local README, retain copied notices, and exclude real credentials/private URLs.

Locally authored synthetic bytes are GPL-3.0-or-later. Historical source grants
remain in [testdata/scenarios](../testdata/scenarios/README.md).
