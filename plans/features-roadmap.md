# Features roadmap (todo 7.3, doc-only)

Status: doc-only. This file orders future work and changes no behavior:
no protocol, engine, runtime, or shared UI code changes in this change.
`bulk_supported` stays `false` on every baseline; no pause or resume
command is added; no output, encoder, or capability changes land here.

Grounding (read before sequencing): [Core workflow](../docs/product.md#core-workflow)
(`docs/product.md:35-42`: discovery, selection, capability validation,
execution, encoding/finalization/publication/cleanup),
[App boundaries](../docs/product.md#app-boundaries) (browser interactive
jobs; native single-job PNG, JPEG, TIFF output to a file or `iiif-dir`;
CLI `--bulk` loop is one bounded single-job run per list entry, not a
runtime multi-output bulk queue), the CLI bulk loop
(`apps/cli/src/main.rs` `run_bulk`, [command-line](../docs/user/command-line.md#saving-many-images)),
and the desktop queue state ([desktop app](../docs/user/desktop-app.md):
each run saves one job to one output file, runs no bulk queue;
[Native apps](../docs/native-apps.md#desktop);
[Capabilities](../docs/protocol.md#capabilities): `bulk_supported` false,
no pause command).

## Order

| # | Feature | Why this position |
|---|---|---|
| 1 | Queue / bulk | Reuses the single-job engine; unblocks collectors and scripts without a runtime queue. Highest contract risk, so it goes first while the boundary is fresh. |
| 2 | Preview / estimate | Makes step 2 of the [core workflow](../docs/product.md#core-workflow) honest: users see cost and limits before acquisition. Read-only, feeds app choice. |
| 3 | History | Builds on 1: a queue produces repeatable jobs worth re-running. Needs storage and redaction design. |
| 4 | Distribution | Ships what exists (signed installers, store listing) before widening the job surface further. No runtime change. |
| 5 | i18n / a11y | Cross-cuts every string. Goes last so locales translate settled flows, not churn. |

Dependency chain: 2 prices 1; 3 replays 1; 4 ships 1-3 unchanged;
5 translates 1-4.

## 1. Queue / bulk

Current state: the CLI `--bulk` loop (`run_bulk` /
`load_bulk_entries` / `bulk_output_for`, `--min-interval` pacing, per-entry
plus totals summary, exit 1 when any entry fails) runs one bounded
single-job run per list entry. The desktop app runs no bulk queue. Every
capability baseline reports `bulk_supported: false`, and `JobCommand` has
no pause or resume command. Bulk text discovery yields deferred entries
that resolve one at a time.

Capability impact: `bulk_supported` stays `false` through the smallest
slice. A true multi-output runtime queue would need a protocol capability
flip, engine scheduling, shared UI gating from the declared capabilities,
and engine-side validation (never UI-only) plus deterministic scenarios.
None of that is in the smallest slice.

Smallest slice: a desktop sequential queue that enqueues validated
single-job requests and runs them one at a time through the existing
native job driver. Per-entry output naming and human/JSON summary mirror
the CLI contract; cancellation stops issuing new work and cleans up per
[Job engine](../docs/job-engine.md#cancel-and-partial-output); no new
`JobCommand`; no concurrent jobs; no `bulk_supported` flip.

Acceptance:

- Queue of N entries produces N single-job runs with one output save per
  entry and a totals summary matching CLI semantics.
- A failed entry does not stop the rest; exit/summary counts match.
- Cancellation issues no new work and removes unpublished artifacts.
- Shared UI controls render from negotiated capabilities; engine rejects
  anything the capabilities forbid.
- Deterministic scenario: multi-entry list with one failure, golden
  per-entry outcomes plus summary.

## 2. Preview / estimate

Current state: browser limits probe (`ok` / `browser-risk` /
`native-required`), ordinary image display without readable bytes versus
readable-bytes save, tainted-canvas display-only path, native available-memory
preflight, and engine fail-fast on over-limit plans. No unified pre-run
estimate panel.

Capability impact: read-only. Renders from the negotiated capability
snapshot (encoders, destination modes, practical size limits,
`max_concurrency`) plus the declared image size. Adds no encoder,
destination, processing op, or storage mode.

Smallest slice: a pre-plan estimate panel on the selection step showing
declared dimensions, tile count, estimated bytes, limit verdict, and the
single best next action in plain language (for example, use the desktop
app for a very large image, or save a smaller level). Uses existing
`probeLimits` verdicts and capability data; engine fail-fast stays the
enforcer.

Acceptance:

- Estimate appears before acquisition for declared sizes, with tile count
  and bytes alongside the verdict.
- Over-limit sizes name the required memory and the smaller-level action
  before anything is written.
- Guidance never recommends an app the capabilities do not verify as
  available.
- Copy follows progressive disclosure: one plain sentence first, detail
  behind diagnostics.

## 3. History

Current state: no persisted job-history ledger (plans track active work;
engine state is per-job transient; the resume cache holds tile response
bytes only, keyed by versioned URL digests, never headers, cookies, or
credentials).

Capability impact: touches `storage_modes`. Anything persisted beyond
memory needs a declared storage feature and the resume-cache redaction
rule extended: request headers, cookies, credentials, and signed query
values never enter history; only redacted origins and typed outcomes do.

Smallest slice: an in-memory recent-jobs list (redacted source origin,
selection, outcome code, output name) with re-run of the same job and a
clear action. No background sync, no cross-device store, no credential
replay.

Acceptance:

- Recent jobs survive navigation within the app session and re-run
  without retyping input.
- Stored entries contain no secrets; an audit greps clean.
- Failed jobs record their stable code and permitted recovery actions for
  re-run or handoff to another app.
- Clear removes all entries; no residue on disk from this slice.

## 5. Distribution

Current state: `cargo xtask release plan|build|sign|verify|publish`
orchestration; desktop bundles per host (`deb`, `msi`/`nsis`, `dmg`,
currently unsigned); website deploy via `scripts/build-site.mjs`
(legacy at `/`, new app at `/beta`); extension store packaging with the
Chromium listing.

Capability impact: none on job capabilities. The shipped matrix must keep
`handoff_supported` and encoder/destination declarations accurate per app
so app-choice guidance stays verifiable.

Smallest slice: signed installers for the three desktop targets, store
resubmit checklist kept compliant, releases page pointing at published
installers. No runtime or protocol change.

Acceptance:

- `release plan|build|sign|verify` is green; unsigned artifacts fail
  closed with named prerequisites.
- Each published installer installs, runs one single-job save, and
  reports its real capabilities.
- Extension listing declares only permissions the shipped code uses.
- User docs link to installers; no duplicated install text per app page.

## 6. i18n / a11y

Current state: one host-neutral shared UI (vanilla TypeScript, no UI
framework) with layered plain-language errors and progressive
disclosure; IIIF labels fall back to English when present, else the
first available language. No locale framework, no string catalog.

Capability impact: none on capabilities. Every locale must preserve the
capability-gated honesty rule: same guidance substance in all apps,
never recommending an unverified option, first message jargon-free with
one best next action.

Smallest slice: externalize job-flow strings (discovery, selection,
progress, recovery, output), ship one second locale, and run a
keyboard/focus/contrast audit across that flow. Stable codes and
diagnostics stay in English; user copy is translated, protocol is not.

Acceptance:

- Full job flow (supply URL through output save, including one recovery
  path) completes in the second locale with keyboard only.
- Focus is visible and announced; contrast meets the audit bar; no
  pill-shaped progress or badge regressions per shared UI guidelines.
- Capability-gated guidance reads identically in substance across
  locales and apps.
- Unknown-field and version-handshake behavior unchanged; diagnostics
  still carry stable codes.

## What this document does not change

- No `bulk_supported` flip, no runtime multi-output queue, no new
  `JobCommand` (no pause/resume).
- No new encoder, destination mode, storage mode, or processing op.
- No credential, cookie, or header persistence anywhere.
- Contract docs in `docs/` are updated in the same change that changes
  them; this roadmap only points at them.
