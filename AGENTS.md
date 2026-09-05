# Repository Guide

Repository-wide rules for working in this repo. Apply a more specific
`AGENTS.md` when one exists below the file being changed. Specialized
contracts live in [`docs/`](docs/) and component READMEs; this file links to
them instead of duplicating them.

## Current State

- The migration (phases 00–15) and the post-migration
  [`webapp-cli-completion`](plans/webapp-cli-completion.md) plan (C1–C7) are
  complete. No plan is currently active. Status and evidence:
  [`plans/README.md`](plans/README.md),
  [`docs/migration/gates.md`](docs/migration/gates.md), and open exceptions
  (E02, E04, E05, E06) in
  [`docs/migration/exceptions.md`](docs/migration/exceptions.md).
- The website and CLI run the real pipeline end to end. The extension has
  explicit-action scan and store packaging (listing pending review, E05). The
  desktop app is a lean Tauri shell without an installer (E04).
- `migration-sources/` holds the three imported legacy trees with retained
  Git history. Treat them as read-only evidence: never edit, move, reformat,
  or delete anything under them unless an explicit accepted-plan step
  requires that exact change.
- Implement only the current phase of an accepted plan in
  [`plans/`](plans/). When no plan covers the work, propose one instead of
  starting multi-phase changes. Do not opportunistically fill empty crates or
  applications.

## Sources Of Truth

Resolve conflicts in this order:

1. The user's explicit task and scope.
2. The active plan and its accepted decisions.
3. Contracts and architecture in [`docs/`](docs/).
4. This file and any narrower `AGENTS.md`.
5. The nearest component README for ownership and dependency boundaries.
6. `migration-sources/` for legacy behavior and parity evidence, never as
   authority for the target architecture.

Stop and ask one focused question when higher-priority sources conflict or a
decision affects a public protocol, security boundary, persisted data, or more
than the current plan phase.

## Reference Docs

| Topic | Source |
|---|---|
| Architecture, crate boundaries, data flow | [`docs/architecture.md`](docs/architecture.md) |
| Job engine (phases, retries, cancellation) | [`docs/job-engine.md`](docs/job-engine.md) |
| Browser runtime, transports, tainted canvas | [`docs/browser-runtime.md`](docs/browser-runtime.md) |
| Extension behavior and packaging | [`docs/extension.md`](docs/extension.md) |
| Native apps (CLI, desktop, native messaging) | [`docs/native-apps.md`](docs/native-apps.md) |
| Protocol (commands, events, handoff, versions) | [`docs/protocol.md`](docs/protocol.md) |
| Errors and typed recovery | [`docs/errors.md`](docs/errors.md) |
| Security and credential rules | [`docs/security.md`](docs/security.md) |
| Testing policy, fixtures, live checks | [`docs/testing.md`](docs/testing.md) |
| Workflows, builds, task grammar | [`docs/development.md`](docs/development.md), [`crates/xtask/README.md`](crates/xtask/README.md) |
| UI visual language | [`packages/shared-ui/AGENTS.md`](packages/shared-ui/AGENTS.md) |
| User-facing documentation | [`docs/user/README.md`](docs/user/README.md) |
| Releases and operations | [`docs/releases.md`](docs/releases.md), [`docs/operations.md`](docs/operations.md), [`docs/incident-response.md`](docs/incident-response.md) |
| Migration evidence and decisions | [`docs/migration/`](docs/migration/) |

## Vocabulary

Use these terms consistently in docs, plans, code identifiers, and user-facing
copy. Do not invent new jargon from user phrasing: map new concepts onto the
closest defined term, and adopt a new term only when the user explicitly names
one.

| Term | Meaning |
|---|---|
| app | One of the four user-facing programs: the website, the extension, the desktop app, and the CLI. Never "surface", "Studio", "client", or "product". |
| shared UI | The host-neutral UI (`packages/shared-ui`) embedded by graphical apps. |
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
  instruction, except for the standing authorizations below.
- Standing git authorization (owner, 2026-09-05): commit and push freely to
  the `ng` branch of `lovasoa/dezoomify` as work completes. Never force-push.
  Never commit to, push to, or rewrite `main` (or any other branch) without a
  fresh explicit instruction; the `ng` to `main` promotion happens only when
  the owner declares the work done.
- Standing store authorization (owner, 2026-09-05): as extension work
  completes, package the store payload and keep the existing Chrome Web Store
  listing in compliance and resubmitted, without per-step confirmation. This
  covers running `apps/extension/scripts/package-store.sh`, invoking the
  `store-submit` workflow via `gh workflow run` with `upload`/`publish` for
  the Chromium listing ID in `release/config.toml`
  (`iapjjopjejpelnfdonefbffahmcndfbm`), and committing any packaging or
  manifest-compliance changes those steps require. Never create a new store
  item, never publish to Firefox/AMO, and fail closed (do not upload) when
  store secrets are absent.
- Inspect `git status` and the final diff before declaring completion. Never
  use destructive Git commands to clean a working tree.
- Keep this file current: when a plan's status changes, or when commands,
  boundaries, vocabulary, or reference docs change, update the affected
  section here in the same change.

## Architecture

Dependencies point inward toward stable, portable layers:

```text
dezoomify-core       dezoomify-protocol
        \                 /
             dezoomify-job
              /          \
   dezoomify-native   dezoomify-wasm
```

Per-crate purity and permission rules are normative in
[`docs/architecture.md`](docs/architecture.md#boundary-rules) and enforced by
`cargo xtask check`. Add an architecture test whenever a boundary can be
enforced mechanically.

## Validation Commands

Run from the repository root:

```sh
cargo xtask check
cargo xtask test [core|protocol|job|wasm|browser|ui|web|native|desktop|extension|native-messaging|scenario|live|all]
cargo xtask build <wasm|web|cli|desktop|extension>
```

- Bare `cargo xtask test` is the fast deterministic suite; `test all` is the
  complete deterministic suite. Neither contacts public sites; only
  `cargo xtask test live` enables public-network compatibility checks.
- Prefer `check` plus bare `test` while iterating, the narrowest focused test
  after each change, and `test all` plus `cargo xtask ci local` before a pull
  request.
- Full command grammar, lanes, builds, and maintenance tasks:
  [`docs/development.md`](docs/development.md),
  [`docs/testing.md`](docs/testing.md),
  [`crates/xtask/README.md`](crates/xtask/README.md).
- Legacy-only verification commands for `migration-sources/` are recorded in
  [`docs/migration.md`](docs/migration.md); they are not a substitute for the
  xtask gates.

## Documentation

- Write normative contracts in [`docs/`](docs/) in present tense as clear
  invariants, and update architecture, protocol, security, and migration docs
  in the same change that changes those contracts.
- Record implementation status and sequencing in the root `README.md` and
  [`plans/`](plans/); label scaffold or incomplete status there so
  present-tense target documentation is never mistaken for evidence of
  completed code.
- [`docs/user/`](docs/user/) is the single source of truth for user-facing
  documentation. Authoring, publishing, and deep-linking rules are in
  [`docs/user/README.md`](docs/user/README.md). Never duplicate its content
  in READMEs, wikis, app listings, or external sites, and never link users to
  legacy doc sites.
- Keep commands executable from the stated directory and distinguish
  deterministic checks from live/network-dependent checks.

## Plan Execution

When a plan in [`plans/`](plans/) is active: read the entire plan and its
linked docs before editing; identify the current phase, allowed files,
prerequisites, acceptance checks, and rollback boundary; and never execute
later phases early. Establish a focused failing test or parity observation
when behavior changes, implement one coherent increment, run its smallest
relevant checks, and repeat incrementally. Finish with the phase-level
checks, then report completed scope, validation, residual risks, and any
checks not run. Update plan status only when the plan explicitly assigns that
responsibility.

## Safe Completion

A change is safely complete only when it stays within assigned files and the
current plan phase; preserves migration sources and unrelated work; respects
dependency, protocol, security, and fixture boundaries; includes the lowest
useful regression coverage; passes all applicable checks; produces no
unintended generated or formatted files; leaves the diff reviewable; and
reports exact validation plus any remaining risk. If any item is not true,
state that the work is partial rather than calling it complete.
