# Phase 13: CI, Security, And Signed Release

## Objective

Turn all deterministic phase gates into least-privilege CI and produce reproducible, signed, attestable release candidates for the website, CLI, desktop installers/updater, native host, and Chromium/Firefox extensions. Separate build, signing, publishing, deployment, and store submission so compromise or a failed platform cannot publish unrelated artifacts.

Release compatibility must tolerate extension-store and desktop-updater lag. The release manifest and generated capability matrix must guarantee current and N-1 handoff compatibility before any public rollout.

## Non-Goals

- Do not cut production traffic or delete legacy projects.
- Do not auto-submit to browser stores until dry-run packages and human review pass.
- Do not expose signing keys to pull requests, forks, ordinary CI, local artifacts, or reusable workflows with untrusted inputs.
- Do not sign arbitrary workflow artifacts by path alone.
- Do not rely on live websites as blocking deterministic CI.
- Do not claim bit-for-bit reproducibility for platform signing wrappers whose timestamps are externally injected; compare normalized unsigned payloads and signed inventories instead.

## Dependencies

- Phases 08-12 are green and expose stable xtask gates.
- `crates/fixture-server/`, `crates/xtask/`, `testdata/scenarios/`,
  `crates/dezoomify-job/`, and `packages/protocol-ts/` are the canonical test,
  orchestration, job, and TypeScript protocol paths; release automation must not
  introduce parallel legacy layouts.
- Repository governance defines protected environments, required reviewers, release branches/tags, ownership, incident contacts, and secret names.
- Updater signing (free self-generated keypair), GitHub release, Mozilla AMO, Chrome Web Store, website hosting, and optional package-manager credentials are provisioned in separate protected environments. Paid signing (Apple Developer ID/notarization, Azure Trusted Signing) is out of plan: recurring fees are incompatible with a free project, so desktop installers ship unsigned.
- Release identity, package IDs, extension IDs, native-host name, protocol scheme, update URLs, store URLs, and public keys are final and generated from reviewed config.
- Current and N-1 protocol/capability scenarios pass all app combinations.

## Exact Paths

Create or modify only:

- `.github/workflows/ci.yml`
- `.github/workflows/security.yml`
- `.github/workflows/live-compat.yml`
- `.github/workflows/release-build.yml`
- `.github/workflows/release-sign.yml`
- `.github/workflows/release-publish.yml`
- `.github/workflows/website-deploy.yml`
- `.github/workflows/store-submit.yml`
- `.github/dependabot.yml`
- `.github/CODEOWNERS`
- `.github/release.yml`
- `deny.toml`
- `release/config.toml`
- `release/targets.toml`
- `release/channels.toml`
- `release/compatibility.toml`
- `release/README.md`
- `artifacts/release/<version>-<channel>.json`
- `dist/<version>-<channel>/**`
- `release/checksums/.gitkeep`
- `generated/release-capabilities.json`
- `generated/update-public-keys.json`
- `docs/security.md`
- `docs/releases.md`
- `docs/incident-response.md`
- `docs/privacy.md`
- `crates/xtask/src/ci.rs`
- `crates/xtask/src/release.rs`
- `crates/xtask/src/main.rs`
- `docs/migration/gates.md` for the phase-13 execution record only
- `artifacts/phase-13/**` for ignored local evidence
- lockfiles/toolchain pins only where required

Do not change app behavior in this phase except minimal fixes required to make declared gates truthful; send larger fixes back to the owning phase.

## Command Availability

- Available before this phase: all applicable canonical build and test targets from phases 08-12, both `cargo xtask protocol generate` and `cargo xtask protocol check`, `cargo xtask fixtures verify`, and `cargo xtask parity validate` with its documented flags.
- Added during step 3: the `cargo xtask protocol generate --release-capabilities` mode.
- Added during step 5: `cargo xtask ci local` and lane-specific `cargo xtask ci <lane>`.
- Added during step 10: `cargo xtask test live`, including its `--dry-run --fixtures` mode.
- Added during step 11: `cargo xtask release plan` and `cargo xtask release build`
  (including its `--clean` mode).
- Added during step 14: `cargo xtask release verify --plan <path> --artifacts <path>`.
- Added during step 5: `cargo xtask test all`.
- Signing and submission commands become available only in protected CI after their workflow steps and credentials exist; local commands must refuse production signing.

## Sequential Implementation Steps

1. Run every phase gate locally and save versions, duration, artifact sizes, generated hashes, and failures in `artifacts/phase-13/preflight.json`. Verify the worktree has no unreviewed generated drift and migration snapshots remain unchanged.

   **Validate immediately:** run formatting, clippy, Cargo tests, root pnpm lint/typecheck, `cargo xtask test browser`, `cargo xtask test web`, `cargo xtask test native`, `cargo xtask test desktop`, `cargo xtask test extension`, `cargo xtask test native-messaging`, and `cargo xtask protocol check`. Stop before CI authoring if any gate is flaky or requires internet.

2. Create `release/config.toml`, `targets.toml`, `channels.toml`, and `compatibility.toml` as the single reviewed release inventory. Include artifact names, Rust targets, OS runners, bundle IDs, extension IDs, protocol range, minimum peer versions, update/store channels, signing identity labels, and publish destinations. Never include secret values.

   **Validate immediately:** add parser/schema tests and run `cargo test -p xtask release_config`. Reject duplicate names, missing hashes, wildcard extension IDs, non-HTTPS production URLs, protocol range without N-1, and unknown targets.

3. Add the `cargo xtask protocol generate --release-capabilities` mode to generate release capabilities and updater public-key files from canonical config/protocol. App builds must consume only generated public data. Private signing keys are referenced by CI secret name and never generated or checked in.

   **Validate immediately:** run `cargo xtask protocol generate --release-capabilities` twice and `cargo xtask protocol check`. Compare app-embedded capabilities against the release matrix. This generation mode becomes available only after this step.

4. Create CI lane definitions: Rust core/protocol/job; Wasm/browser runtime;
   shared UI/website/proxy security; native/CLI on Linux/macOS/Windows; desktop
   on native OS matrix; extension unit/package; Chromium E2E; Firefox stable/ESR
   E2E; native handoff; generated/reproducibility; license/advisory/security.
   Explicitly exercise `packages/protocol-ts` against current and N-1 protocol
   scenarios. The website lane must assert direct-before-proxy ordering, no
   proxy before classified CORS/network failure, automatic eligible public non-
   credential metadata fallback, user opt-out, visible active transport, ineligible-
   target rejection, and credential omission/stripping on both proxy hops. The
   extension lane must assert zero proxy calls. Assign timeouts and
   artifact retention explicitly.

   **Validate immediately:** lint workflow YAML and map every phase completion command to at least one required lane in `artifacts/phase-13/gate-map.json`. No required gate may exist only in documentation.

5. Add `cargo xtask ci <lane>` dispatch with a fixed allowlist, `cargo xtask ci local` for all locally applicable lanes, and `cargo xtask test all` for the full deterministic aggregate. Commands must not evaluate shell input. CI workflows call these commands rather than duplicating long command sequences.

   **Validate immediately:** run each locally applicable lane, an unknown-lane rejection, and `cargo xtask ci local`. This command becomes available only after this step.

6. Configure CI permissions and triggers. Pull requests use read-only contents and no secrets. Set explicit top-level and job permissions, pinned action commit SHAs, concurrency cancellation for superseded branches, job timeouts, protected release environments, and no `pull_request_target` execution of contributor code. Separate live/manual workflows from deterministic required checks.

   **Validate immediately:** run an action-policy linter that rejects mutable action tags, write permissions in PR lanes, secret contexts in fork jobs, unbounded timeouts, and release jobs outside protected environments.

7. Add cache policy. Cache immutable dependency/build inputs keyed by lockfiles/toolchains/target; never cache browser profiles, native-host manifests, cookies, signing material, updater packages before verification, or arbitrary test artifacts. Restore caches without executing cache-provided scripts before integrity checks.

   **Validate immediately:** inspect cache path allowlist and run a poisoned-cache simulation for generated files; `cargo xtask protocol check` and app generation checks must catch divergence.

8. Add dependency and source security gates: `cargo deny`, Rust advisory audit, `pnpm audit` according to reviewed severity policy, license allowlist, lockfile integrity, forbidden dependency boundary checks, secret scanning, SAST, unsafe-code inventory, and generated artifact checks. Pin external tools by version/digest and document update cadence.

   **Validate immediately:** seed test fixtures with known fake violations outside ignored fixture scope and prove each scanner fails; remove only those seeds with a targeted patch. Ensure real credential patterns are not printed by scanners.

9. Add fuzz/property jobs for protocol framing, Native Messaging lengths, URL/proxy validation, redaction, discovery parsers, and handoff parsing. Keep bounded PR smoke durations and longer scheduled runs. Corpus artifacts must be sanitized before upload.

   **Validate immediately:** run smoke fuzz targets locally for the documented duration and replay corpus. Verify crashes cannot upload cookie/header canaries.

10. Add a scheduled/manual `cargo xtask test live` workflow isolated from required deterministic CI. Use no source-site credentials, low request rates, explicit user agent, bounded targets, and failure issue artifacts containing redacted URLs. A live failure must alert but not silently alter support or block emergency releases.

    **Validate immediately:** run `cargo xtask test live --dry-run --fixtures` and verify rate limiting, redaction, and artifact format. Do not run the public target list during implementation unless explicitly approved. This test target becomes available only after this step.

11. Implement `cargo xtask release plan <version> <channel>`. Validate clean generated state, semver/tag/channel, changelog input, protocol compatibility, version consistency across Cargo/pnpm/Tauri/extension manifests, target inventory, current/N-1 matrix, and required credentials by protected CI secret names. Emit an immutable JSON plan with source commit and expected unsigned artifacts.

    **Validate immediately:** run `cargo xtask release plan <version> <channel>` for valid stable/beta plans plus dirty generated state, mismatched versions, missing target, N-1 break, tag mismatch, and unknown channel. This command becomes available only after this step.

12. Implement `cargo xtask release build --plan <json>`. Build locked/offline where feasible, produce CLI archives, desktop unsigned bundles, native host, Chromium ZIP, Firefox XPI input, website asset tarball, updater payload inputs, SBOMs, licenses, provenance subjects, checksums, and package inventories. Embed source commit/version/protocol capabilities consistently. Package browser validation compares decoded output pixels, dimensions, and MIME across engines; exact encoded hashes are release assertions only for deterministic repository-owned encoders.

    **Validate immediately:** run `cargo xtask release build --plan <json>` twice in fresh directories. Compare normalized unsigned payload hashes and inventories; explain only approved platform nondeterminism. Scan all outputs for secrets, repository absolute paths, dev IDs/URLs, debug symbols policy, and remote extension code.

13. Create isolated signing workflow jobs. Download artifacts by exact run ID and expected digest from the release plan; verify provenance before signing; sign with free mechanisms only (updater keypair, store submission, GPG tags) in dedicated protected environments; generate updater signatures separately; upload signed outputs with new digests. Never execute contributor-controlled scripts after secrets are exposed.

    **Validate immediately:** use test identities/local fixture keys to dry-run all logic. Tamper with one input and verify signing refuses it. Verify logs mask credentials and temporary keychains/key files are destroyed.

14. Implement `cargo xtask release verify --plan <path> --artifacts <path>`. Verify source commit, version, package inventory, checksums, SBOM subjects, signatures, updater signatures, extension manifest IDs/permissions, native-host IDs/paths, website CSP, protocol current/N-1 capabilities, and no unexpected files. Verification must work using public keys only.

    **Validate immediately:** run `cargo xtask release verify --plan <path> --artifacts <path>` on clean fixture artifacts, then individually tamper binary, checksum, updater metadata, manifest permission, capability file, and SBOM. Every tamper must fail. This command becomes available only after this step.

15. Add website deployment workflow with preview and production environments. Upload exact verified website assets and metadata CORS proxy function. Run post-deploy deterministic health/CORS tests covering direct first, automatic metadata fallback only after classified failure (metadata only, never tiles), opt-out, visible transport, credential stripping, ineligible-target rejection, and proxy denial. Production promotion uses immutable artifact digest and manual approval; no rebuild occurs between preview and production.

    **Validate immediately:** deploy only to a local/provider preview environment,
    verify direct/automatic-proxy/opt-out/credential-stripping/tainted-canvas
    scenarios, no proxy before classified failure, and SSRF denials, then roll
    preview back to its previous immutable deployment.

16. Add release publication workflow. Given verified signed artifact digests, create a draft release, attach checksums/SBOM/provenance/signatures/installers/CLI archives, and generate updater metadata without marking it live. Promotion to public release and updater channel are separate approved steps.

    **Validate immediately:** dry-run against a local fixture or draft-only environment. Verify filenames, MIME types, links, signatures, and rollback instructions. Do not publish in this phase.

17. Add browser-store submission workflow separated by browser. Submit exact verified artifacts, permission rationale, privacy disclosures, screenshots, and release notes; support dry-run/manual upload. Track `submitted`, `in review`, `approved`, `rejected`, and `published` independently for Chromium and Firefox.

    **Validate immediately:** validate payloads without submission. Ensure a Firefox approval cannot falsely mark Chromium published and store lag does not activate unsupported website features.

18. Add staged updater workflow. Publish signed metadata only after desktop artifacts are public and verified; support channels and rollout percentage where platform allows; retain current and N-1 payloads/metadata for rollback and lagging extensions. Prevent metadata from advertising an unavailable binary.

    **Validate immediately:** run against local update feed, test current, N-1, staged next, rollback refusal, paused rollout, and offline behavior. Verify current/N-1 cross-app handoffs remain functional.

19. Document security, privacy, release, and incident procedures. Include proxy abuse response, signing-key compromise, extension compromise, updater compromise, cookie-handoff concern, release rollback, store rejection, store/update lag, vulnerability reporting, retention, and exact owner/escalation contacts.

    **Validate immediately:** run docs link/checklist validation and a tabletop exercise using a fake updater key compromise. Record actions and missing automation in `artifacts/phase-13/tabletop.md`.

20. Execute a full release-candidate rehearsal from a signed annotated test tag on a non-production channel. Build once, sign with test identities, verify, deploy preview, generate draft release, create store submission bundles without submitting, stage local updater metadata, then roll all rehearsal deployments back/clean. Packaged parity is owned by phase 14 and is not run in this phase.

    **Validate immediately:** `artifacts/phase-13/rehearsal.json` must list every artifact digest, gate, cleanup action, and result. Zero production endpoints/store submissions and zero residual temporary credentials are required.

21. Run `cargo xtask ci local` and the workflow policy gates. Review required-check configuration and ensure release workflows cannot run from arbitrary commits or unprotected actors.

    **Validate immediately:** inspect workflow diffs, action SHAs, permissions, environment names, artifact retention, checksums, and generated files. Do not create a release or commit.

22. Append only the phase-13 row in `docs/migration/gates.md`, linking gate-map, policy, supply-chain, signed rehearsal, tamper, lag, and cleanup evidence.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/13-ci-security-and-release.md`; confirm production publication is recorded as not performed.

## Deterministic User Workflows

### Pull Request CI Simulation

1. Run `cargo xtask ci local` from a clean generated state.
2. Verify all locally applicable lanes pass and produce a gate map.
3. Run with release/store/signing environment variables unset.
4. Verify ordinary CI neither requests nor needs protected secrets.
5. Introduce a temporary generated-file mismatch with a targeted patch, verify failure, then reverse only that patch.

### Release Candidate Rehearsal

1. Create a release plan for a non-production test version and channel.
2. Build twice in fresh artifact directories.
3. Compare normalized unsigned hashes.
4. Sign with test identities in isolated jobs.
5. Run `cargo xtask release verify` using public test keys.
6. Install each native/desktop artifact on its native runner, load each extension package, deploy website preview, and run deterministic packaged workflows.
7. Remove all test installations/registrations/profiles/deployments and verify cleanup report.

### Signature Tamper Test

1. Copy a verified rehearsal artifact to a temporary path.
2. Flip one byte without updating metadata.
3. Run release verification and updater verification.
4. Verify both reject before install/execute.
5. Repeat with altered extension permission and updater version rollback.

### Store And Updater Lag

1. Mark Firefox current as approved, Chromium N-1 as still published, desktop current staged at 10%, and website current deployed.
2. Run generated compatibility matrix.
3. Verify Chromium N-1 retains baseline website/native handoff.
4. Verify website hides current-only extension features from N-1.
5. Pause desktop rollout and verify extension current remains compatible with desktop N-1.
6. Promote states independently and verify no app assumes synchronized availability.

## Stop Conditions

- Stop if signing secrets are visible to PR/fork jobs or untrusted build scripts.
- Stop if actions are not commit-SHA pinned or workflows have unexplained write permissions.
- Stop if the signed artifact cannot be tied by digest to the reviewed source/build plan.
- Stop if release verification does not catch any tamper case.
- Stop if deterministic required CI needs public websites, stores, or updater endpoints.
- Stop if website/store/updater publication cannot be promoted or rolled back independently.
- Stop if current/N-1 compatibility fails under simulated lag.
- Stop if rehearsal touches production or leaves credentials/registrations/profiles/deployments.

## Risks And Mitigations

- **Supply-chain compromise:** pinned actions/tools, lockfiles, SBOM, provenance, isolated signing, digest verification.
- **Secret exposure:** protected environments, no secrets in PR jobs, post-build signing, masking and cleanup checks.
- **Platform release mismatch:** canonical release plan and public-key verification of every artifact.
- **Store review lag:** independent state tracking and N-1 compatibility.
- **Updater rollback/compromise:** signed metadata, anti-rollback, staged channels, retained safe N-1.
- **Proxy abuse:** CI policy tests, deploy health probes, incident runbook, independent rollback.
- **Flaky release gate:** canonical deterministic scenarios are required; live compatibility remains advisory.

## Safe Rollback

1. Disable affected workflow or protected environment with a targeted change; do not delete audit logs or artifacts under investigation.
2. For preview/rehearsal, promote the prior immutable website deployment and restore prior local updater metadata.
3. Delete draft-only release/store submissions through platform APIs only after recording IDs/digests.
4. Revoke test credentials/keychains and remove temporary registrations/profiles.
5. Revert only phase-13 workflow/config/docs/xtask hunks; preserve unrelated concurrent changes.
6. Re-run phase-12 gates to prove app behavior is unchanged.
7. Never force-push, hard-reset, overwrite signed artifacts, or reuse a compromised version number.

## Artifacts

- `artifacts/phase-13/preflight.json`
- `artifacts/phase-13/gate-map.json`
- `artifacts/phase-13/rehearsal.json`
- `artifacts/phase-13/tabletop.md`
- Release plans at `artifacts/release/<version>-<channel>.json`
- Unsigned and test-signed release-candidate inventories/checksums under `dist/<version>-<channel>/`
- SBOMs and provenance attestations
- Signature/notarization/updater verification reports
- Store submission validation reports
- Deployment and cleanup reports

Keep signing material and credentials outside artifacts. Retain only public certificates/keys and redacted identifiers allowed by policy.

## Completion Checklist

- [ ] Every phase gate maps to required deterministic CI.
- [ ] PR/fork CI is read-only and receives no protected secrets.
- [ ] Actions/tools/dependencies are pinned and policy-checked.
- [ ] Security, license, advisory, secret, fuzz, and boundary gates run.
- [ ] Live compatibility is isolated and non-blocking.
- [ ] Release plan binds source, versions, capabilities, targets, and artifact names.
- [ ] Unsigned builds are reproducible to documented normalization.
- [ ] Signing consumes only digest-verified reviewed artifacts.
- [ ] Public-key release verification catches all tamper fixtures.
- [ ] Website, releases, updater, Chromium store, and Firefox store promote independently.
- [ ] Current/N-1 behavior passes store/updater lag matrix.
- [ ] Release CI enforces website direct-first automatic eligible metadata proxy fallback,
  opt-out, transport visibility, and credential stripping, plus extension no-
  proxy behavior.
- [ ] Full release rehearsal completes with test identities and no production effects.
- [ ] Security/privacy/release/incident docs are actionable.
- [ ] Rehearsal cleanup leaves no credentials, installs, profiles, registrations, or deployments.
- [ ] The phase-13 migration gate row links signed rehearsal and supply-chain evidence.
