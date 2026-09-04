# Phase 11: Desktop Application

## Objective

Build the Tauri desktop app using the shared React UI and `dezoomify-native` runtime. Produce secure, signed-capable installers for Windows, macOS, and Linux. The desktop installation must be able to register the `dezoomify://` protocol, install/remove the browser Native Messaging host manifest, expose generated Tauri capabilities, and support signed updater metadata without widening IPC access.

Desktop commands must pass typed non-secret requests to the runtime. Cookie-bearing handoff is completed only in phase 12 through the Native Messaging host and in-memory authorization path.

## Non-Goals

- Do not let arbitrary web content invoke Tauri commands.
- Do not place cookies or authorization in custom-protocol URLs, command-line arguments, Tauri events, local storage, settings, updater logs, or crash reports.
- Do not implement extension behavior or final Native Messaging message handling in this phase.
- Do not auto-register protocols/native hosts from an unpackaged development binary without explicit test isolation and cleanup.
- Do not publish installers or enable production updater endpoints yet.
- Do not remove old native binaries or release assets.

## Dependencies

- Phase 10 is green, including native runtime, CLI parity, protocol current/N-1 support, and secret redaction.
- Phase 09 shared UI accepts a `AppIntegration` and does not import browser-only host APIs.
- `crates/fixture-server/` serves the canonical desktop scenarios under
  `testdata/scenarios/desktop/`; this phase does not create a second fixture or
  expected-output tree.
- Tauri major/minor version, plugin list, Rust/Node versions, bundle identifiers, application name, protocol scheme, extension IDs for release/dev, and updater strategy are documented and pinned.
- Signing/notarization identities are not required for local development but CI secret names and release ownership are agreed before creating workflows.
- Phase-05 generated protocol schema/types and the phase-10 native runtime
  capability API are canonical prerequisites. This phase creates desktop/Tauri
  capability artifacts in step 8; they must not be required at phase start.

## Exact Paths

Create or modify only:

- `apps/desktop/package.json`
- `apps/desktop/index.html`
- `apps/desktop/vite.config.ts`
- `apps/desktop/src/main.tsx`
- `apps/desktop/src/desktopIntegration.ts`
- `apps/desktop/src/events.ts`
- `apps/desktop/src/styles.css`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/build.rs`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/commands.rs`
- `apps/desktop/src-tauri/src/jobs.rs`
- `apps/desktop/src-tauri/src/deep_link.rs`
- `apps/desktop/src-tauri/src/install_integration.rs`
- `apps/desktop/src-tauri/src/updater.rs`
- `apps/desktop/src-tauri/src/bin/dezoomify-native-host.rs`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/capabilities/generated.json`
- `apps/desktop/src-tauri/icons/*`
- `apps/desktop/tests/*.spec.ts`
- `apps/desktop/src-tauri/tests/*.rs`
- `generated/desktop-capabilities.json`
- `installer/native-messaging/*.json.in`
- `installer/linux/*`
- `installer/macos/*`
- `installer/windows/*`
- `testdata/scenarios/desktop/**`
- `crates/xtask/src/desktop.rs`
- `crates/xtask/src/main.rs`
- `docs/native-apps.md`
- `docs/migration/gates.md` for the phase-11 execution record only
- `artifacts/phase-11/**` for ignored local evidence
- root workspace manifests/lockfiles only for registration

Do not edit `apps/extension/` in this phase. Template native-host manifests may be created, but extension-specific final IDs and message behavior are validated in phase 12.

## Command Availability

- Available before this phase: `cargo xtask test native`, `cargo xtask build web`, `cargo xtask protocol generate`, `cargo xtask protocol check`, and `cargo xtask fixtures serve`.
- Added during step 8: the `cargo xtask protocol generate --desktop-capabilities` mode.
- Added during step 2: `cargo xtask dev desktop`.
- Added during step 15: `cargo xtask build desktop`.
- Added during step 18: `cargo xtask test desktop`.
- Platform installer commands only work on their native OS unless the release toolchain explicitly supports safe cross-building.

## Sequential Implementation Steps

1. Capture preflight status and run all phase-10 gates. Record target triples, installed WebView versions, Tauri CLI version, platform packaging tools, and unavailable signing credentials in `artifacts/phase-11/preflight.md`.

   **Validate immediately:** run `cargo xtask test native`, `cargo xtask protocol check`, `cargo xtask test`, and `pnpm --filter ./packages/shared-ui test`. Stop on regressions.

2. Create the desktop Vite shell, register `cargo xtask dev desktop`, and render
   the shared `App` with a minimal `DesktopIntegration`. Keep routing and component
   composition shared. Configure Vite for Tauri's fixed local origin and disable
   production source maps unless release policy explicitly permits sanitized
   maps.

   **Validate immediately:** run `pnpm --filter ./apps/desktop typecheck` and `pnpm --filter ./apps/desktop build`. Verify no metadata CORS proxy code or extension API is bundled.

3. Create `apps/desktop/src-tauri` and wire `dezoomify-native`. Configure one window with strict navigation policy, no remote content, CSP denying unneeded sources, no shell plugin, and the minimum filesystem/dialog/updater plugins. Use `tauri::generate_context!` and checked-in configuration.

   **Validate immediately:** run `cargo check -p dezoomify-desktop` and the Tauri configuration validator. Confirm external `http:`/`https:` navigation opens only through an explicit safe external-link command.

4. Implement `jobs.rs` and `commands.rs`. Commands may start/cancel jobs, answer image/level choices, request a save destination, and query capabilities. Return job IDs immediately and stream redacted protocol events. Scope every event to the creating window/session; reject unknown/stale job IDs. Never pass output paths from untrusted remote content because remote content is forbidden.

   **Validate immediately:** Rust tests must cover lifecycle, stale IDs, duplicate cancellation, closed window, event ordering, invalid paths, and runtime errors. TypeScript tests must reject malformed IPC payloads before UI state changes.

5. Implement the desktop save flow. Use a native save dialog, validate format/extension, pass the selected path to `dezoomify-native`, and display atomic completion. For IIIF directory output use a directory picker and explicit non-empty-directory confirmation.

   **Validate immediately:** use mocked dialogs and temporary directories to test cancel, overwrite refusal, permission denial, invalid extension, IIIF non-empty destination, and completion. Verify the UI never claims success before atomic output finalization.

6. Implement `deep_link.rs` for `dezoomify://open` using the generated protocol
   envelope. Treat every website/deep link as untrusted input, not an
   authenticated or signed statement. Accept only a small bounded versioned
   payload containing a non-secret source reference and optional display hint.
   Limit total URL/field lengths; reject duplicate fields, userinfo, unsupported
   versions, malformed encoding, and all secret/header/cookie fields. Require
   user confirmation before any network or file effect.

   **Validate immediately:** test current and N-1 links, N-2/future rejection,
   repeated untrusted links, oversized URL/fields, shell metacharacters,
   malformed percent encoding, and a cookie-looking parameter. Verify no link is
   treated as signed/authenticated, every accepted link prompts independently,
   and rejected/unconfirmed links make no network/file effects.

7. Implement single-instance routing. A second invocation forwards a validated deep link to the existing instance; ordinary second launches focus the window. Queue at most the documented number of links until UI ready and discard expired entries. Never append raw process arguments to logs.

   **Validate immediately:** integration-test cold start, warm start, simultaneous
   links, bounded-queue expiry, malformed link, and application shutdown. Verify
   one app instance, one confirmation per untrusted link, and no lost prompt.

8. Generate Tauri and app capabilities from canonical protocol data. Add the `cargo xtask protocol generate --desktop-capabilities` mode to emit `generated/desktop-capabilities.json` and `apps/desktop/src-tauri/capabilities/generated.json` with exact commands, event channels, protocol range, encoder support, native-host name, and updater support. Hand edits must fail `cargo xtask protocol check` or the desktop generation check.

   **Validate immediately:** run `cargo xtask protocol generate --desktop-capabilities` twice and `cargo xtask protocol check`. Compare command names against Rust command registration and TypeScript integration use. This generation mode becomes available only after this step.

9. Add a minimal handshake-only `dezoomify-native-host` binary and implement install-integration path calculation in `install_integration.rs`. In this phase the host may report identity/version/capabilities and must reject all job and credential messages with `capability.unavailable`; phase 12 adds handoff execution. Generate OS-specific protocol registration and Native Messaging manifest destinations from installed executable paths. Browser manifests must use exact release extension IDs, absolute host executable path, and browser-specific allowed-origin syntax. Browser enforcement of these allowed extension IDs authenticates the sender of an established Native Messaging channel; the host does not invent a separate nonce/signature identity check. Keep dev IDs and destinations isolated under test profiles.

   **Validate immediately:** test length-prefixed current/N-1 handshake and fail-closed job/credential rejection, then pure path/manifest tests for Windows registry paths and JSON, macOS application-support paths, Linux XDG/home paths, Chromium allowed origins, and Firefox allowed extensions. Assert JSON contains no wildcard extension ID, documents browser-enforced sender authentication, and executable paths survive spaces/non-ASCII.

10. Add explicit install, repair, status, and uninstall operations for protocol/native-host integration. Installer hooks use these idempotent operations; the desktop settings page may expose status/repair with user intent. Record only non-secret status. Uninstall must remove entries only when they still point to this installation, preserving user/admin replacements.

    **Validate immediately:** in isolated temp registry/config roots, run install twice, repair after corruption, status, uninstall twice, upgrade path change, and foreign-owner preservation. Verify cleanup leaves no test registration.

11. Add installer templates for Windows, macOS, and Linux. Register `dezoomify` protocol with proper quoting, install the application and native host executable/template, invoke idempotent integration setup, and invoke ownership-safe cleanup. Document per-user versus system install behavior explicitly.

    **Validate immediately:** lint templates and inspect expanded artifacts. On each native OS CI runner, install into an isolated test account/profile, launch a benign current and N-1 deep link, then uninstall and assert cleanup.

12. Implement updater client configuration with signed metadata, HTTPS endpoint allowlist, channel, rollout compatibility, rollback prevention, and explicit user confirmation policy. The app must continue functioning when update metadata is missing, delayed, older, or newer than extension-store versions. Never execute unsigned packages.

    **Validate immediately:** use a local signed fixture feed for no-update, valid update, invalid signature, hash mismatch, stale timestamp, rollback version, network failure, and protocol compatibility warning. Verify invalid updates are not staged or executed.

13. Add desktop security tests: remote navigation, injected HTML, malformed IPC, arbitrary command name, arbitrary filesystem path, CSP violation, protocol-handler injection, updater URL replacement, and symlinked registration destinations. Use Tauri mocks where appropriate and native integration tests for OS registration.

    **Validate immediately:** run Rust security tests and UI tests. Scan logs, crash reports, WebView storage, settings, and artifacts with secret canaries.

14. Add deterministic desktop end-to-end scenarios: basic download, picker flow, cancel, output collision, large streaming image, deep-link cold/warm start, protocol N-1, update lag, and registration repair/cleanup. Use `crates/fixture-server` and temporary user profiles; never touch the developer's real browser manifests or protocol registration.

    **Validate immediately:** run the test binary with `DEZOOMIFY_TEST_INTEGRATION_ROOT` set to a fresh temp location and assert all paths remain below it.

15. Add `cargo xtask build desktop`. It must check generated files, build shared UI, build the platform Tauri bundle, emit checksums/SBOM inputs, and refuse production mode without required updater/signing configuration. Add `--unsigned-test` for local artifacts clearly named as unsigned and never publishable.

    **Validate immediately:** run `cargo xtask build desktop --unsigned-test` twice. Inspect installer contents and ensure generated manifests point at packaged paths, not repository paths. This command becomes available only after this step.

16. Add native large-image desktop testing. Run a scenario beyond browser canvas limits, select streaming output, cancel once midway, then complete. Assert UI memory remains bounded because pixels are never bridged through Tauri IPC; only protocol progress/events cross the boundary.

    **Validate immediately:** collect peak runtime and WebView memory in `artifacts/phase-11/resource-bounds.json`; assert IPC event payloads stay below the protocol maximum and contain no tile bytes.

17. Test update/store lag and N-1 compatibility. Simulate website/extension current with desktop N-1, desktop current with extension N-1, a staged desktop update not yet installed, and an extension-store update delayed for weeks. UI feature offers must follow negotiated capabilities, not marketing version assumptions.

    **Validate immediately:** replay the compatibility matrix and write `artifacts/phase-11/compatibility-matrix.json`. Current/N-1 deep links must remain usable; unsupported handoffs must retain a manual source workflow.

18. Add `cargo xtask test desktop` to run Tauri unit tests, shared UI integration tests, deterministic E2E tests available on the current OS, generated capability checks, registration isolation/cleanup checks, and artifact scans. It must fail if test registrations/processes remain.

    **Validate immediately:** run `cargo xtask test desktop` twice with fresh integration roots. On the second run verify no state from the first is observed. This command becomes available only after this step.

19. Run final gates: formatting, clippy with warnings denied, workspace tests, TypeScript lint/typecheck, `cargo xtask protocol check`, `cargo xtask test native`, `cargo xtask test web`, `cargo xtask build desktop --unsigned-test`, and `cargo xtask test desktop`.

    **Validate immediately:** inspect `git status --short`, `git diff --check`, bundle contents, capability diffs, and registration-cleanup report. Do not publish anything.

20. Append only the phase-11 row in `docs/migration/gates.md` with packaged smoke, registration cleanup, updater signature, current/N-1, and large-image evidence.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/11-desktop-app.md` and verify all platform-specific skips are explicit, owned, and not represented as passes.

## Deterministic User Workflows

### Desktop Download

1. Run `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` and obtain the source URL from `testdata/scenarios/desktop/desktop-basic/`.
2. Run `pnpm --filter ./apps/desktop tauri dev`.
3. Paste the printed source URL, select the fixture image and level, and choose a temp output path.
4. Verify progress matches the scenario count and completion appears only after the file exists.
5. Compare output SHA-256 with the scenario manifest.
6. Close the window and verify no runtime process remains.

### Protocol Cold And Warm Start

1. Use the isolated protocol registration root created by the test harness.
2. Launch the current-version benign `dezoomify://open` fixture while the app is closed.
3. Verify the app opens and asks consent with the exact redacted origin before network access.
4. Keep the app open and launch the N-1 scenario.
5. Verify the existing window receives one prompt and no second process persists.
6. Launch N-2 and verify a version error with zero network requests.

### Native Host Registration Lifecycle

1. Run `cargo xtask build desktop --unsigned-test` to build the unsigned test bundle.
2. Install into `DEZOOMIFY_TEST_INTEGRATION_ROOT`.
3. Run status and verify Chromium and Firefox manifest templates contain exact test extension IDs and absolute packaged host paths.
4. Corrupt one path, run repair, and verify only owned entries change.
5. Add a foreign replacement entry, uninstall, and verify that foreign entry remains while owned entries disappear.

### Large Image

1. Select `desktop-large-streaming`.
2. Start output to a temporary PNG/IIIF destination.
3. Cancel at the fixture's exact midpoint and verify no completed output is reported.
4. Restart and complete.
5. Verify digest, bounded IPC payloads, and memory report.

### Updater Lag And Signature

1. Point the test build at the local signed fixture feed.
2. Test valid current-to-next update and verify user confirmation.
3. Test invalid signature and hash mismatch; verify no package executes.
4. Test older/stale metadata and offline mode; verify downloads still work.
5. Set extension capability to N-1 and verify desktop does not require an unavailable store update for baseline handoff.

## Stop Conditions

- Stop if the desktop duplicates native runtime logic or sends tile bytes through IPC.
- Stop if remote content can navigate inside the privileged WebView or invoke commands.
- Stop if any deep link can carry cookie/auth/header secrets.
- Stop if generated capability files do not exactly match registered commands and app support.
- Stop if installer tests touch real user registration locations or cannot clean isolated entries.
- Stop if unsigned updater payloads can be staged/executed.
- Stop if current/N-1 protocol flows require synchronized store and desktop releases.
- Stop if packaging cannot preserve ownership-safe uninstall behavior.

## Risks And Mitigations

- **Tauri privilege exposure:** local-only UI, strict CSP/navigation, generated minimal capabilities, typed command validation.
- **Protocol-handler injection:** untrusted bounded non-secret envelope, strict
  parsing/version checks, and explicit confirmation; no signature or link-level
  authentication claim.
- **Broken browser registration after update:** idempotent install/repair/status/uninstall and packaged-path tests.
- **Updater compromise:** signatures, hashes, HTTPS allowlist, anti-rollback, and local hostile-feed tests.
- **Cross-platform installer drift:** native OS CI installation tests and checked-in templates.
- **Large-image WebView pressure:** native streaming output and progress-only IPC.
- **Release lag:** capability negotiation and protocol N-1 support rather than equal-version assumptions.

## Safe Rollback

1. Uninstall any isolated test bundles through their ownership-safe uninstall command before removing files.
2. Verify real user protocol/native-host locations were never touched; if they were, stop and document exact paths before any cleanup.
3. Save targeted diffs for desktop, installer, xtask desktop module, and registration hunks.
4. Remove only phase-11 additions and targeted workspace registrations after checking concurrent ownership.
5. Preserve generated protocol files unless their canonical schema intentionally changed.
6. Re-run phase-10 native/CLI gates.
7. Never use broad registry deletion, recursive profile deletion outside the test root, hard reset, or broad git clean.

## Artifacts

- `artifacts/phase-11/preflight.md`
- `artifacts/phase-11/results.json`
- `artifacts/phase-11/resource-bounds.json`
- `artifacts/phase-11/compatibility-matrix.json`
- `artifacts/phase-11/registration-cleanup.json`
- `artifacts/phase-11/bundle-inventory.json`
- Unsigned local installers clearly labeled `UNSIGNED-TEST`
- Failure-only WebDriver/WebView traces and screenshots

## Completion Checklist

- [ ] Desktop renders the shared React UI through an app integration.
- [ ] All downloads use `dezoomify-native`; tile bytes never cross Tauri IPC.
- [ ] Tauri commands/events and capabilities are generated, minimal, and synchronized.
- [ ] Remote navigation and arbitrary IPC/filesystem access are denied.
- [ ] Deep links are untrusted, unsigned, non-secret, versioned, bounded,
  independently confirmed, and N-1 compatible.
- [ ] Protocol and Native Messaging registration operations are idempotent and ownership-safe.
- [ ] Windows, macOS, and Linux installer templates pass native checks.
- [ ] Updater rejects invalid, tampered, stale, and rollback payloads.
- [ ] Large-image native output is tested with bounded memory and IPC.
- [ ] Store/update lag compatibility matrix passes.
- [ ] Isolated install/uninstall tests leave no processes or registrations.
- [ ] `cargo xtask build desktop --unsigned-test` and `cargo xtask test desktop` pass.
- [ ] No artifact was published and legacy releases remain untouched.
- [ ] The phase-11 migration gate row records deterministic and platform-specific evidence accurately.
