# Phase 02: Legacy Audit and Parity Inventory

## Objective

Convert observable legacy behavior into a complete, traceable parity inventory
before implementing replacements. Map every web dezoomer, Rust format/runtime
capability, extension recognition rule, UI workflow, proxy behavior, and known
retirement to deterministic evidence and a future destination owner.

## Non-Goals

- Do not port, redesign, fix, or delete implementation code.
- Do not declare a behavior obsolete merely because only one source has it.
- Do not treat live-site success as deterministic parity evidence.
- Do not accept every `cb13f0b..23c4639` change automatically.
- Do not normalize names, detection precedence, URLs, headers, errors, or tile
  order until each difference has a matrix decision.
- Do not run future `cargo xtask` commands; phase 03 creates the validator.

## Dependencies and Preconditions

- Phases 00 and 01 are complete.
- Source trees are immutable and exactly match web `f7caa07`, Rust destination
  snapshot `23c4639`, and extension `d231dd0`.
- Git object `cb13f0b` is available as the Rust upstream comparison point.
- Baseline deterministic test results are recorded, including any approved
  known failures.

## Exact Source and Destination Paths

| Audit area | Exact sources | Exact destination |
|---|---|---|
| Web registry/order | `migration-sources/dezoomify-web/index.html`, `dezoomers/*.js`, `dezoomers/automatic.js` | `docs/migration/parity-matrix.csv`, `docs/migration/legacy-audit.md` |
| Web scheduling/render/proxy | `zoommanager.js`, `browser-init.js`, `functions/proxy.js`, `node-app/*.js` | Same audit and matrix |
| Web deterministic cases | `migration-sources/dezoomify-web/tests/dezoomers.spec.js`, `proxy-function.spec.js`, `node-cli-smoke.js`, `fixture-server.js`, `fixtures/**`, `images/**` beneath that tests directory | `docs/migration/fixture-inventory.csv` |
| Web live cases | `migration-sources/dezoomify-web/tests/live-compat.spec.js`, `live-playwright.config.js` in that directory | `docs/migration/live-inventory.csv` |
| Rust upstream core | Git paths `cb13f0b:dezoomify-core/src/**`, `cb13f0b:dezoomify-core/tests/**` | Matrix baseline columns |
| Rust candidate snapshot | `migration-sources/dezoomify-rs/dezoomify-core/src/**`, `dezoomify-core/tests/**`, `dezoomify-core/testdata/**` | Matrix candidate columns |
| Rust native runtime | `migration-sources/dezoomify-rs/src/**`, `tests/**`, `testdata/**`, `tiles.yaml` | Runtime parity rows |
| Extension | `migration-sources/dezoomify-extension/url-recognition.js`, `background.js`, `manifest.json`, `test/**` | Extension parity rows |
| Decisions | Source evidence above | `docs/migration/parity-decisions.md` |
| Gate | Phase artifacts | Phase 02 row in `docs/migration/gates.md` |

## Required Matrix Schema

`docs/migration/parity-matrix.csv` must use one row per independently testable
behavior and these columns in this exact order:

```text
id,area,format,behavior,web_evidence,rust_baseline_evidence,rust_snapshot_evidence,extension_evidence,fixture_ids,legacy_result,destination_owner,target_phase,decision,decision_reason,deterministic_test_id,status,notes
```

Allowed `decision` values: `preserve`, `preserve_with_approved_change`,
`retire`, `not_applicable`. Allowed `status` values: `inventoried`, `blocked`,
`covered`, `green`. `retire` requires a decision record and cannot authorize
deletion before phase 14.

## Command Status

### Available Now

```sh
git diff --name-status cb13f0b..23c4639
git log --reverse --oneline cb13f0b..23c4639
cargo test -p dezoomify-core --test dezoomer_coverage
cargo test -p dezoomify-core --test dependency_architecture
npm test
git diff --check
```

Run each test in its source working directory as specified in phase 01.

### Added Later; Do Not Run Yet

```sh
# Added in phase 03 after this phase defines its input schema:
cargo xtask parity validate
cargo xtask parity report
cargo xtask fixtures verify
```

## Numbered Atomic Steps

1. Freeze the audit scope and assign stable IDs.

   Use prefixes `FMT`, `DISC`, `TILE`, `ADAPT`, `HTTP`, `UI`, `CLI`, `OUT`,
   `EXT`, and `SEC`. IDs are uppercase plus a zero-padded number, for example
   `DISC-001`. Never renumber an ID after review; mark superseded rows and link
   replacements.

   Validation:

   ```sh
   git diff --check -- docs/migration/legacy-audit.md docs/migration/parity-matrix.csv
   ```

2. Inventory web registration and automatic precedence in literal source order.

   Record every script loaded by `index.html`; every dezoomer name; URL and
   content patterns; explicit/manual support; follow-up metadata requests;
   recursion/cycle/dedup limits; and the first-match order used by automatic
   detection. At minimum account for generic, Zoomify, Seadragon/Deep Zoom,
   IIIF, Google Arts & Culture, IIPImage, krpano, FSI, TopViewer, XLimage,
   ArcGIS, LizardTech, VLS, Hungaricana, WMTS, and PNAV. Record any source file
   that is intentionally helper-only, such as Arts & Culture crypto.

   Validation:

   ```sh
   git diff --exit-code -- migration-sources/dezoomify-web
   git diff --check -- docs/migration/legacy-audit.md docs/migration/parity-matrix.csv
   ```

3. Inventory each web deterministic case, not just each format.

   Read all cases and standalone tests in `tests/dezoomers.spec.js`. Create rows
   for direct metadata, tile-URL normalization, viewer-page adapters, iframes,
   query/default-port/private-ID handling, automatic precedence, cycle and
   repeated-parent behavior, malformed metadata, signed/encrypted tiles,
   adaptive generic probing, overlap/cropping, proxy targets, assembly pixels,
   and failures. Map each assertion to one or more fixture IDs.

   Validation:

   ```sh
   # workdir: migration-sources/dezoomify-web/tests
   npm test
   ```

   Then verify source immutability:

   ```sh
   git diff --exit-code -- migration-sources/dezoomify-web
   ```

4. Inventory web runtime and UI behavior outside format tests.

   Record input URL/hash initialization, dezoomer selector names/order,
   proxy/cookie controls, progress counters, tile scheduling, error display,
   canvas limits, edge/overlap placement, completion/download behavior,
   retry/skip semantics, and Node proxy/CLI behavior. Distinguish behavior with
   deterministic tests from behavior needing fixtures in phase 03. Record any
   legacy proxy approval prompt or manual retry as historical
   behavior to be replaced by the approved hosted-browser policy: direct
   readable fetch first, automatic restricted-proxy fallback only after a
   classified CORS/network failure for eligible public non-credential resources
   unless the user opted out, visible active transport, and no browser
   credentials, cookies, `Authorization`, or credential headers on either proxy
   hop. Keep extension no-proxy behavior and native cookie-handoff consent as
   separate matrix rows.

   Validation:

   ```sh
   git diff --check -- docs/migration/parity-matrix.csv docs/migration/legacy-audit.md
   ```

5. Inventory Rust upstream baseline `cb13f0b` without checking it out over the
   worktree.

   Use `git ls-tree`, `git show cb13f0b:<path>`, and `git grep <pattern>
   cb13f0b -- <path>`. Record core registry names/order, discovery operations,
   catalog/level/tile model, fixed and adaptive plans, URI rules, error classes,
   limits, and tests. Separately inventory native fetching, request headers,
   cache, retries, throttling, image/level selection, bulk mode, tile decoding,
   progress, and PNG/JPEG/ZIF-TIFF/IIIF output.

   Validation:

   ```sh
   git cat-file -e cb13f0b^{commit}
   git ls-tree -r --name-only cb13f0b -- dezoomify-core src tests testdata tiles.yaml
   git diff --exit-code -- migration-sources/dezoomify-rs
   ```

6. Classify every Rust destination-snapshot delta.

   For every changed path and behavior in `cb13f0b..23c4639`, create a matrix
   row or link it to an existing row. Classify it as a web-parity candidate,
   native refactor, bug fix with evidence, tooling/documentation, or unproven.
   In particular audit added ArcGIS, FSI, Hungaricana, LizardTech, PNAV,
   TopViewer, VLS, WMTS, and XLimage modules and their coverage fixtures. An
   unproven delta remains `blocked` and cannot be copied into phase 04 merely
   because it compiles.

   Validation:

   ```sh
   git diff --name-status cb13f0b..23c4639
   git diff --stat cb13f0b..23c4639
   git diff --check -- docs/migration/parity-matrix.csv docs/migration/parity-decisions.md
   ```

7. Inventory extension behavior at `d231dd0`.

   Record every positive and negative recognition case, query stripping and
   canonicalization rule, retired recognizers, self-URL exclusion, activation
   state, request resource-type filter, per-tab deduplication, badges/icons,
   click/context-menu actions, tab cleanup, handoff URL shape and actual trust
   properties, manifest version, browser permissions, and Chrome/Firefox
   packaging differences. Treat website/deep-link parameters as non-secret
   untrusted input; do not infer a universal signature or future Native
   Messaging identity from a legacy URL. Preserve the
   explicit retired cases for `.pff`, `/viewer/p.xml`, and Rijksmuseum as
   negative behavior unless a reviewed decision says otherwise.

   Validation:

   ```sh
   # workdir: migration-sources/dezoomify-extension
   npm test
   ```

   Then verify source immutability:

   ```sh
   git diff --exit-code -- migration-sources/dezoomify-extension
   ```

8. Create `docs/migration/fixture-inventory.csv`.

   Use columns `fixture_id,source_snapshot,source_path,content_kind,served_url,
   sha256,license_provenance,sensitive,used_by,copy_decision,destination_path`.
   Hash bytes without normalizing line endings. Mark dynamic fixture-server
   routes separately from files. For every approved future copy, set
   `destination_path` below `testdata/scenarios/<id>/`: route definitions in
   `routes.json`, bytes in `payloads/**`, expected transcripts/results in
   `expected/**`, and pixel assertions in `pixels/**`. No other canonical data
   root is allowed. Flag real cookies, tokens, personal data, unclear licenses,
   oversized binaries, and public URLs requiring refresh.

   Validation:

   ```sh
   git diff --check -- docs/migration/fixture-inventory.csv
   git diff --exit-code -- migration-sources
   ```

9. Create `docs/migration/live-inventory.csv`.

   Record live test ID, source path/line, site owner, input URL, expected format,
   minimum assertion, deterministic replacement test ID, diagnostic frequency,
   and owner. Every live row must point to deterministic replacement coverage
   or be `blocked`; no live-only row may become `green`.

   Validation:

   ```sh
   git diff --check -- docs/migration/live-inventory.csv
   ```

10. Record explicit parity decisions.

    In `docs/migration/parity-decisions.md`, use one section per nontrivial
    `preserve_with_approved_change` or `retire` decision. Include matrix IDs,
    old and intended behavior, user impact, compatibility/handoff impact,
    deterministic test update, approval, and earliest removal phase. Missing
    approval means `blocked`. The proxy-policy decision must retire per-attempt
    proxy approval flows, tests, and copy in favor of direct-before-proxy,
    classified-failure, automatic eligible fallback, user opt-out, active-
    transport visibility, ineligible-target rejection, and credential-stripping
    assertions. It must not retire the separate consent gate for extension-to-
    native cookie handoff or the extension's no-proxy invariant.

    Validation:

    ```sh
    git diff --check -- docs/migration/parity-decisions.md docs/migration/parity-matrix.csv
    ```

11. Perform manual matrix consistency checks before automation exists.

    Parse the CSV with Node's built-in facilities only if values are safely
    quoted; otherwise use a reviewed parser script added in phase 03. At this
    point verify at minimum unique nonempty IDs, allowed decisions/statuses,
    evidence for every preserve row, destination owner/phase, and deterministic
    test ID or explicit blocked reason.

    Validation:

    ```sh
    node -e "const fs=require('fs');const s=fs.readFileSync('docs/migration/parity-matrix.csv','utf8');if(!s.startsWith('id,area,format,behavior,'))process.exit(1);if(!s.includes('DISC-')||!s.includes('EXT-'))process.exit(1)"
    git diff --check -- docs/migration
    ```

12. Run the phase-02 deterministic workflow test.

    Select at least one fixture-backed case for every inventoried format and all
    cross-cutting behaviors: automatic precedence, follow/dedup/cycle,
    fixed-grid ordering, adaptive probing, encrypted tile transformation,
    malformed input, header precedence, assembly edges/overlap, extension
    positive/negative recognition, browser proxy-policy decision coverage, and
    cancellation/retry gaps. Run existing
    suites where available and mark missing replacement scenarios `blocked` for
    phase 03.

    Validation:

    ```sh
    # workdir: migration-sources/dezoomify-web/tests
    npm test

    # workdir: migration-sources/dezoomify-rs
    cargo test -p dezoomify-core --test dezoomer_coverage
    cargo test -p dezoomify-core --test dependency_architecture

    # workdir: migration-sources/dezoomify-extension
    npm test
    ```

13. Close the gate only after coverage review.

    A human reviewer must compare the format list, source test names, and Rust
    delta list against the matrix. Record uncovered rows as blockers rather than
    silently narrowing scope.

    Validation:

    ```sh
    git diff --exit-code -- migration-sources
    git diff --check
    git status --short
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P02-WEB-BASELINE` | Legacy Playwright suite against fixture server | All expected baseline outcomes are recorded |
| `P02-CORE-BASELINE` | Rust core coverage test | Registry/discovery/tile cases are recorded |
| `P02-CORE-PURITY-BASELINE` | Rust dependency architecture test | Existing pure-core rule passes or has approved baseline failure |
| `P02-EXT-BASELINE` | Extension recognition and TypeScript tests | Positive, negative, retired, and self-URL cases are recorded |
| `P02-DELTA-COVERAGE` | Map `cb13f0b..23c4639` changed paths | Every behavioral delta links to a parity ID |
| `P02-MATRIX-COVERAGE` | Review every format and cross-cutting area | No retained behavior lacks deterministic test ID or blocker |
| `P02-PROXY-POLICY` | Review legacy proxy controls and approved replacement | Per-attempt approval is retired; direct-first automatic eligible fallback, opt-out, visible transport, credential stripping, and extension no-proxy/native-cookie-consent boundaries have distinct rows |

## Explicit Stop Conditions

- Any source file or behavior cannot be tied to its locked snapshot.
- Automatic detection order or dezoomer naming differs between sources and no
  explicit decision is approved.
- A Rust snapshot delta has no evidence or matrix classification.
- A retained/live behavior lacks a deterministic replacement test plan.
- A fixture has unclear license/provenance, secrets, or sensitive data.
- A `retire` or behavior-change row lacks human approval.
- Matrix IDs are duplicated, missing, or renumbered after review.
- Someone proposes implementation or legacy deletion before inventory closure.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Format-level rows hide edge cases | Use one row per independently asserted behavior. |
| Source disagreement is resolved accidentally | Require explicit decisions with old/new behavior and approval. |
| Destination-only work bypasses review | Classify every `cb13f0b..23c4639` path and behavior. |
| Dynamic fixture behavior is omitted | Inventory fixture-server routes as first-class fixtures. |
| Live tests create false confidence | Require deterministic replacement IDs for every live case. |
| CSV becomes unmaintainable | Stable IDs, fixed schema, deterministic validator in phase 03. |

## Rollback Guidance

This phase changes only audit documents and the gate ledger. Reverse only hunks
created in `docs/migration/legacy-audit.md`, `parity-matrix.csv`,
`fixture-inventory.csv`, `live-inventory.csv`, `parity-decisions.md`, and the
phase 02 gate row. Do not modify or delete source fixtures. Preserve reviewed
IDs when correcting content; mark rows superseded rather than reusing IDs. If
an install generated ignored files, remove only the known generated directory
after confirming it is untracked and phase-created; never use `git clean`.

## Deliverables

- Complete `docs/migration/legacy-audit.md`
- Stable-schema `docs/migration/parity-matrix.csv`
- `docs/migration/fixture-inventory.csv`
- `docs/migration/live-inventory.csv`
- Approved `docs/migration/parity-decisions.md`
- Full classification of `cb13f0b..23c4639`
- Phase-02 gate record and list of phase-03 fixture blockers

## Completion Checklist

- [ ] Every web dezoomer and automatic-order rule is inventoried.
- [ ] Every deterministic web case and dynamic fixture route is mapped.
- [ ] Rust core and native behaviors at `cb13f0b` are inventoried.
- [ ] Every destination-only Rust snapshot delta is classified.
- [ ] Extension recognition, lifecycle, permissions, and handoffs are mapped.
- [ ] Legacy proxy approval/manual-retry behavior is explicitly mapped to the
  approved automatic eligible fallback policy and replacement assertions.
- [ ] Every live case has deterministic replacement coverage or a blocker.
- [ ] Every changed/retired behavior has explicit approval.
- [ ] No source snapshot changed.
- [ ] All baseline suites were rerun and results recorded.
- [ ] No stop condition remains unresolved.
- [ ] Phase 02 is marked complete in the gate ledger.
