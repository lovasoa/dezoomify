# Repository Guide

Use this file for repository-wide implementation rules. Apply a more specific
`AGENTS.md` when one exists below the file being changed.

## Current State

- Treat this checkout as a scaffold and migration workspace. The only imported
  implementations currently live under `migration-sources/`; scaffold README
  files describe boundaries, not completed components.
- Implement only the current phase of an accepted plan in [`plans/`](plans/).
  Do not opportunistically fill empty crates or applications.
- Preserve the three imported roots and their retained Git history. Do not edit,
  move, reformat, or delete anything under `migration-sources/` unless an
  explicit migration-plan step requires that exact change. Do not remove legacy
  material before the phase-14 parity and cutover gates approve removal.

## Sources Of Truth

Resolve conflicts in this order:

1. Follow the user's explicit task and scope.
2. Follow the active plan and its accepted decisions.
3. Follow contracts and architecture in `docs/`.
4. Follow this file and any narrower `AGENTS.md`.
5. Follow the nearest component README for ownership and dependency boundaries.
6. Consult `migration-sources/` for legacy behavior and parity evidence, not as
   authority for the target architecture.

Stop and ask one focused question when higher-priority sources conflict or a
decision affects a public protocol, security boundary, persisted data, or more
than the current plan phase.

## Vocabulary

Use these terms consistently in docs, plans, code identifiers, and user-facing
copy. Do not invent new jargon from user phrasing: map new concepts onto the
closest defined term, and adopt a new term only when the user explicitly names
one.

| Term | Meaning |
|---|---|
| app | One of the four user-facing programs: the website, the extension, the desktop app, and the CLI. Never "surface", "Studio", "client", or "product". |
| shared UI | The host-neutral React UI (`packages/shared-ui`) embedded by graphical apps. |
| runtime | The effect-execution layer inside an app: the browser runtime (`packages/browser-runtime` with `crates/dezoomify-wasm`) and the native runtime (`crates/dezoomify-native`). Internal term; never used in user-facing copy. |
| host | Whatever executes a job's effects; also the app embedding the shared UI. |
| integration | An app's typed implementation connecting the shared UI to its runtime and host capabilities (`AppIntegration`, `webIntegration.ts`). Never "adapter". |
| WASM adapter | The defined role of `crates/dezoomify-wasm`: adapting core, job, and protocol types to JavaScript. The only sanctioned use of "adapter". |
| direct browser fetch | The website's credential-free readable fetch; always attempted first. |
| metadata CORS proxy | The website's restricted same-origin proxy for metadata files only, never tiles. Used automatically only after a classified CORS/network failure for an eligible public, non-credential metadata request. UI label: "Metadata proxy". Short form after first use: "the proxy". |
| browser-session fetch | The extension's background fetch using the browser's existing session under granted host permissions; the extension's only credential-bearing path. Never "privileged fetch". |
| ordinary image display | Tiles loaded as plain `<img>` elements, possibly drawn into a tainted display canvas; no byte access. |
| readable bytes | Response bytes JavaScript can read; required for decode, processing, and saving. Never obtained from ordinary image display. |
| handoff | Moving a job to another app (website to extension, website to desktop, extension to native cookie handoff). "Deep link" is the `dezoomify://` mechanism. Never "escalation". |
| output | The produced file(s). "save" is the browser user action that writes them. Never "export" or "download" for these. |
| job | One end-to-end user request. "session" is only the JavaScript binding object. |
| discovery | The core process of finding images and levels. "scan" is the extension's one-shot active-tab observation. |
| format | A site-format implementation. "dezoomer" appears only in migration-source evidence and parity history. |
| scenario / fixture / golden / transcript | One deterministic test unit under `testdata/scenarios` / a payload file / canonical bytes / an ordered message record. Never "case" for a test unit. |
| migration sources | The three read-only trees under `migration-sources/`. "legacy" means the deployed old products. |

## Working Rules

- Preserve user and concurrent-agent changes. Read the current file before
  editing, never revert unrelated work, and stop if concurrent edits directly
  conflict with the task.
- Use `apply_patch` for every manual file edit. Use formatters only for
  mechanical formatting after reviewing their scope.
- Make the smallest complete change. Do not add speculative compatibility,
  abstractions, dependencies, or public API.
- Keep commits atomic when commits are requested. Never commit, amend, push,
  force-push, rewrite history, or create a pull request without explicit user
  instruction.
- Inspect `git status` and the final diff before declaring completion. Never use
  destructive Git commands to clean a working tree.

## Architecture Boundaries

Keep dependency direction toward stable, portable layers:

```text
dezoomify-core       dezoomify-protocol
        \                 /
             dezoomify-job
              /          \
   dezoomify-native   dezoomify-wasm
```

- Keep `dezoomify-core` deterministic and pure. It may parse supplied bytes,
  describe discovery requests, validate catalogs and grids, and produce tile
  and processing plans. It must not perform network or filesystem I/O, decode
  images, read clocks or environment state, spawn tasks, or depend on Tokio,
  Reqwest, browser APIs, CLI/UI frameworks, or application crates. A logging
  facade is allowed; runtime logging configuration is not.
- Keep `dezoomify-protocol` transport-neutral and independent of core internals.
  It owns versioned protocol types, commands, events, typed error shapes, and schema
  compatibility. It must not perform work or depend on applications, hosts, or
  UI packages.
- Put portable job orchestration, cancellation, progress, retries, and host
  capability requests in `dezoomify-job`. Depend only on `core`, `protocol`, and
  small portable libraries; inject all I/O and time.
- Keep HTTP, filesystem, cache, image codec, and native concurrency code in
  `dezoomify-native`. Put browser APIs, workers, JS interop, and browser storage
  code in `dezoomify-wasm` and `packages/browser-runtime`.
- Keep each app self-contained. Do not import one app from another,
  put reusable domain logic in an app, or let crates depend on packages/apps.
- Keep `shared-ui` host-neutral. Access jobs and host capabilities through
  protocol/runtime interfaces, never through native, extension, or raw browser
  globals.
- Add an architecture test whenever a boundary can be enforced mechanically.

## Protocol And Errors

- Make the versioned Rust definitions in `crates/dezoomify-protocol` the single
  canonical protocol source. Generate `packages/protocol-ts` from that Rust
  source through `crates/xtask`; never maintain a second hand-written schema or
  hand-edit generated TypeScript wire types. Make generation deterministic and
  fail CI when regeneration produces a diff.
- Version wire-breaking changes deliberately. Add Rust serialization tests,
  TypeScript type/fixture tests, and cross-language golden round trips for every
  protocol change.
- Represent failures with stable machine-readable codes, a category, retry and
  cancellation semantics, safe structured context, and a user-facing message.
  Preserve source chains inside the owning host, but do not expose host-specific
  error types over the protocol.
- Represent recovery as typed, revision-bound actions such as retry, edit input,
  choose output, grant permission, change transport, keep/discard partial, or
  hand off to native. Never require the shared UI or the CLI to infer an action from an
  error message, and reject stale or forged recovery actions.
- Never branch on display strings. Map errors once at each boundary. Model
  cancellation, unsupported capability, invalid input, transport failure,
  decode failure, and partial completion distinctly.
- Redact credentials, cookies, authorization headers, local paths, and sensitive
  URLs from errors, protocol events, telemetry, snapshots, and logs.

## Browser And Security Rules

- Keep readable-byte fetches and ordinary image loading explicit. A readable response
  may expose validated status, headers, and bytes to discovery or decoding. On
  the website, an ordinary cross-origin tile may instead load through `<img>`
  without `crossorigin` and be drawn to the display canvas. The result remains
  visible, including browser/user-agent right-click save where offered, even
  though the canvas becomes tainted.
- Track canvas capability as `originClean`. Set it to `false` when a potentially
  tainting tile is drawn. While false, forbid JavaScript pixel reads, pixel
  processing, hashing, persistence of pixels, `toBlob`, `toDataURL`, and any
  claim of clean programmatic save. Do not forbid drawing, display, or
  user-agent save behavior merely because the canvas is tainted.
- Route operations that require metadata bytes, header inspection, image
  decoding into JavaScript-readable pixels, hashing, pixel persistence, or clean
  programmatic save through a readable-byte fetch. On the website, try a direct
  browser fetch first. After a classified CORS/network failure, automatically
  retry eligible public non-credential metadata requests through the metadata
  CORS proxy while the user's proxy setting permits it; the proxy serves
  metadata only, never tiles. Provide an opt-out and do not show a per-attempt
  consent prompt. Keep the active transport clearly visible. Test direct
  success, automatic metadata proxy fallback, proxy opt-out, transport
  visibility, tainted display, `originClean` guards, user-agent save
  availability, and unsupported readable operations independently.
- In the extension, normally use browser-session fetch with narrowly granted
  host permissions. Create blob-backed images or `ImageBitmap` tiles and keep
  the composed canvas origin-clean. A same-origin or page-context fallback may
  exist, but the extension never uses the metadata CORS proxy.
- Do not put cookies, bearer tokens, or authorization data in URLs, query
  strings, protocol payloads, persisted job state, or logs. Do not expose the
  browser cookie jar to WASM or UI code.
- Send credentials only through a host-owned capability, only after explicit
  user intent, and only to the matching origin. Default website/WASM requests to
  credential-free behavior; the extension's active-job browser-session fetch may use
  its current browser session as described above. Preserve CLI/user headers only in
  trusted native memory and redact them in diagnostics.
- Never send cookies, `Authorization`, or other browser credentials through the
  metadata CORS proxy. Never proxy private/local destinations or requests outside the
  configured method, scheme, port, content, size, time, redirect, concurrency,
  rate, and session-budget limits.
- Allow cookie handoff only to the native host, after explicit consent and only
  for named origins. Automatic metadata CORS proxy fallback never grants or implies
  this consent. Do not intentionally persist handed-off cookies; keep them for a
  best-effort short lifetime and release references promptly. Do not claim
  impossible guaranteed zeroization in managed browser or operating-system
  memory.
- Treat website/deep-link handoff as bounded, versioned, non-secret, untrusted
  input. Validate its schema, size, URLs, and requested capabilities, then require
  user confirmation before starting work.
- For extension-to-native Native Messaging, browser enforcement of the native
  host manifest's allowed extension IDs authenticates the extension sender. A
  fresh challenge/nonce binds one handoff and its consent and blocks replay; it
  does not establish sender identity. Never embed a private signing key in
  extension JavaScript.
- Do not ship an open proxy. Validate schemes and destinations, revalidate every
  redirect, block loopback/private/link-local/metadata targets unless a narrowly
  documented local mode requires them, strip hop-by-hop and inbound credential
  headers, enforce size/time/redirect limits, and return restrictive CORS.
- Give the extension the narrowest permissions possible. Start one finite scan
  only from an explicit extension action, register its observers/listeners
  before its one scan-triggering reload, and bound and deduplicate results.
  Stop after settling, a deadline, or extension-page/tab close, and detach observers,
  timers, page references, and listeners. An extension-page reload never rearms a scan by
  itself. Restrict browser-session background fetch to the active job and granted
  origin; service-worker recovery must not silently resume scanning.

## Fixtures And Tests

- Put deterministic, host-independent scenario data in `testdata/scenarios/`.
  Record provenance, expected requests/events/results, and any license or
  redaction constraints. Keep fixtures minimal and never include credentials or
  private user data.
- Serve browser/native integration fixtures through `crates/fixture-server`.
  Bind to loopback on an ephemeral port, use deterministic routes, and simulate
  redirects, headers, cookies, range behavior, opaque and readable responses, failures,
  and timing without contacting third parties.
- Keep live compatibility tests opt-in and non-blocking. Every behavior relied
  on by an app must also have deterministic regression coverage.
- Test at the lowest owning layer first, then boundary integration, then the
  affected app. Add parity tests before deleting migrated legacy behavior.

## Plan Execution

1. Read the entire active plan, linked docs, relevant scaffold READMEs, and
   legacy implementation before editing.
2. Identify the current phase, allowed files, prerequisites, acceptance checks,
   and rollback boundary. Do not execute later phases early.
3. Establish a focused failing test or parity observation when behavior changes.
4. Implement one coherent increment and run its smallest relevant formatter,
   unit tests, architecture tests, protocol checks, and integration scenario.
5. Repeat incrementally. Do not defer all validation until the end.
6. Run the phase-level checks, inspect status/diff, and report completed scope,
   validation, residual risks, and any checks not run. Update plan status only
   when the plan explicitly assigns that responsibility.

## Validation Commands

This checkout is still a scaffold. The root workspace and `xtask` are not
implemented yet; do not claim a `cargo xtask` command ran. Until they exist, run
the current imported checks from the repository root:

```sh
cargo test --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace
cargo clippy --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path migration-sources/dezoomify-rs/Cargo.toml --all -- --check
npm ci --prefix migration-sources/dezoomify-web/tests
npm test --prefix migration-sources/dezoomify-web/tests
npm ci --prefix migration-sources/dezoomify-extension
npm test --prefix migration-sources/dezoomify-extension
```

Treat network-dependent web and Rust tests as live checks and report them
separately from deterministic checks.

The canonical final-state task grammar is documented now so implementation
phases converge on one interface:

```sh
cargo xtask setup
cargo xtask check
cargo xtask test [core|protocol|job|wasm|browser|ui|web|native|desktop|extension|native-messaging|scenario|live|all]
cargo xtask build <wasm|web|cli|desktop|extension>
cargo xtask dev <ui|web|desktop|extension>
cargo xtask ci <lane>
cargo xtask release <plan|build|verify>
cargo xtask protocol <generate|check>
cargo xtask fixtures <verify|serve>
cargo xtask sources verify
cargo xtask parity <validate|report>
```

Bare `cargo xtask test` is the fast deterministic suite; `test all` is the
complete deterministic suite. Neither may contact public sites. Only
`cargo xtask test live` enables public-network compatibility checks. Prefer
`check` plus bare `test` while iterating, the narrowest focused test after each
change, and `test all` plus `ci local` before a pull request. See
`docs/development.md`, `docs/testing.md`, and
`crates/xtask/README.md` for target and lane definitions. These commands remain
unavailable until the root workspace and xtask implementation exist; the
migration-source commands above remain authoritative in the meantime.

## Documentation

- Write normative architecture and product contracts in present tense as clear
  invariants. Record implementation status, sequencing, and unavailable commands
  in the root README and plans; label scaffold status there so present-tense
  target documentation is never mistaken for evidence of completed code.
- Update architecture, protocol, security, and migration docs in the same change
  that changes those contracts, within the ownership assigned by the task.
- Keep commands executable from the stated directory and distinguish
  deterministic checks from live/network-dependent checks.

## Safe Completion

A change is safely complete only when it stays within assigned files and the
current plan phase; preserves migration sources and unrelated work; respects
dependency, protocol, browser, credential, and fixture boundaries; includes the
lowest useful regression coverage; passes all applicable incremental and final
checks; produces no unintended generated or formatted files; leaves the diff
reviewable; and reports exact validation plus any remaining risk. If any item is
not true, state that the work is partial rather than calling it complete.
