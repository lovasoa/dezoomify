# Contributing a format

Each new format ships the same five parts: a pure core parser, a
`registry.rs` entry, a shared scenario, a passing `fixtures verify`, and a
passing `test core --parity`. The pull request pastes the source URL,
attaches the capture output, and attaches the expected output image.

## Checklist

A format is complete when all of the following hold in one pull request:

- `crates/dezoomify-core` parses the metadata and plans tiles from supplied
  bytes only. Core performs no network, filesystem, clock, or task effects,
  per [Architecture](architecture.md).
- `crates/dezoomify-core/src/core/registry.rs` registers the format with a
  stable id and a user-visible display name. Registry order defines automatic
  precedence; put the new entry where discovery must try it.
- `testdata/scenarios/<id>/` holds redacted `routes.json`, payloads, and
  `scenario.json`, per `testdata/scenarios/README.md`.
- `cargo xtask fixtures verify` passes.
- `cargo xtask test core --parity` passes.

## Workflow

### 1. Paste the URL

Find a public viewer page or metadata file that shows the format. Paste the
URL into the pull request description. Use only public pages: no credentials,
no signed URLs, no personal data. Public demo keys embedded in fixture URLs
are allowed; private tokens are never committed. See [Security](security.md).

### 2. Capture redacted fixtures

Run the capture helper from the repository root:

```sh
cargo xtask fixtures capture --url <url> --out <scenario-id> --redact
```

Pass `--also <url>` for each extra metadata resource the parser needs (for
example a viewer page plus its `info.json`). The helper fetches with plain
`curl`: credential-free requests, bounded redirects, bounded time, and a
per-payload size cap. It saves `routes.json` plus payloads under
`testdata/scenarios/<scenario-id>/` and prints a manifest snippet plus next
steps.

Redaction is mandatory, not optional: the command fails closed without
`--redact`. It drops URL fragments, rejects URLs with userinfo, replaces
sensitive query values (`apiKey`, `token`, `auth`, `session`, `signature`,
`secret`, `password`, `cookie`, and case variants) with `REDACTED`, scrubs
the same values from text payloads, and stores only the `Content-Type`
response header. Colons in payload paths become `%3A` so the tree checks out
on Windows.

After capture, review the changes before anything else:

```sh
git status --porcelain -- testdata/scenarios
git diff -- testdata/scenarios/<scenario-id>
```

Confirm no secret, token, cookie, or personal string remains. Insert the
printed manifest entries (sorted) into `testdata/scenarios/manifest.json`
with accurate `license_provenance`, then run
`cargo xtask fixtures verify`. Verification never rewrites files; fix the
fixtures until it passes.

### 3. Add the core parser and register it

Implement the format in `crates/dezoomify-core` following the neighboring
format modules: recognize the URL shape and metadata bytes, describe the
image catalog, and plan the tile grid. Keep the code pure and deterministic:
fixed parsing, no network, stable ordering. Register the stable id in
`crates/dezoomify-core/src/core/registry.rs` in precedence order and cover
the parser with unit cases plus the shared parity suite.

### 4. Save the expected output

Run the native app against the loopback fixtures once the scenario serves,
and save the expected output image for the pull request:

```sh
cargo xtask fixtures serve --port 0
dezoomify "<viewer-or-metadata-url>" expected.png
```

Attach `expected.png` to the pull request so reviewers compare pixels, not
promises. Name the produced files with the shared `output` / `save`
vocabulary; never `export` or `download` for the saved files.

### 5. Verify and open the pull request

Run the gates from the repository root:

```sh
cargo xtask fixtures verify
cargo xtask test core --parity
cargo xtask test scenario --scenario <scenario-id>
```

The pull request contains the pasted URL, the capture output, the expected
output image, and the checklist above. Reviewers check redaction, license
provenance, registry precedence, and parity before merge. Live checks
(`cargo xtask test live --public`) stay advisory and never replace scenario
coverage, per [Testing](testing.md).
