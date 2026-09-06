# Extension candidate ranking via core (no duplicated heuristics)

Owner prompt (2026-09-06): replace `recognizeFormatHint` heuristics with core
rules; batch sensibly; give visual feedback while discovery runs. Owner
follow-up: implement in small green commits, push, monitor CI.

## Context

- `apps/extension/src/page/page.ts:157` gates discovery on
  `recognizeFormatHint(u) !== "unknown"` from `candidates.ts:47`, a hardcoded
  substring list that drifts from `crates/dezoomify-core` (`DezoomerSpec::
  recognizing/preferring`, registry order in `core/registry.rs`).
- Core already prefers per-URL (`default_registry(url)` puts the matching spec
  first) and `DiscoverySession` decides authoritatively on URL+bytes.
- `extension-unification.md` remaining scope: v1 extension page ships a minimal
  log UI (full shared-UI embed is out of scope here); progress goes through the
  existing visible log + `dataset.outcome` that the E2E asserts on.

## Non-goals

- No full shared-UI embed in the extension page (separate plan).
- No change to scan state machine, permissions, packaging, native handoff.
- No new format support; ranking only reorders what core already knows.

## Phases (one green commit each)

### Phase 1 - Core: pure `rank_candidate_urls` — DONE when `cargo xtask test core` green

- `core/registry.rs`: publish `classify_url(url) -> Option<name>` (first
  builtin whose `prefers` matches) and `rank_candidate_urls(urls) ->
  Vec<{url, format}>`: known first sorted by builtin order, unknowns last in
  first-seen order; stable, total, never filters.
- Unit tests: preferred examples (`info.json`→iiif, `?fif=`→iipimage,
  TileGroup→zoomify), unknown stays last, stability, empty input.

### Phase 2 - WASM: thin `rankCandidates` projection — DONE when `wasm` lane green

- `wasm/discovery.rs`: pure `rank_candidates(urls) -> JSON` over the core
  helper; `lib.rs wasm_api`: `rankCandidates(string)` export (JSON in/out,
  never throws on unknown URLs).
- Native unit tests for projection; no I/O, no bytes retained.

### Phase 3 - Extension: batch rank + sequential discovery + log progress — DONE when `extension` lane green

- `candidates.ts`: delete `recognizeFormatHint`; store keeps `{url}` only
  (validate/dedup/caps/redact stay — host concerns, not duplication).
- `page.ts`: after `runScan` returns raw URLs, one `rankCandidates` call
  (fallback: input order if wasm unavailable), then sequential
  `discover()` in rank order until catalog has images; log
  `trying i/n (format)`, `source`, per-candidate failure lines; keep
  `no-candidate` only when the ranked list is empty or all fail.
- Update `candidates.test.mjs` (drop hint assertions); E2E still verifies the
  saved PNG.

## Risks

- Wasm glue not rebuilt before E2E: `package-store.sh` copies `wasm/` build
  output; run `cargo xtask build web` (or extension) first.
- Dirty tree (`dezoomify-job`, desktop) is unrelated concurrent work: never
  stage/commit it; only the files in these phases.
