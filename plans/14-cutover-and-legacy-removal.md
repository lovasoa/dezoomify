# Phase 14: Cutover And Legacy Removal

## Objective

Promote the unified website, CLI, desktop application, native host, and browser extensions in controlled stages, prove installed/packaged parity against deterministic and approved live workflows, preserve current/N-1 compatibility during store and updater lag, and only then remove legacy implementation code and obsolete automation.

This phase is intentionally gate-heavy. Passing source-level tests is insufficient: parity must be demonstrated using the exact signed artifacts and deployed website digest intended for production. Legacy deletion is the final operation after rollback has been rehearsed and rollout acceptance windows have passed.

## Non-Goals

- Do not add new formats, UI features, protocols, permissions, or release platforms during cutover.
- Do not fix parity failures by weakening tests, widening proxy/extension permissions, or bypassing signatures.
- Do not force browser-store review timing or require all stores/updaters to publish simultaneously.
- Do not delete legacy tags, release assets, issue history, audit records, licenses, attribution, or migration provenance.
- Do not remove N-1 protocol scenarios, compatibility integrations, rollback packages, or current/N-1 update metadata.
- Do not remove legacy source before every packaged parity and rollback gate below is satisfied.

## Dependencies

- Phase 13 completed a full release rehearsal with verified signatures, SBOMs, provenance, cleanup, and no production effects.
- Production signing identities, store listings, website environment, updater channels, release permissions, support channels, monitoring, privacy text, and incident contacts are approved.
- A release candidate was built once from a reviewed commit, signed, and verified by digest; no rebuild is allowed during promotion.
- Deterministic scenario manifests and golden hashes are frozen for the cutover candidate.
- Canonical shared assets remain under `crates/fixture-server/`,
  `crates/xtask/`, `testdata/scenarios/`, `crates/dezoomify-job/`, and
  `packages/protocol-ts/`; cutover must not restore or bless parallel legacy
  layouts.
- Legacy website, extension, and native releases remain available and operational at phase start.
- Rollback owners are available during each acceptance window.

## Exact Paths

Modify these paths for cutover records/configuration:

- `release/cutover.toml`
- `release/compatibility.toml`
- `docs/cutover-runbook.md`
- `docs/rollback-runbook.md`
- `docs/migration.md`
- `docs/support.md`
- `README.md`
- `.github/workflows/website-deploy.yml`
- `.github/workflows/release-publish.yml`
- `.github/workflows/store-submit.yml`
- updater/store channel metadata generated through existing release tooling
- `crates/xtask/src/cutover.rs`
- `crates/xtask/src/main.rs`
- `docs/migration/gates.md` for the phase-14 execution record only
- `artifacts/phase-14/**` for ignored local evidence

Only after the deletion gate in step 19 may this phase delete:

- `crates/fixture-server/tests/legacy-web/` after its parity role has been replaced by packaged parity
- destination-side legacy compatibility modules/routes, if any, whose exact paths are enumerated and approved in `artifacts/phase-14/deletion-inventory.json`
- obsolete compatibility scripts explicitly listed in `artifacts/phase-14/deletion-inventory.json`
- obsolete workflows/configuration that target only removed source trees

The immutable `migration-sources/dezoomify-rs/`, `migration-sources/dezoomify-web/`, and `migration-sources/dezoomify-extension/` trees remain read-only evidence through phase 15; retiring their deployed legacy apps is not permission to edit or delete these snapshots. Do not delete protocol N-1 scenarios, provenance/licenses, release rollback assets, or scenario-local expected transcripts/payloads used by packaged parity.

## Command Availability

- Available before this phase: `cargo xtask ci <lane>`, the canonical build and test targets from phases 08-13, both `cargo xtask protocol generate` and `cargo xtask protocol check`, `cargo xtask parity validate`, and `cargo xtask release plan`, `cargo xtask release build`, and `cargo xtask release verify --plan <path> --artifacts <path>`; protected signing, deployment, store validation, and installer workflows also exist.
- Added during step 3: the `cargo xtask release verify --candidate release/cutover.toml` candidate mode.
- Added during step 5: the `cargo xtask parity validate --packaged --candidate release/cutover.toml` packaged mode, including `--no-rebuild`; step 6 adds its `--security` mode.
- Added during step 7: the `cargo xtask test scenario --suite cutover-compatibility --packaged` suite.
- Added during step 19: the internal `cargo xtask ci cutover-deletion-gate` lane.
- Added during step 21: the internal `cargo xtask ci cutover-clean-tree` lane.
- Added during step 16: `cargo xtask test live --packaged --low-volume`.
- Commands that query production deployment/store/update state become available only after authorized credentials and protected environments are active; use fixture state files before that point.

## Sequential Implementation Steps

1. Freeze cutover scope. Create `release/cutover.toml` containing candidate version, source commit, signed artifact digests, website immutable deployment digest, protocol range, current/N-1 peer versions, rollout order, acceptance-window durations, owners, stop thresholds, and rollback artifact digests. Do not include credentials.

   **Validate immediately:** parse and cross-check against the verified phase-13 release plan. Any digest/version mismatch stops cutover.

2. Write cutover and rollback runbooks with exact commands, owners, expected outputs, independent rollback procedures for website, updater, GitHub release, Chromium store, Firefox store, protocol/native-host registration, and support messaging. Include a decision log template and UTC timestamps.

   **Validate immediately:** conduct a read-only tabletop in which Chromium is delayed, Firefox is current, desktop updater is paused, and metadata CORS proxy is degraded. Each app must have a safe independent action.

3. Add the `cargo xtask release verify --candidate release/cutover.toml` mode. It reads `release/cutover.toml`, downloads or locates artifacts by immutable digest, runs public-key signature/provenance/SBOM/inventory checks, verifies source commit and protocol capability matrix, and rejects rebuilt or extra artifacts.

   **Validate immediately:** run `cargo xtask release verify --candidate release/cutover.toml`, then rerun it with `--artifact <tampered-copy>`. Candidate passes and tamper fails. This candidate verification mode and its `--artifact` override become available only after this step.

4. Install exact candidate artifacts on clean Windows, macOS, and Linux test systems. Install CLI archives, desktop bundle, native host registration, protocol registration, Chromium extension package, and Firefox extension package into fresh OS/browser profiles. Deploy the exact website candidate to a non-production immutable preview.

   **Validate immediately:** inventory installed binary hashes, extension IDs/versions/permissions, native-host manifest paths, protocol handlers, updater public keys, website asset hashes, and proxy config. Compare every item with cutover config.

5. Add the `cargo xtask parity validate --packaged --candidate release/cutover.toml` mode. It must run deterministic scenarios
   from `testdata/scenarios/` through installed artifacts, not `cargo run`, Vite
   dev server, unpackaged Tauri, or source extension builds. Cover discovery
   formats, image/level choices, output encoders, direct website path, automatic
   metadata CORS proxy only after classified CORS/network failure for eligible
   public non-credential metadata requests when proxy opt-out is disabled (tiles
   never use the proxy), ordinary
   image display with tainted-canvas guards/save guidance, browser-session
   extension fetch with no proxy, CLI cache/resume, desktop large-image output,
   explicit-action one-click scans, and native handoff.

   **Validate immediately:** run `cargo xtask parity validate --packaged --candidate release/cutover.toml` on all supported OS/browser combinations and emit `artifacts/phase-14/packaged-parity.json`. Every required decoded pixel/dimension/MIME assertion, deterministic-encoder digest, request-policy assertion, listener cleanup, registration cleanup, and exit/result class must pass. Browser-native encoder bytes are not required to match across engines. This packaged parity mode becomes available only after this step.

6. Run `cargo xtask parity validate --packaged --candidate release/cutover.toml --security`. Re-run visible tainted-display assembly,
   controlled readback `SecurityError`, `originClean = false`, displayed save
   guidance, and zero app save/read/process/hash/`toBlob`/`toDataURL`
   attempts; verify website/deep links remain untrusted, unsigned, bounded,
   non-secret, and confirmed, while browser enforcement of Native Messaging
   allowed extension IDs authenticates the sender and challenge/nonce only binds
   its one-use session/replay defense; website direct-before-proxy ordering,
   automatic eligible fallback, opt-out, visible transport, credential
   omission/stripping, and proxy SSRF/redirect denials; extension
   no-proxy direct-fetch assertion; explicit-action-only scan with
   listener-before-exactly-one-reload,
   finite settle/deadline, and no extension-page rearm; host-permission denial; Native
   Messaging consent/scope/redaction; protocol injection; updater tamper; remote
   Tauri navigation; and secret scans against packaged artifacts.

   **Validate immediately:** `cargo xtask parity validate --packaged --candidate release/cutover.toml --security` must produce `artifacts/phase-14/packaged-security.json`, which must
   contain zero critical/high findings and no unexplained medium findings. Cookie
   handling must show explicit consent, scope, memory-only/no-intentional-
   persistence behavior, and best-effort overwrite of owned buffers. Canary
   scans must find no intentional persistence or artifact/diagnostic leakage;
   they do not prove universal memory zeroization.

7. Add the `cargo xtask test scenario --suite cutover-compatibility --packaged` suite. Test website/extension/desktop/host combinations for current/current, current/N-1, N-1/current, store-delayed Chromium, store-delayed Firefox, paused desktop updater, host registration from prior installer, and incompatible N-2/future. Consume installed packages or immutable compatibility scenarios.

    **Validate immediately:** run `cargo xtask test scenario --suite cutover-compatibility --packaged`; current and N-1 baseline workflows must pass without synchronized update. Unsupported combinations must show guided update/manual flows with no cookie collection or malformed handoff. This scenario suite becomes available only after this step.

8. Rehearse rollback with exact candidate and previous production artifacts. Roll preview website forward/back, stage/unstage local updater metadata, install candidate desktop over N-1 then roll application back according to supported policy, switch extension scenarios between N-1/current, repair native-host manifests, and preserve user output/settings.

   **Validate immediately:** run `cargo xtask test scenario --suite cutover-compatibility --packaged` after each rollback. Record RTO, commands, retained data, registration state, and artifact digests in `artifacts/phase-14/rollback-rehearsal.json`.

9. Publish the verified GitHub release and package-manager metadata as non-default/draft where supported. Attach exact signed artifacts, checksums, signatures, SBOM, provenance, migration notes, compatibility range, and rollback link. Do not activate updater or production website yet.

   **Validate immediately:** download all public/draft assets anonymously, verify digests/signatures, install in clean systems, and rerun a packaged smoke subset. Stop if hosting rewrites or truncates assets.

10. Submit exact verified extension packages independently to Firefox and Chromium stores. Record submission IDs, package digests, requested permissions, review state, and expected lag. Keep the legacy published versions available until each new package is independently approved and smoke-tested.

    **Validate immediately:** compare store-submitted package digest/inventory to cutover candidate. If a store requires source changes, stop; create a new candidate/version and restart verification rather than editing the submitted artifact ad hoc.

11. Deploy the exact website artifact to production with proxy restrictions and feature offers pinned to currently published peer capabilities. Do not advertise extension/native-only current features while stores/updater remain N-1. Preserve the previous immutable deployment for immediate rollback.

    **Validate immediately:** run a direct browser fetch, classified CORS/network failure
    followed by automatic eligible metadata proxy success (metadata only, never
    tiles), proxy opt-out, credential-
    bearing target rejection, proxy denial, visible active transport, visible
    tainted-canvas/save-guidance/no-JavaScript-save, CSP, privacy headers,
    download links, and N-1 handoff workflows from external clean browsers.
    Assert no proxy request precedes classified failure and neither proxy hop
    carries cookies, `Authorization`, browser credentials, or user credential
    headers. Compare decoded pixels/dimensions/MIME across browsers, exact bytes
    only for the repository-owned deterministic encoder, and deployed asset
    digest to cutover config.

12. Observe the website acceptance window defined in `release/cutover.toml`. Monitor coarse availability/error/abuse metrics that contain no source URLs/cookies, support reports, proxy limits, and client-side fatal error counts. Do not shorten the window without a recorded emergency decision.

    **Validate immediately:** evaluate thresholds at fixed UTC checkpoints and append signed decision records. Any stop threshold triggers website rollback only; other apps remain unchanged unless affected.

13. Promote the desktop release and signed updater metadata in stages. Start with the smallest channel/percentage, retain previous metadata and packages, and increase only after installed update, fresh install, registration repair, deep link, native host, N-1 extension handoff, and large-image workflows pass.

    **Validate immediately:** at each stage anonymously fetch metadata/package, verify signatures/digest, update N-1, fresh-install current, and run deterministic smoke. Pause on threshold breach without changing store submissions.

14. After each extension store approves the candidate, install it from that real store in a clean profile and execute one-click active-tab scan, authenticated origin-clean save, permission decline/revoke, website handoff, current/N-1 native handoff, and cleanup. Keep per-store rollout states independent.

    **Validate immediately:** record actual store-delivered version/ID/permissions/package where retrievable and workflow results. A Firefox pass does not authorize Chromium cutover, or vice versa.

15. Update website capability offers only after the relevant peer version is actually available to users. During mixed versions, continue baseline N-1 behavior. Do not block old extension users from manual website/native workflows.

    **Validate immediately:** rerun lag matrix against observed store/updater states. Generated/served capability flags must match reality, not planned version.

16. Extend `cargo xtask test live` with its packaged low-volume mode, then run
    `cargo xtask test live --packaged --low-volume` through website direct/
    proxy as applicable, store extensions, packaged CLI, and desktop. Website
    proxy examples must be public and non-credential; authenticated website
    resources are ineligible. Use an explicitly approved authenticated test
    account only for extension/native paths if policy allows; redact all reports.
    Deterministic parity remains authoritative.

    **Validate immediately:** classify failures as source drift, app regression, access policy, or transient network. App regressions stop cutover; source drift creates follow-up without weakening deterministic tests.

17. Complete the full acceptance windows for website, desktop/updater, Firefox, and Chromium independently. Resolve or explicitly accept every support/security issue. Confirm previous production artifacts remain retrievable and signatures valid.

    **Validate immediately:** produce `artifacts/phase-14/acceptance.json` with owner approval, timestamps, metrics thresholds, open issues, and rollback readiness for each app.

18. Build a deletion inventory before touching legacy code. List every file/path, license/attribution requirement, useful fixture, documentation link, workflow, deploy hook, release script, branch protection check, package reference, submodule/snapshot relation, and replacement path. Classify each as delete, preserve, archive externally, or migrate.

    **Validate immediately:** compare repository searches and CI/deployment configuration against `artifacts/phase-14/deletion-inventory.json`. No unclassified legacy reference may remain.

19. Add the internal `cargo xtask ci cutover-deletion-gate` lane. It must require: verified candidate digests; all packaged parity/security gates; current/N-1 matrix; successful rollback rehearsal; all app acceptance records; store-delivered smoke for every supported store; updater/website acceptance; zero blocking incidents; deletion inventory; and explicit owner approvals. It must fail closed on missing/stale evidence.

    **Validate immediately:** run `cargo xtask ci cutover-deletion-gate` once with one copied evidence file removed and verify failure, restore it from the existing artifact (without broad git restore), then run successfully. This CI lane becomes available only after this step.

20. Only after step 19 passes, retire deployed legacy routes/artifacts and remove destination-side legacy implementations, `crates/fixture-server/tests/legacy-web/`, and obsolete legacy-only automation according to the deletion inventory. Keep all three `migration-sources/` snapshots byte-identical through phase 15. Preserve licenses, attribution, canonical scenario-local expected transcripts and payloads under `testdata/scenarios/`, historical release links, protocol N-1 scenarios, rollback artifacts, and migration documentation. Use targeted file deletions; never recursively delete a parent containing unclassified files.

   **Validate immediately after each top-level deletion:** run `git status --short`, inspect deleted path list against inventory, search for broken references, and run the directly affected canonical test target. After all deletions run `cargo xtask ci local` and `cargo xtask parity validate --packaged --candidate release/cutover.toml --no-rebuild` against already-built candidate artifacts.

21. Add the internal `cargo xtask ci cutover-clean-tree` lane. Fail on references/imports/workflows to deleted paths, old production deployment endpoints where forbidden, obsolete package names, duplicate implementations, stale extension instructions, old proxy routes, or undocumented migration remnants. Allow historical links only through an explicit allowlist with rationale.

    **Validate immediately:** run `cargo xtask ci cutover-clean-tree` from a fresh checkout/archive of the resulting tree; it must cover tree verification, docs links, workspace metadata, lockfile checks, generated checks, and all tests. This CI lane becomes available only after this step.

22. Update root README, migration/support docs, install links, security/privacy links, package names, and architecture references to the unified apps. Explain legacy release access, immutable snapshot evidence, and minimum compatible versions. Do not rewrite history or remove credits.

    **Validate immediately:** run docs checks and manually follow every download/store/protocol/help link in a clean browser without credentials.

23. Run `cargo xtask parity validate --packaged --candidate release/cutover.toml --no-rebuild` after deletion. This proves source cleanup did not alter deployed binaries and that repository tests/docs still describe them accurately. Then run `cargo xtask release build --plan <json> --clean` and compare normalized output to the original candidate.

    **Validate immediately:** installed artifact tests remain green; clean rebuild normalized hashes match; any mismatch stops completion and must be explained before proceeding.

24. Append only the phase-14 row in `docs/migration/gates.md`, linking signed candidate, installed packaged parity/security, compatibility lag, rollback, acceptance, deletion-gate, deletion inventory, clean-tree, and source-snapshot immutability evidence.

    **Validate immediately:** run `cargo xtask sources verify` and `git diff --exit-code -- migration-sources`, then `git diff --check -- docs/migration/gates.md plans/14-cutover-and-legacy-removal.md`.

## Deterministic User Workflows

### Packaged Cross-App Parity

1. Install exact signed CLI/desktop/native-host artifacts on a clean OS image.
2. Install exact candidate Chromium and Firefox packages in clean profiles.
3. Open the immutable website candidate.
4. Run canonical scenarios for direct browser-fetch saves, direct metadata
   failure followed by automatic eligible metadata proxy success, CORS-blocked
   tiles falling back to ordinary image display or a handoff suggestion (never a
   proxy tile request), proxy opt-out, credential-
   stripping/ineligible-target rejection, ordinary tainted display/save guidance,
   extension browser-session
   saves, CLI cache resume, desktop large streaming output, and consented cookie
   native handoff.
5. Compare decoded browser pixels/dimensions/MIME, deterministic-repository-
   encoder hashes, native output hashes, and request transcripts with the frozen
   scenario manifest.
6. Verify listener/process/profile/registration cleanup.
7. Repeat after production promotion using production-delivered artifacts, not development builds.

### Store/Updater Lag

1. Keep Chromium at N-1 while Firefox and website are current.
2. Verify Chromium N-1 can still send baseline handoff and website does not offer unsupported current-only behavior.
3. Keep desktop at N-1 while extension is current; verify baseline native handoff succeeds.
4. Pause desktop updater and verify website/extension retain manual and N-1 paths.
5. Promote each independently and rerun only that app plus compatibility matrix.

### Rollback

1. Promote the candidate website preview to the test production alias.
2. Trigger a deterministic stop threshold fixture.
3. Restore the previous immutable alias without rebuilding.
4. Verify prior website plus current/N-1 extension/native workflows.
5. Repeat independently for updater metadata and extension fixture version.
6. Confirm user output/cache/settings remain intact.

### Legacy Deletion Gate

1. Run `cargo xtask ci cutover-deletion-gate` before deletion and archive its signed evidence summary.
2. Remove only inventory-approved destination-side legacy paths and `crates/fixture-server/tests/legacy-web/`; do not modify `migration-sources/`.
3. Run `cargo xtask ci cutover-clean-tree`.
4. Run `cargo xtask ci local` and `cargo xtask parity validate --packaged --candidate release/cutover.toml --no-rebuild`.
5. Clean-build and compare normalized artifacts with candidate.
6. Search documentation/workflows/imports for each deleted path and approved old endpoint.

## Stop Conditions

- Stop if any signed/deployed/store artifact digest differs from the verified candidate.
- Stop if any packaged parity/security test fails, even when source tests pass.
- Stop if current/N-1 compatibility fails under actual or simulated store/update lag.
- Stop if rollback cannot be completed within the documented process or loses user data.
- Stop if a store requires artifact mutation; issue a new version and restart candidate verification.
- Stop if acceptance evidence is missing/stale, thresholds are exceeded, or a blocking incident is open.
- Stop before legacy deletion unless `cargo xtask ci cutover-deletion-gate` passes completely.
- Stop deletion if an unclassified reference/license/fixture/workflow is found.
- Stop if any tracked byte under `migration-sources/` changes; phase 14 retires legacy apps but preserves source evidence.

## Risks And Mitigations

- **Irreversible legacy removal:** delayed deletion gate, explicit inventory, history/provenance retention, and targeted deletes.
- **Store/update asynchrony:** independent promotion states, current/N-1 protocol support, capability gating, and manual fallback.
- **Candidate differs from deployed artifact:** immutable digests and public verification at every transition.
- **Rollback breaks registration/data:** rehearsed ownership-safe installers and data-preserving rollback tests.
- **Proxy production abuse:** acceptance thresholds, restricted policy tests, independent website rollback.
- **Hidden packaged-only failure:** installed artifact parity on native OS/browser/store-delivered packages.
- **Documentation dead ends:** link validation and preserved historical release guidance.

## Safe Rollback

Before legacy deletion:

1. Roll back only the affected app to its previous immutable signed artifact/config.
2. Pause updater/store/website promotions independently.
3. Preserve logs/evidence, revoke compromised artifacts if required, and follow incident response.
4. Do not rebuild under the same version.

After legacy deletion but before completion:

1. Reintroduce only inventory-listed destination legacy files from the reviewed pre-deletion commit using a targeted patch or path-specific history extraction; immutable migration snapshots should already be unchanged.
2. Preserve all unrelated/concurrent files and root manifest changes.
3. Restore only obsolete workflow references required for the rollback target.
4. Re-run `cargo xtask ci cutover-clean-tree` and `cargo xtask parity validate --packaged --candidate release/cutover.toml`.
5. Never use `git reset --hard`, broad checkout, force-push, broad clean, or production artifact overwrite.

## Artifacts

- `artifacts/phase-14/packaged-parity.json`
- `artifacts/phase-14/packaged-security.json`
- `artifacts/phase-14/compatibility-matrix.json`
- `artifacts/phase-14/rollback-rehearsal.json`
- `artifacts/phase-14/acceptance.json`
- `artifacts/phase-14/deletion-inventory.json`
- `artifacts/phase-14/deletion-gate.json`
- Store submission/delivery records and digests
- Website/updater promotion records
- Installed bundle inventories and cleanup reports
- Redacted live compatibility report

## Completion Checklist

- [ ] Cutover config binds reviewed source and every signed/deployed artifact digest.
- [ ] Exact installed artifacts pass deterministic functional and security parity.
- [ ] Website direct/automatic-eligible-proxy/opt-out/credential-stripping/
  ordinary-display/taint workflows pass in
  production configuration, including visible assembly, controlled
  `SecurityError`, no app programmatic save attempt, and save guidance.
- [ ] Chromium and Firefox store-delivered builds pass active-tab and origin-clean workflows.
- [ ] CLI/desktop/native host pass cache, large-image, registration, and cookie-scope workflows.
- [ ] Current/N-1 works throughout actual store/updater lag.
- [ ] Independent rollback is rehearsed for every release channel.
- [ ] Acceptance windows and thresholds are complete with owner approval.
- [ ] Deletion inventory classifies every legacy file/reference/license/fixture/workflow.
- [ ] `cargo xtask ci cutover-deletion-gate` passed before any legacy deletion.
- [ ] Only inventory-approved legacy code/automation was removed.
- [ ] All three `migration-sources/` trees remain byte-identical and pass `cargo xtask sources verify`.
- [ ] Licenses, attribution, protocol N-1 scenarios, rollback assets, and history remain.
- [ ] Clean-tree, docs, full CI, post-deletion packaged parity, and clean rebuild gates pass.
- [ ] The phase-14 migration gate row links packaged, rollback, deletion, and source-immutability evidence.
