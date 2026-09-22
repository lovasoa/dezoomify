# Contributing a format

A new format ships five parts: pure core parser, `registry.rs` entry, shared scenario, passing `fixtures verify`, passing `test core --parity`. The pull request pastes the source URL plus capture output and expected output image.

## Checklist

Complete when all hold in one pull request:

- `crates/dezoomify` parses metadata and plans tiles from supplied bytes only (no network, filesystem, clock, or tasks), per [Architecture](architecture.md).
- `crates/dezoomify/src/core/registry.rs` registers a stable id plus user-visible display name in precedence order.
- `testdata/scenarios/<id>/` holds redacted `routes.json`, payloads, `scenario.json`, per `testdata/scenarios/README.md`.
- `cargo xtask fixtures verify` passes.
- `cargo xtask test core --parity` passes.

## Workflow

### 1. Paste the URL

Find a public viewer page or metadata file showing the format; paste the URL into the PR description. Public pages only: no credentials, signed URLs, or personal data. Public demo keys in fixture URLs are fine; private tokens never commit. See [Security](security.md).

### 2. Capture redacted fixtures

Run the capture helper from the repository root:

```sh
cargo xtask fixtures capture --url <url> --out <scenario-id> --redact
```

Pass `--also <url>` per extra metadata resource the parser needs (viewer page plus `info.json`, for example). The helper fetches with plain `curl` (credential-free, bounded redirects and time, per-payload size cap). It saves `routes.json` plus payloads under `testdata/scenarios/<scenario-id>/` and prints a manifest snippet plus next steps.

Redaction is mandatory: the command fails closed without `--redact`. It drops URL fragments, rejects userinfo URLs, replaces sensitive query values (`apiKey`, `token`, `auth`, `session`, `signature`, `secret`, `password`, `cookie`, case variants) with `REDACTED`, scrubs the same values from text payloads, and keeps only the `Content-Type` response header. Colons in payload paths become `%3A` for Windows checkouts.

After capture, review first:

```sh
git status --porcelain -- testdata/scenarios
git diff -- testdata/scenarios/<scenario-id>
```

Confirm no secret, token, cookie, or personal string remains. Insert the printed manifest entries (sorted) into `testdata/scenarios/manifest.json` with accurate `license_provenance`, then run `cargo xtask fixtures verify`. Verification rewrites nothing; fix fixtures until green. Provenance: [Licensing](licensing.md).

### 3. Add the core parser and register it

Implement the format beside neighboring format modules: recognize URL shape and metadata bytes, describe the catalog, plan the tile grid. Pure and deterministic: fixed parsing, no network, stable ordering. Register the stable id in precedence order in `crates/dezoomify/src/core/registry.rs`; cover with unit cases plus the parity suite.

### 4. Save the expected output

Run the native app against loopback fixtures and save the expected output for the PR:

```sh
cargo xtask fixtures serve --port 0
dezoomify "<viewer-or-metadata-url>" expected.png
```

Attach `expected.png` so reviewers compare pixels, not promises. Name produced files with `output` / `save`, never `export` / `download`.

### 5. Verify and open the pull request

From the root:

```sh
cargo xtask fixtures verify
cargo xtask test core --parity
cargo xtask test scenario
```

The PR holds the pasted URL, capture output, expected image, and checklist. Reviewers check redaction, provenance, precedence, and parity before merge. Live checks (`cargo xtask test live --public`) stay advisory, never replacing scenario coverage, per [Testing](testing.md).
