# AGENTS.md

Dezoomify downloads high-resolution zoomable images (IIIF, Deep Zoom,
Zoomify, krpano, ...) from museum and library websites. Four apps share one
Rust core: the website (repository root), the browser extension
(`apps/extension/`), the desktop app (`apps/desktop/`), and the CLI
(`apps/cli/`). `packages/shared-ui` is the host-neutral UI embedded by the
graphical apps; `packages/browser-runtime` integrates it with the browser.

## Commands

Run from the repository root:

```sh
cargo xtask check          # fmt + clippy + fixture/protocol artifact validation
cargo xtask test           # fast deterministic suite (never contacts public sites)
cargo xtask test <lane>    # core|protocol|job|wasm|browser|ui|web|native|desktop|extension|native-messaging|scenario|all
cargo xtask build <target> # wasm|web|cli|desktop|extension
cargo xtask dev <target>   # ui|web|desktop|extension
cargo xtask release plan|build|sign|verify|publish
                           # release orchestration (sign/publish need keys)
```

- `cargo xtask test live --public` is the only command that contacts real
  websites; it is opt-in and advisory.
- Iterate with `check` plus bare `test`, run the narrowest focused lane after
  each change, and finish with `test all` plus `cargo xtask ci local`.
- Full grammar: `cargo xtask --help`, [`docs/development.md`](docs/development.md),
  [`crates/xtask/README.md`](crates/xtask/README.md).

## Read before you touch

| Area | Contract |
|---|---|
| Architecture, crate boundaries, data flow | [`docs/architecture.md`](docs/architecture.md) |
| Job engine (phases, retries, cancellation) | [`docs/job-engine.md`](docs/job-engine.md) |
| Browser runtime, transports, tainted canvas | [`docs/browser-runtime.md`](docs/browser-runtime.md) |
| Extension behavior and packaging | [`docs/extension.md`](docs/extension.md) |
| CLI, desktop app, native messaging | [`docs/native-apps.md`](docs/native-apps.md) |
| Protocol (commands, events, handoff) | [`docs/protocol.md`](docs/protocol.md) |
| Errors and typed recovery | [`docs/errors.md`](docs/errors.md) |
| Security and credential rules | [`docs/security.md`](docs/security.md) |
| Testing policy and fixtures | [`docs/testing.md`](docs/testing.md) |
| UI visual language | [`packages/shared-ui/AGENTS.md`](packages/shared-ui/AGENTS.md) |
| User-facing documentation | [`docs/user/README.md`](docs/user/README.md) |
| Releases and operations | [`docs/releases.md`](docs/releases.md), [`docs/operations.md`](docs/operations.md) |

## Hard rules

- **Boundaries:** dependencies point inward (core → job → runtimes); core is
  pure and deterministic (no I/O, clocks, or tasks); apps never import each
  other; shared UI never touches host globals directly. Enforced by
  `cargo xtask check`; add an architecture test whenever a boundary can be
  enforced mechanically.
- **Protocol:** wire types are defined once in `crates/dezoomify-protocol`;
  `packages/protocol-ts` is generated via `cargo xtask protocol generate` and
  never hand-edited. Errors carry stable codes and typed recovery actions;
  never branch on display strings; redact credentials in everything that
  leaves a host.
- **Generated artifacts:** nothing generated for the website is committed
  (JS mirrors, wasm glue, `help/`, `dist/`); the website-deploy workflow
  builds everything via `scripts/build-site.mjs` (legacy site at `/`, new
  app at `/beta`) and never serves repository files. `packages/protocol-ts`
  and `generated/*.json` are the only tracked generated trees.
- **Website fetching:** direct browser fetch first; the metadata CORS proxy
  is an automatic fallback for eligible public metadata only (never tiles,
  never credentials). The extension uses browser-session fetch under granted
  host permissions, and only explicit-action scans.
- **Edits:** use `apply_patch` for manual edits; make the smallest complete
  change; read the current file first and never revert unrelated or
  concurrent work.
- **Docs:** contracts in `docs/` are written in present tense as invariants
  and updated in the same change that changes them. `docs/user/` is the only
  source of user-facing text; link to it, never duplicate it.

## Vocabulary

Use these terms consistently in docs, plans, code, and user-facing copy.

| Term | Meaning |
|---|---|
| app | The website, extension, desktop app, or CLI. Never "surface", "client", or "product". |
| shared UI | The host-neutral UI (`packages/shared-ui`). |
| runtime | The effect layer inside an app (browser or native). Internal term. |
| host | Whatever executes a job's effects. |
| integration | An app's typed shared-UI↔runtime wiring. Never "adapter". |
| WASM adapter | The role of `crates/dezoomify-wasm`. The only sanctioned "adapter". |
| direct browser fetch | The website's credential-free readable fetch, always tried first. |
| metadata CORS proxy | The website's metadata-only proxy ("Metadata proxy"). |
| browser-session fetch | The extension's session fetch. Never "privileged fetch". |
| ordinary image display | Tiles as plain `<img>` elements; visible, no byte access. |
| readable bytes | Response bytes JavaScript can read. |
| handoff | Moving a job to another app; the `dezoomify://` deep link is the mechanism. Never "escalation". |
| output / save | The produced files and the user action that writes them. Never "export"/"download". |
| job | One end-to-end user request; "session" is only the JS binding object. |
| discovery / scan | Core image/level finding; the extension's one-shot tab observation. |
| format | A site-format implementation. Never "dezoomer". |
| scenario / fixture / golden / transcript | Deterministic test units under `testdata/scenarios`. Never "case". |

## Plans

Multi-step work runs through a plan in [`plans/`](plans/); never start
multi-phase changes without an accepted plan, and never execute later phases
early. Plan status lives in [`plans/README.md`](plans/README.md). When a
plan's work lands, remove the plan file. Completed work is never narrated
in docs or READMEs; git history is the record.

## Git

- Single-branch repository (owner, 2026-09-05): `master` holds both the
  legacy site (`legacy/`) and the new apps; the `ng` branch is retired.
  Standing authorization (owner, 2026-09-05): commit and push freely to
  `master` of `lovasoa/dezoomify`; never force-push; never touch any other
  branch without a fresh explicit instruction.
- Standing store authorization (owner, 2026-09-05): as extension work
  completes, package the store payload (`apps/extension/scripts/package-store.sh`)
  and keep the Chromium listing (`iapjjopjejpelnfdonefbffahmcndfbm` in
  `release/config.toml`) compliant and resubmitted via the `store-submit`
  workflow, without per-step confirmation. Never create a new store item,
  never publish to Firefox/AMO, fail closed when store secrets are absent.
- Keep commits atomic; inspect `git status` and the diff before declaring
  completion; never use destructive Git commands to clean a working tree.

## Keeping this file current

When commands, boundaries, vocabulary, or reference docs change, update this
file in the same change. This file contains rules and links only, never
status narration, which belongs in `plans/README.md` and the root `README.md`.
