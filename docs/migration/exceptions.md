# Migration Exceptions

An exception record must contain a unique ID, affected parity IDs, owner,
rationale, user impact, compensating test, expiry phase/date, and approval.
Empty exception fields are not an approval.

| id | affected_parity_ids | owner | rationale | user_impact | compensating_test | expiry | approval |
|---|---|---|---|---|---|---|---|
| E01 | P07-PACKAGE | owner | wasm-pack browser runs need pinned wasm-pack + installed browsers (absent); native conformance covers the same adapter logic | no browser-engine packaging proof in this environment | `cargo test -p dezoomify-wasm` (26) + `packages/wasm-harness` node suite (16) | phase 13 rehearsal in a browser-equipped runner | owner approval (autonomous run) |
| E02 | P08-E2E, P09-E2E, P12-E2E | owner | Playwright Chromium/Firefox/WebKit E2E + React/Vite wiring need installed browsers (only chromium headless shell present) | E2E proven by node unit matrix only | `cargo xtask test browser/ui/web/extension` node suites (32+6+22+62) | browser-equipped CI lane | owner approval (autonomous run) |
| E03 | P10-EGRESS | owner | native/CLI network I/O emulated (header/scope/cache logic without live HTTP egress) | no live-download proof here | native scenario + redaction + CLI snapshot tests | phase-14 packaged parity on native OS runners | owner approval (autonomous run) |
| E04 | P11-PACKAGE | owner | OS packaging/signing needs Tauri SDK + platform toolchains (absent) | no installers produced | desktop deep-link + capability node tests + config validation | native-OS release lane | owner approval (autonomous run) |
| E05 | P12-STORE, P13-SIGN, P14-CUTOVER, P15-OBSERVE | owner | store submissions, signing keys, production deploys, and prod observation need protected credentials/environments | test-channel candidate only; no production effects | `cargo xtask release plan/build/verify` (test channel) + cutover/postcutover lanes on fixtures state | production cutover with approvals | owner approval (autonomous run) |
| E06 | P03-TRANSCRIPT | owner | legacy-web oracle transcripts are order-racy (concurrent tile insertion); harness defaults to compare-only, rewrite only with UPDATE_TRANSCRIPTS=1 | tree stays clean; drift fails loudly | `writeTranscript` compare gate + ordered lastTile + `git status --porcelain -- testdata/scenarios` | harness stabilization in a browser-equipped runner | owner approval (autonomous run) |
