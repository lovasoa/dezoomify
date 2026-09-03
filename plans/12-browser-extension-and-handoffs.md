# Phase 12: Browser Extension And Handoffs

## Objective

Ship Chromium and Firefox extension builds around the shared UI/browser runtime with four strict behaviors:

1. Only an explicit extension action starts a scan. It registers request
   observation for the **currently active tab only before reload**, reloads that
   tab exactly once, collects candidates for one bounded generation, reaches a
   finite quiet-settle or hard deadline, then removes all listeners and stops.
   Opening/focusing Studio never reloads or rearms the scan.
2. Extension downloads use direct privileged extension fetch with the browser's existing session and convert readable response bytes into origin-clean decoded tiles and exports. The extension never uses the hosted website proxy.
3. Website-to-extension and extension-to-native handoffs negotiate generated protocol capabilities and support current plus N-1 versions without requiring synchronized store updates.
4. Cookies may be handed only to the native runtime through Native Messaging
   after explicit consent, with narrow origin/path/job/expiry scope, memory-only
   handling, no intentional persistence, and mandatory redaction. Owned buffers
   are overwritten best-effort on release, without claiming universal
   zeroization. Cookie values never enter website URLs, extension pages,
   JavaScript logs, storage, diagnostics, Tauri IPC, CLI arguments, environment
   variables, or files.

## Non-Goals

- Do not continuously monitor all tabs or all browsing.
- Do not retain web-request history after a scan settles, tab closes/navigates, or the extension worker suspends.
- Do not use a hosted proxy from the extension.
- Do not send cookies to the website or proxy.
- Do not persist candidates, source page content, cookie values, authorization headers, or native handoff payloads.
- Do not require broad permanent host permissions when optional per-origin permissions suffice.
- Do not make cookie handoff automatic merely because direct extension fetch receives a 401/403.
- Do not delete/publish the old extension yet.

## Dependencies

- Phase 08 browser runtime supports injected readable-byte transport and origin-clean export.
- Phase 09 shared UI supports product adapters and capability-driven escalation.
- Phase 10 native runtime exposes crate-private scoped ephemeral authorization and current/N-1 protocol handling.
- Phase 11 packages a Native Messaging host executable, registration templates, protocol handler, and generated desktop capabilities.
- `packages/protocol-ts/` supplies generated current/N-1 message parsing and
  exhaustive tagged unions; extension code must not hand-author duplicate wire
  DTOs.
- Canonical protocol schema defines scan, candidate, transport, handoff, consent, authorization scope, redaction, errors, and compatibility.
- `crates/fixture-server/` and `testdata/scenarios/extension/` support extension
  pages, authenticated metadata/tiles, frames, redirects, reload counters,
  delayed requests, noisy unrelated requests, and two origins.
- Chromium stable and Firefox stable/ESR extension test environments are pinned. Where WebKit lacks WebExtension test parity, Safari packaging is explicitly out of scope rather than falsely represented by Playwright WebKit.

## Exact Paths

Create or modify only:

- `apps/extension/package.json`
- `apps/extension/tsconfig.json`
- `apps/extension/vite.config.ts`
- `apps/extension/src/background/index.ts`
- `apps/extension/src/background/scan.ts`
- `apps/extension/src/background/candidates.ts`
- `apps/extension/src/background/fetch.ts`
- `apps/extension/src/background/handoff.ts`
- `apps/extension/src/background/native.ts`
- `apps/extension/src/background/redaction.ts`
- `apps/extension/src/app/main.tsx`
- `apps/extension/src/app/extensionAdapter.ts`
- `apps/extension/src/app/messages.ts`
- `apps/extension/src/content/reload-marker.ts`
- `apps/extension/src/manifest/base.json`
- `apps/extension/src/manifest/chromium.json`
- `apps/extension/src/manifest/firefox.json`
- `apps/extension/src/icons/*`
- `apps/extension/tests/unit/*.test.ts`
- `apps/extension/tests/e2e/*.spec.ts`
- `apps/extension/generated/manifest.chromium.json`
- `apps/extension/generated/manifest.firefox.json`
- `apps/desktop/src-tauri/src/bin/dezoomify-native-host.rs` (extend the existing phase-11 host; do not create it)
- `apps/desktop/src-tauri/src/native_host/framing.rs`
- `apps/desktop/src-tauri/src/native_host/session.rs`
- `apps/desktop/src-tauri/src/native_host/redaction.rs`
- `apps/desktop/src-tauri/tests/native_host_*.rs`
- `testdata/scenarios/extension/**`
- `testdata/scenarios/protocol-v1/handoff/**`
- `crates/xtask/src/extension.rs`
- `crates/xtask/src/main.rs`
- `docs/extension.md`
- `docs/security.md`
- `docs/migration/gates.md` for the phase-12 execution record only
- `artifacts/phase-12/**` for ignored local evidence
- installer native-host templates and generated capabilities only where final extension IDs/protocol ranges must be inserted
- root manifests/lockfiles only for registration

Do not modify the legacy extension snapshot under `migration-sources/`.

## Command Availability

- Available before this phase: the `browser`, `web`, `native`, `desktop`, and `scenario` targets under `cargo xtask test`; both `cargo xtask protocol generate` and `cargo xtask protocol check`; and `cargo xtask build desktop --unsigned-test`.
- Added during step 7: the `cargo xtask protocol generate --extension-manifests` mode.
- Added during step 17: `cargo xtask test native-messaging`.
- Added during step 18: `cargo xtask build extension`.
- Added during step 21: `cargo xtask test extension`.
- Firefox temporary-install and Chromium unpacked-extension direct commands become meaningful only after generated manifests exist in step 7.

## Sequential Implementation Steps

1. Run all prerequisite gates and record installed Chromium/Firefox versions, extension APIs, manifest constraints, native host registration roots, and generated protocol hashes in `artifacts/phase-12/preflight.md`. Use only temporary browser profiles.

   **Validate immediately:** run `cargo xtask test browser`, `cargo xtask test native`, `cargo xtask test desktop`, `cargo xtask protocol check`, and `cargo xtask test`. Stop on any prerequisite regression.

2. Define extension internal message types by wrapping generated protocol types: `StartScan`, `ScanStarted`, `CandidateFound`, `ScanSettled`, `ScanFailed`, `FetchResource`, `FetchResult`, `StartNativeHandoff`, `ConsentDecision`, and `NativeResult`. Every message includes scan/job ID and protocol version; reject unknown senders and stale IDs.

   **Validate immediately:** unit-test schema parsing, maximum message sizes, malformed objects, prototype pollution keys, stale scan IDs, unknown messages, and current/N-1 scenarios. No handwritten interface may duplicate a generated wire shape.

3. Implement `scan.ts` as a finite state machine: `idle -> arming -> reloading -> observing -> settling -> stopped`. Only an explicit action click may leave `idle`. Query the currently active tab in the current window, reject privileged/browser-internal URLs, allocate a scan generation, install a `webRequest` observer filtered by exact `tabId`, register tab navigation/removal guards, then reload exactly that tab once. Start the finite hard deadline at arm and the quiet-settle timer after reload completion/request activity. Studio/app-page open, focus, reconnect, navigation, and worker restart must never reload or rearm.

   **Validate immediately:** fake API tests must prove explicit-action-only start,
   listener-before-reload ordering, exactly one reload, exact tab filter, one
   active generation per tab, replacement cleanup, finite quiet settle and hard
   deadline, tab close/navigation cleanup, terminal removal of all
   listeners/timers, and zero Studio-triggered reload/rearm.

4. Implement candidate recognition in `candidates.ts` using generated URL hints/canonicalization from the shared protocol/core artifact. Record only normalized candidate URLs and minimal format hints in memory, deduplicate deterministically, cap count and URL length, and reject schemes other than HTTP(S). Do not inspect response bodies or page DOM during scanning.

   **Validate immediately:** port legacy URL-recognition fixtures plus hostile/userinfo/fragment/duplicate cases. Verify candidate order is first-seen deterministic, secrets are redacted in UI labels, and no candidate survives scan disposal.

5. Make scan completion automatic. On settle or deadline, remove request/tab listeners first, freeze the candidate list, set a final badge count, and open/focus one extension app page scoped to the scan result without rearming or reloading. Clicking the extension action again is the only way to start a new one-click reload scan; Studio controls do not do so. Worker restart with no in-memory scan must display idle and attach no observers.

   **Validate immediately:** inspect mocked listener counts at every terminal state. Assert no interval polling, no listener remains after app page opens, and no browser restart restoration is attempted.

6. Define least-privilege manifests. Use action, activeTab, scripting/tabs only where required, webRequest observation, downloads if needed, nativeMessaging, and optional host/cookies permissions requested per target origin. Avoid `<all_urls>` as a permanent host permission. Account for Chromium MV3 service worker suspension and Firefox's supported manifest differences without changing behavior.

   **Validate immediately:** run the repository manifest-policy test. It must fail on wildcard permanent hosts, remotely hosted code, `eval`, unsafe CSP, unreviewed permissions, or mismatched release IDs.

7. Implement the `cargo xtask protocol generate --extension-manifests` mode to merge base/browser manifests and generated protocol/capability values deterministically. Include exact update/store IDs only from reviewed release config. Generate `apps/extension/generated/manifest.chromium.json` and `.firefox.json`; prohibit manual edits.

   **Validate immediately:** run `cargo xtask protocol generate --extension-manifests` twice, run `cargo xtask protocol check`, lint both manifests with browser-specific tools, and inspect permission diffs. This generation mode becomes available only after this step.

8. Implement privileged readable fetch in `background/fetch.ts`. Request optional host permission for the exact candidate origin after clear user intent. Perform extension-origin fetch with `credentials: "include"`, validate redirects and permission scope at each hop, enforce byte/time/type limits, and return bytes to the browser runtime using bounded transferable messages or extension-page fetch ownership. Never route through `/api/proxy` or any hosted relay.

   **Validate immediately:** deterministic tests must cover authenticated success, permission denial, cross-origin redirect requiring separate permission, timeout, oversized body, 401/403, cookie-less failure, and cancellation. Request logs must prove browser session cookies reach only allowed fixture origins and no proxy endpoint is contacted.

9. Bind `extensionAdapter.ts` to shared UI/runtime. Discovery and tiles use the privileged transport; readable bytes go through the origin-clean canvas surface. Opaque preview remains available if the user declines host permission, but export remains disabled. Save via extension download API or a user-gesture file API without broad filesystem access.

   **Validate immediately:** export the authenticated cross-origin scenario and
   compare decoded pixels, dimensions, and MIME in Chromium and Firefox. Compare
   exact encoded SHA-256 only for the repository-owned deterministic encoder.
   Verify origin-clean canvas pixel reads succeed and revoking host permission
   causes a classified failure rather than proxy fallback.

10. Add website-to-extension handoff. Treat website messages and links as
    untrusted, unsigned, bounded, non-secret hints. Validate the browser-reported
    sender/origin where available as an allowlist check, plus protocol range,
    source scheme/length, field/message bounds, and requested capability. Do not
    claim sender authentication or require a handoff signature. If external
    messaging differs by browser, use a generated extension app URL containing
    only the bounded non-secret envelope. Every valid handoff requires user
    confirmation before permission or fetch.

   **Validate immediately:** test valid current/N-1, repeated, wrong-origin,
   wrong-extension-ID, N-2, future, oversized, and secret-field handoffs. Assert
   no website/link envelope is treated as signed or authenticated. Valid requests
   require confirmation every time before host permission/fetch; invalid or
   unconfirmed requests trigger zero network calls.

11. Extend the existing phase-11 `dezoomify-native-host` binary; do not create a
    second target or host. Add bounded Native Messaging framing and handoff
    dispatch to its handshake-only implementation. Read one browser-defined
    native-endian 32-bit length-prefixed JSON message from stdin at a time,
    enforce a conservative maximum below browser limits before allocation, parse
    generated protocol envelopes, write bounded framed responses to stdout, and
    reserve stderr for redacted diagnostics. Delegate jobs to
    `dezoomify-native`; do not introduce another reusable runtime crate.

    **Validate immediately:** Rust tests cover partial reads/writes, EOF, zero/oversized lengths, malformed JSON, multiple messages, broken pipe, current/N-1, and timeout. Fuzz the frame parser with bounded input.

12. Implement a one-use native handoff session. The browser enforces the Native
    Messaging host manifest's exact allowed extension IDs; that browser
    enforcement authenticates the sender of the browser-established channel to
    the native host. The host must not claim to authenticate the extension by
    inspecting a self-asserted ID, challenge response, nonce, or handoff payload;
    website/deep-link content remains untrusted and does not inherit channel
    authentication.
    After protocol current/N-1 negotiation, the host issues a fresh challenge and
    the extension binds its next consent/credential message to that challenge,
    job, and one-use nonce. The challenge/nonce provides session binding and
    replay defense only; it is not a signature and authenticates neither the
    sender nor a website. Only after extension UI confirmation may it request
    optional `cookies` permission for exact required origins, collect only unexpired
    cookies available through the browser API and within scope, and send them
    directly in one bounded Native Messaging message. The host immediately
    constructs `EphemeralAuthorization`, performs best-effort overwrite of owned
    parsed buffers after transfer, starts the scoped job, and never echoes or
    intentionally persists secrets. Do not invent signatures or attestation.

   **Validate immediately:** assert message direction and state transitions.
   In packaged Chromium and Firefox tests, a disallowed extension ID must be
   denied by the browser before it can establish the Native Messaging channel.
   A cookie-bearing message before consent, after expiry, for another challenge/
   job/origin/path, or with a reused nonce must be rejected without network
   activity. Instrument best-effort overwrite of host-
   owned buffers, verify no intentional persistence, and do not claim
   zeroization of browser/OS/allocator/transport copies.

13. Implement consent details. Show native application identity/version, exact origin(s), path scope, cookie names but never values, expiry, purpose, and output action. Require an explicit unchecked confirmation each handoff. Decline must continue with non-cookie extension options. Revoking browser cookie permission after collection must not broaden the already narrow one-use native scope.

    **Validate immediately:** accessibility test the consent dialog and verify screenshots/DOM snapshots contain names/scopes but no values. Test decline, close, timeout, native disconnect, and permission denial.

14. Enforce memory-only secret handling, no intentional persistence, and
    redaction end to end. Do not use extension storage, IndexedDB, local/session
    storage, browser-runtime cache, URL/query/fragment, clipboard, console,
    analytics, crash reporting, Tauri IPC, filesystem, cache keys, process
    arguments, or environment. Redact native host stderr and runtime events.
    Release buffers on acknowledgement, cancellation, host disconnect, timeout,
    and process exit, and best-effort overwrite only buffers directly owned by
    extension/native code. Explicitly document that JavaScript, browser, IPC,
    allocator, and OS copies cannot be guaranteed zeroized.

   **Validate immediately:** inject unique cookie canaries and scan browser
   console, extension storage areas, intentionally persisted profile data,
   native stdout/stderr, process list, environment snapshot, native
   cache/temp/output, screenshots, traces, and artifacts. Require no intentional
   persistence or diagnostic/artifact leakage; browser-owned cookie storage is
   outside extension ownership and must not be copied into artifacts. Verify
   owned-buffer overwrite hooks separately without treating the scan as proof of
   universal memory zeroization.

15. Enforce scope at native request time. Convert browser cookie metadata into exact scheme/host/effective-port/path/secure/expiry matches; never forward domain cookies to unrelated sibling domains; do not send secure cookies over HTTP; re-evaluate each redirect; expire the context at the minimum cookie/handoff deadline; dispose after one job.

    **Validate immediately:** two-origin and path-bound scenarios must prove matching requests succeed while sibling host, parent path, HTTP downgrade, delayed-after-expiry, redirect escape, and second-job reuse receive no cookie.

16. Add end-to-end Native Messaging tests with the packaged host and isolated manifests for Chromium and Firefox. Cover no native app, incompatible native protocol, valid no-cookie handoff, consented cookie handoff, decline, native crash, malformed response, oversized response, cancellation, app upgrade between handshake and send, and host manifest removal.

    **Validate immediately:** after every test, assert host process exit, listener removal, profile cleanup, registration cleanup, and no canary leakage.

17. Add `cargo xtask test native-messaging` to build the host, install manifests under temporary browser profiles/integration roots, run protocol and secret-scope tests, and always uninstall. It must refuse to run if an integration path resolves to a real user profile.

    **Validate immediately:** run `cargo xtask test native-messaging --browser chromium` and `cargo xtask test native-messaging --browser firefox` twice. Kill the test midway once and run `cargo xtask test native-messaging --cleanup-only`; verify no host process or manifest remains. This command and its cleanup mode become available only after this step.

18. Add `cargo xtask build extension` to generate manifests, build shared UI/browser Wasm/extension bundles, prohibit source maps/remote code/secrets, produce deterministic Chromium ZIP and Firefox XPI input directory, and emit manifest/SBOM/checksum files. Browser signing is deferred to release CI.

   **Validate immediately:** run `cargo xtask build extension` twice and compare archive content lists and normalized hashes. Unpack and ensure there is no website proxy client path reachable from extension code; ordinary extension discovery and tiles must use privileged direct browser-session fetch. This command becomes available only after this step.

19. Add Chromium E2E tests with an unpacked extension and fresh profile. Test
    active-window/current-tab selection with two windows and multiple tabs;
    explicit-action-only scan start; listener registration before exactly one
    reload; noisy background tab exclusion; same-tab subframes; duplicate
    candidates; finite settle/deadline; action re-click replacement; Studio open
    and focus without reload/rearm; tab close; service-worker suspension/restart
    to idle; host permission decline/grant/revoke; authenticated privileged
    direct browser-session fetch; origin-clean decoded output; and listener
    cleanup. Compare decoded pixels/dimensions/MIME cross-browser, with exact
    encoded hashes only for the repository-owned deterministic encoder.

    **Validate immediately:** run the Chromium suite three times with randomized allocated ports but fixed scenario data. Request transcript must show no observation or fetch from non-active tabs and zero `/api/proxy` requests.

20. Add Firefox stable and ESR E2E tests with temporary signed-or-debug installation as CI permits. Run the same behavioral matrix, including browser-action differences, optional permissions, Native Messaging, private-window policy, container/contextual identity behavior if supported, and background lifecycle. Document only unavoidable API-level differences; outcomes and privacy guarantees remain identical.

    **Validate immediately:** run stable and ESR suites. Verify temporary profiles/manifests are removed. Do not substitute Playwright WebKit for Firefox extension coverage.

21. Add `cargo xtask test extension` to run unit tests, manifest policy, Chromium, Firefox stable/ESR, `cargo xtask test native-messaging`, secret scan, and package inspection. Write `artifacts/phase-12/results.json` and clean all processes/profiles/registrations even after failure.

    **Validate immediately:** run `cargo xtask test extension` twice and inspect the cleanup report. This command becomes available only after this step.

22. Run compatibility and release-lag matrix. Test extension current with desktop N-1, an extension N-1 scenario with desktop current, website current with extension N-1, store-delayed extension with newer desktop, desktop updater delayed with newer extension, and unsupported N-2/future combinations. Baseline current/N-1 handoff must succeed; newer capabilities must be hidden when peer lacks them.

    **Validate immediately:** write and inspect `artifacts/phase-12/compatibility-matrix.json`. No scenario may require network access to actual stores or updater service.

23. Run final workspace gates plus `cargo xtask build extension`, `cargo xtask test native-messaging`, and `cargo xtask test extension`.

    **Validate immediately:** inspect git diff, generated manifests, archive contents, request logs, listener cleanup, registration cleanup, and secret scans. Do not submit to stores.

24. Append only the phase-12 row in `docs/migration/gates.md`, linking Chromium, Firefox stable/ESR, native handoff, canary redaction, cleanup, and compatibility artifacts.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/12-browser-extension-and-handoffs.md`; confirm no browser result is inferred from another browser and no live/store check substitutes for deterministic evidence.

## Deterministic User Workflows

### One-Click Active-Tab Reload Scan

1. Run `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` and obtain both page URLs from `testdata/scenarios/extension/extension-scan-two-tabs/`.
2. Launch Chromium with the unpacked extension and a fresh profile.
3. Open fixture A in the active tab and noisy fixture B in a background tab.
4. Click the extension action once.
5. Verify fixture A reload counter increments exactly once; fixture B remains unchanged.
6. Verify the badge progresses and the extension app opens after deterministic quiet settle.
7. Verify candidates include A and its configured subframe resources, never B.
8. Inspect test hooks and verify request/tab listeners are zero after settle.
9. Repeat in Firefox stable and ESR.

### Authenticated Origin-Clean Extension Export

1. Log into the deterministic fixture by setting its browser-session cookie through the fixture login page.
2. Activate the image tab and click the extension once.
3. Grant exact-origin host permission when prompted.
4. Choose the detected image and export.
5. Verify upstream request log contains the browser cookie only for the protected origin.
6. Verify decoded pixels, dimensions, MIME, and successful origin-clean canvas
   read; compare exact output hash only when the deterministic repository-owned
   encoder is selected.
7. Verify `/api/proxy` request count is zero.
8. Revoke host permission and verify the next run asks again and does not silently proxy.

### Consented Cookie Handoff To Native

1. Install the packaged test native host into an isolated browser profile.
2. Open the protected fixture with one relevant and one unrelated cookie canary.
3. Choose `Continue in desktop/native`.
4. Verify consent lists exact origin/path, relevant cookie name, expiry, and native identity, but no value.
5. Decline once and verify no cookie-bearing native message or native request occurs.
6. Repeat, consent, and select a temporary native output.
7. Verify the matching native request succeeds, sibling/path-escape requests contain no cookie, and output hash matches.
8. Scan all artifacts/logs/storage for both canaries; values must not appear.
9. Attempt to replay the message and verify rejection with zero requests.

### Native Missing Or Version Lag

1. Remove the isolated native-host manifest and initiate native handoff.
2. Verify extension offers installer/manual CLI guidance without exposing cookies.
3. Install an N-1 host scenario binary and retry; verify negotiated baseline handoff succeeds.
4. Start N-2 and future hosts; verify deterministic update/incompatibility guidance and no cookie collection before compatibility is known.

### Scan Cleanup Under Failure

1. Start a delayed scan and close the active tab during observation.
2. Verify all listeners/timers disappear and no extension app opens with stale results.
3. Start again and terminate the extension worker during settle.
4. Restart the worker and verify idle state with no automatic monitoring.
5. Uninstall the test extension/host and verify profiles and manifests are removed.

## Stop Conditions

- Stop if the extension continuously monitors requests, observes non-active tabs, or requires permanent `<all_urls>` without an approved platform necessity.
- Stop if listener installation happens after reload or listeners remain after settle/deadline/error.
- Stop if extension fetch uses the website proxy or cannot prove origin-clean byte handling.
- Stop if cookie values reach website, UI, intentional persistence, URLs, logs,
  CLI/Tauri IPC, files, or artifacts.
- Stop if cookie handoff can happen before explicit consent and compatibility handshake.
- Stop if Native Messaging manifests use wildcard IDs or tests touch real profiles.
- Stop if current/N-1 cannot interoperate across store/update lag.
- Stop if Chromium and Firefox outcomes differ in privacy or scan scope.

## Risks And Mitigations

- **Persistent surveillance behavior:** finite scan state machine, exact tab filter, hard deadline, and listener-count assertions.
- **MV3 worker suspension loses state:** scans are intentionally memory-only; restart fails closed to idle rather than restoring observation.
- **Overbroad host/cookie permissions:** optional exact-origin requests following user intent and manifest policy gates.
- **Cookie exfiltration:** Native Messaging only, explicit consent, minimal
  selection, one-use scope, memory-only/no-intentional-persistence handling,
  best-effort owned-buffer overwrite, and canary scans without a universal
  zeroization claim.
- **Redirect cookie leakage:** request-time scope revalidation on every URL.
- **Extension/native version skew:** generated capability negotiation with current/N-1 scenarios and lag matrix.
- **Browser test flakiness:** deterministic settle signals, allocated ports, fresh profiles, and no public sites.
- **Store policy rejection:** no remote code, least privilege, clear consent, deterministic package inventory.

## Safe Rollback

1. Run the phase cleanup command before removing code; verify no test host process, profile, or native manifest remains.
2. Save targeted diffs for extension, native host, installer manifest updates, xtask extension module, and workspace registration.
3. Remove only phase-12 additions after checking concurrent edits.
4. Revert generated extension manifests by regenerating from the prior canonical schema, not by restoring unrelated generated files.
5. Revert only targeted installer ID/protocol hunks.
6. Re-run phase-11 desktop and registration cleanup gates.
7. Never delete real browser profile data, use broad registry deletion, reset the worktree, or clean all untracked files.

## Artifacts

- `artifacts/phase-12/preflight.md`
- `artifacts/phase-12/results.json`
- `artifacts/phase-12/compatibility-matrix.json`
- `artifacts/phase-12/listener-cleanup.json`
- `artifacts/phase-12/registration-cleanup.json`
- `artifacts/phase-12/secret-scan.json`
- `artifacts/phase-12/request-transcripts/*.json`
- Deterministic unsigned extension archives and package inventories
- Failure-only browser traces/screenshots with redaction scan

## Completion Checklist

- [ ] Only explicit action starts a scan; listeners register before exactly one active-tab reload.
- [ ] Every scan settles or times out and removes all listeners/timers automatically.
- [ ] Background tabs are never observed, Studio never rearms/reloads, and restart returns to idle.
- [ ] Chromium, Firefox stable, and Firefox ESR pass equivalent scan tests.
- [ ] Extension direct privileged fetch uses browser session and never hosted proxy.
- [ ] Readable extension bytes produce origin-clean deterministic export.
- [ ] Host/cookie permissions are optional and narrowly requested.
- [ ] Website/deep links are untrusted, unsigned, bounded, non-secret, and
  confirmed; browser enforcement of exact Native Messaging allowed extension
  IDs authenticates the sender, while challenge/nonce only binds the one-use
  session and prevents replay.
- [ ] Website/extension/native handoffs support current and N-1.
- [ ] Cookie handoff uses only consented Native Messaging.
- [ ] Cookies are consented, path/origin/job/expiry scoped, one-use, memory-only,
  intentionally non-persisted, redacted, and best-effort overwritten only in
  owned buffers without a zeroization guarantee.
- [ ] Missing/crashed/incompatible native hosts fail safely before cookie collection where possible.
- [ ] No test leaves listeners, browser profiles, host processes, or registrations.
- [ ] Extension packages contain no remote code, secrets, or proxy path.
- [ ] Build, native-handoff, compatibility, and cross-browser gates pass repeatedly.
- [ ] The phase-12 migration gate row links browser-specific, handoff, redaction, and cleanup evidence.
