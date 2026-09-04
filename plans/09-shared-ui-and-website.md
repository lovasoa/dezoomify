# Phase 09: Shared UI And Website

## Objective

Create one React/Vite user interface shared by the website, extension application
page, and desktop app, then ship the web integration. The website must try an
origin-clean direct browser fetch first. After a classified CORS/network failure,
it automatically uses the metadata CORS proxy only for an eligible public
non-credential metadata request and only when the user has not opted out; tiles
are never proxied. It visibly
identifies the active transport and guides the user to ordinary display, the
extension, or the desktop app when policy, browser security, or resource
limits prevent completion.

The website must preserve the distinction between ordinary image display and
saving from readable bytes. Ordinary `<img>` tiles may be drawn into a display canvas
and taint it while remaining visible. The UI must track `originClean = false`,
offer browser/user-agent right-click save guidance where supported, and forbid
only programmatic pixel reads, processing, hashing, `toBlob`, `toDataURL`, and
clean save. Metadata CORS proxy fallback is automatic but never hidden: the UI
identifies `Direct from your browser` or `Metadata proxy`, exposes a user
opt-out, and explains that proxy requests omit credentials.

## Non-Goals

- Do not implement extension request interception, browser-session fetch, cookies, or Native Messaging.
- Do not implement Tauri commands or native download execution.
- Do not host a generic open proxy or permit arbitrary methods, headers, destinations, ports, schemes, redirect chains, or response sizes.
- Automatic eligible metadata proxy fallback requires no additional prompt or
  manual retry. The user control is an opt-out from that fallback.
- Do not claim that drawing a CORS-denied ordinary `<img>` makes it origin-clean.
  Tainted display is allowed; programmatic read/process/hash/save is not.
- Do not persist source URLs, request headers, image contents, or session history by default.
- Do not remove or redirect the legacy website in this phase.
- Do not duplicate runtime state machines in React components.

## Dependencies

- Phase 08 is complete, including `packages/browser-runtime/` and its three-browser gate.
- Earlier phases provide `packages/protocol-ts/`, `crates/fixture-server/`,
  `testdata/scenarios/`, generated capabilities, and the root pnpm/TypeScript
  conventions. This phase creates the shared UI styling rather than
  depending on a not-yet-created token package.
- The deployment target and metadata CORS proxy execution environment were chosen and documented before implementation.
- Public website origin, canonical download links, extension store identifiers, native protocol scheme, privacy-policy URL, and support URL are configured through typed build-time configuration rather than scattered literals.

If shared UI or web paths were established differently in phases 01-07, stop and update this plan before editing. Do not create duplicate React roots.

## Exact Paths

Create or modify only these paths:

- `packages/shared-ui/package.json`
- `packages/shared-ui/tsconfig.json`
- `packages/shared-ui/src/index.ts`
- `packages/shared-ui/src/app/App.tsx`
- `packages/shared-ui/src/app/AppShell.tsx`
- `packages/shared-ui/src/app/useDezoomifyController.ts`
- `packages/shared-ui/src/components/*.tsx`
- `packages/shared-ui/src/styles/*.css`
- `packages/shared-ui/src/testing/*.tsx`
- `packages/shared-ui/test/*.test.tsx`
- `apps/web/package.json`
- `apps/web/index.html`
- `apps/web/vite.config.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/config.ts`
- `apps/web/src/webIntegration.ts`
- `apps/web/src/proxyTransport.ts`
- `apps/web/src/styles.css`
- `apps/web/functions/proxy.ts`
- `apps/web/functions/security.ts`
- `apps/web/tests/*.spec.ts`
- `apps/web/playwright.config.ts`
- `testdata/scenarios/website/**`
- `crates/xtask/src/web.rs`
- `crates/xtask/src/main.rs`
- `docs/product.md`
- `docs/security.md`
- `docs/migration/gates.md` for the phase-09 execution record only
- `artifacts/phase-09/**` for ignored local evidence
- `.github` files only if an existing preview-deployment workflow must register `apps/web`
- root manifests/lockfile only for workspace registration

Do not edit the migration snapshots or extension/native/desktop implementation paths.

## Command Availability

- Available before this phase: `cargo xtask test browser --build-only`, `cargo xtask test browser`, `cargo xtask protocol check`, `cargo xtask fixtures verify`, and the fast deterministic `cargo xtask test`.
- Added during step 4: `cargo xtask test ui` and `cargo xtask dev ui`.
- Added during step 16: `cargo xtask build web` and `cargo xtask dev web`.
- Added during step 18: `cargo xtask test web`.
- The direct `pnpm --filter ./apps/web ...` commands become available after step 7 creates `apps/web/package.json`; `apps/*` membership was established by the phase-05 pnpm workspace.

## Sequential Implementation Steps

1. Run the phase-08 final gate and capture `git status --short`, browser capability output, current bundle sizes, and current deterministic scenario hashes in `artifacts/phase-09/preflight.md`. Confirm no generated-file drift.

   **Validate immediately:** run `cargo xtask test browser`, `cargo xtask protocol check`, and `cargo xtask test`. Stop if any fails for earlier-phase code.

2. Create `packages/shared-ui` manifests. Depend on React, `packages/protocol-ts`, and a narrow interface exported by `packages/browser-runtime`; do not depend on Vite, website functions, WebExtension APIs, or Tauri APIs. Define an `AppIntegration` interface for capabilities, transport offers, save behavior, external links, and handoff requests.

   **Validate immediately:** run `pnpm --filter ./packages/shared-ui typecheck` and the dependency-boundary checker. A test integration must satisfy the interface without browser globals.

3. Implement a reducer/controller in `useDezoomifyController.ts` with explicit states: `idle`, `discovering`, `choosing-image`, `choosing-level`, `preflighting`, `downloading`, `display-only`, `saving`, `completed`, `cancelled`, and `failed`. Store structured protocol errors rather than rendered strings. Ignore stale events by session ID and sequence number.

   **Validate immediately:** use fake timers and a fake integration to test every legal transition, rejected stale events, cancellation, retry, and reset. Run `pnpm --filter ./packages/shared-ui test` and the controller tests.

4. Implement accessible shared components for source input, image/level selection, progress, tile preview, save format, failure details, handoff choices, consent summaries, and completion, and register the `cargo xtask test ui` and `cargo xtask dev ui` targets. Include a plain-language "choose your app" guidance rendered from generated capabilities: when each app works, what each cannot do, and the single best next action, with no technical jargon and no capability claims an app cannot verify. Use semantic controls, visible keyboard focus, live regions with throttled progress, and labels that remain meaningful without color.

   **Validate immediately:** run `cargo xtask test ui`, component tests, and the repository accessibility scanner. Test keyboard-only source submission, picker selection, cancellation, fallback choice, and error-detail expansion. Test that app-choice guidance renders from capability data, stays accurate when capabilities change, and contains no jargon or claims about unavailable apps.

5. Bind the ordinary-display/readable distinction into UI policy. An ordinary
   image canvas must display a persistent `Display only` label, its
   `originClean = false` state, browser/user-agent save guidance where supported,
   and a disabled programmatic save explanation. The readable canvas may
   enable processing and clean save only when runtime capability says
   `origin-clean`. App code must not provoke and catch a `SecurityError` as
   its normal control flow.

   **Validate immediately:** render both fake capabilities. Assert no enabled
   programmatic save control exists for tainted display, save guidance is
   visible, and saving from readable bytes has an accessible format/name description.

6. Implement native/extension handoff views as integration-driven actions. State the reason and the alternatives honestly in plain language, following the layered rules in `docs/product.md`. Show why a handoff is needed, what URL and origin will be shared, whether authentication may be requested later, and a copyable manual fallback. Do not detect installation by probing arbitrary local ports.

   **Validate immediately:** test unavailable, available, launch-rejected, and version-incompatible integration states. Verify rendered diagnostics redact URL userinfo and sensitive query keys defined by protocol policy.

7. Create the Vite website app and typed `src/config.ts`. Validate allowed `https:` public URLs at startup; permit loopback `http:` only in test/development mode. Render the shared `App` with a web integration and no website-specific fork of shared components.

   **Validate immediately:** run `pnpm --filter ./apps/web typecheck` and `pnpm --filter ./apps/web build`. Search the build output through the repository secret scanner and verify no private environment values are embedded.

8. Implement `webIntegration.ts` with ordered transport policy: direct browser
   fetch first with credentials omitted; after a classified CORS/network
   failure, automatic metadata CORS proxy fallback only when the target classifier
   proves a public non-credential metadata request and the user's proxy opt-out is
   disabled (tiles never use the proxy); ordinary image display as a distinct
   user-selectable path; and extension/native handoff suggestions based on
   generated capabilities. Reject proxy
   eligibility for private/local targets, URL userinfo, signed or sensitive
   query credentials, authorization-dependent resources, and any request that
   requires cookies, `Authorization`, browser credentials, or arbitrary user
   headers. Emit visible active-transport state before each request. Never add a
   separate proxy-decision state.

   **Validate immediately:** unit-test exact transport call order. Prove direct
   is always first; the proxy is not called on direct success, before a classified
   CORS/network failure, for input validation errors, cancellation, ordinary-
   display choice, for tile requests, an ineligible/credential-bearing target, or
   while opted out; and an eligible metadata failure automatically calls the
   proxy without another user action.
   Assert ordered `Direct from your browser` then `Metadata proxy` state and
   run `pnpm --filter ./apps/web test -- --run integration`.

9. Implement `proxyTransport.ts` as the browser-side client. Accept only a
   metadata target already classified as public and non-credential. Send only
   that target URL and
   protocol version to same-origin `/api/proxy`; use POST with JSON to avoid
   target query logs; set `credentials: "omit"`, send no `Cookie`,
   `Authorization`, referrer, browser credentials, or user-provided headers;
   enforce response-size metadata before reading; and map proxy policy failures
   to stable protocol codes.

   **Validate immediately:** mock every allowed response and assert no source or
   website cookies, authorization, browser credentials, referrer, or arbitrary
   headers are sent to `/api/proxy` or forwarded upstream. Reject credential-
   bearing targets before the proxy request. Assert cancellation aborts both
   client read and runtime session.

10. Implement `apps/web/functions/security.ts` and `proxy.ts` as a restricted
    metadata fetch relay. Allow only eligible public non-credential metadata
    requests, `GET` and
    `HEAD` upstream, `http:`/`https:` destinations, standard ports unless
    explicitly allowlisted, DNS/IP checks against loopback/private/link-local/
    multicast/metadata ranges, bounded redirects with eligibility validation at
    every hop, strict request/response byte and time limits, and a metadata
    content-type allowlist needed by discovery; image bodies are rejected
    because tiles never use the proxy. Reject URL userinfo,
    signed/sensitive query credentials, authorization-dependent responses, and
    credential-bearing input. Strip cookies, authorization, hop-by-hop headers,
    origin, browser credentials, and unapproved request headers at ingress and
    before every upstream/redirect request. Do not cache private responses. Emit
    request IDs and coarse policy codes, never target query strings.

    **Validate immediately:** run function unit tests for IPv4, IPv6, decimal/octal/hex IP notations, DNS rebinding test doubles, userinfo URLs, alternate ports, redirect-to-private, oversized body, decompression expansion, timeout, unsupported methods, unsupported content types, and valid public fixture paths. Run `pnpm --filter ./apps/web test -- --run proxy-security`.

11. Add explicit anti-open-proxy deployment controls: per-client and global rate limits where supported, target concurrency limits, maximum discovery-resource size, maximum tile size, total session budget token, CORS restricted to the website origin, and an identifiable but non-sensitive `User-Agent`. Document provider-specific enforcement and fail closed when required bindings are absent.

    **Validate immediately:** run local provider emulation with missing bindings and verify startup fails. Run deterministic quota scenarios and verify exact `PROXY_RATE_LIMITED` and `PROXY_BUDGET_EXCEEDED` UI states.

12. Add deterministic website scenarios under `testdata/scenarios/website/`:
    direct success, direct metadata CORS failure then automatic eligible metadata
    proxy success, direct tile CORS failure after metadata success (tiles never
    use the proxy; ordinary image display or a handoff suggestion follows),
    proxy opt-out,
    credential-bearing target rejection, proxy policy denial, proxy limit,
    ordinary image display, tainted-display canvas, extension handoff, native
    handoff, app-choice guidance across capability integration states, and
    too-large image. Co-locate routes, payloads, and
    expected transcripts/results. The taint scenario must visually assemble the
    cross-origin image, display save guidance, throw `SecurityError` only in a
    controlled read, and instrument the app to prove no JavaScript
    read/process/hash/`toBlob`/`toDataURL` attempt and no call to the JavaScript
    save entry point.

    **Validate immediately:** run `cargo xtask fixtures verify` and `cargo xtask parity validate`; verify each scenario has fixed request expectations, ephemeral ports allocated by the server, and no public network dependencies.

13. Add Playwright website tests in Chromium, Firefox, and WebKit. In the
    tainted-canvas case, prove the assembled display remains visible, the unsafe
    control read throws `SecurityError`, `originClean` is false, save guidance is
    displayed, and app instrumentation records no programmatic read,
    processing, hash, `toBlob`, `toDataURL`, or JavaScript save call. Then
    disable proxy opt-out and let the automatic metadata fallback run: direct
    metadata failure, automatic metadata proxy success, and CORS-blocked tiles
    falling back to ordinary image display or a handoff suggestion — never a
    proxy tile request. Verify a save from readable bytes is origin-clean by
    decoded pixels, dimensions, and MIME.
    Compare exact encoded hashes only for the deterministic repository-owned
    encoder. Capture request logs and assert direct attempt, classified CORS/
    network failure, and only then metadata proxy request, with visible transport
    changes and no intermediate user-decision transition.

    **Validate immediately:** run each Playwright project separately. No browser may be skipped because CORS behavior is central to this phase.

14. Add responsive and accessibility tests at 360x640, 768x1024, and 1440x900. Include long translated-like labels, 200-image pickers, reduced motion, dark/light system preferences, keyboard navigation, and screen-reader landmark assertions. Keep the visual language intentional and consistent across app integrations.

    **Validate immediately:** run screenshot tests with pinned fonts and browser versions. Review diffs manually and record approval in `artifacts/phase-09/visual-review.md`.

15. Add privacy and failure UX. Explain direct browser access, automatic metadata
    CORS proxy fallback (metadata requests only), its user opt-out, extension
    browser-session fetch, and native handoff as
    distinct transports. Keep the active transport persistently visible during
    acquisition. Present failures with progressive disclosure per
    `docs/product.md`: the first message is one plain, specific sentence naming
    what failed for this job and the single best next action; an expandable
    section explains the cause and honest alternatives in plain language; raw
    technical detail appears only in copyable diagnostics and linked
    documentation. Gather the structured failure context supplied by the
    protocol — code, phase, transport, resource kind, blocked reason, redacted
    origin, capability snapshot — at error time so diagnostics and support
    reports are specific without asking users to describe technology. Never show
    a bare "unknown error" when a typed error exists. Provide redacted
    copy-diagnostics output. Never place source
    URLs in analytics, document titles, referrers to external links, or unhandled
    exceptions; set a restrictive referrer policy and CSP compatible with
    required image/fetch targets.

    **Validate immediately:** run CSP tests, external-link tests, and artifact
    secret scans using credential-bearing fixture URLs, and prove those targets
    are rejected before any proxy POST. Separately use an eligible public non-
    credential fixture to verify browser history and server logs do not contain
    the source URL when proxy POST is used. Test each failure tier: first
    messages are specific and jargon-free and name a next action, expanded
    explanations remain plain-language, and copy diagnostics contains the
    structured context, version identifiers, and the redacted origin but no
    cookies, credentials, sensitive query values, or response content.

16. Add `cargo xtask build web` and `cargo xtask dev web` in
    `crates/xtask/src/web.rs`: verify generated files, build Wasm, build shared
    UI and website, enforce bundle budgets, inspect output for forbidden
    development URLs/source maps/secrets, and start the loopback development
    services with owned cleanup.

    **Validate immediately:** run `cargo xtask build web` twice and verify deterministic assets/manifests where expected and no second-run source diff. This command becomes available only after this step.

17. Add install/handoff link behavior resilient to store and app update lag.
    Website and deep-link payloads are untrusted, bounded, non-secret hints and
    require confirmation; they are not signed and do not authenticate their
    sender. The website must read generated minimum/maximum compatible protocol
    versions, show `Update required` only after an actual handshake result, and
    always provide manual CLI instructions compatible with protocol N-1. Do not
    assume the newest extension or desktop release is already approved in stores.

    **Validate immediately:** test current website against test integrations representing current, N-1, N-2, newer, absent, and launch-blocked peers. Current and N-1 must complete supported handoffs; incompatible versions must fail with deterministic guidance rather than malformed deep links.

18. Add `cargo xtask test web` to start both deterministic origins and proxy emulator, run unit/accessibility tests, then all Playwright engines, and clean up child processes and profiles. Write `artifacts/phase-09/results.json`.

    **Validate immediately:** run `cargo xtask test web` twice, including once with rate limits set to the deterministic minimum. Verify process cleanup and stable request transcripts. This command becomes available only after this step.

19. Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, the root pnpm lint/typecheck commands, `cargo xtask protocol check`, `cargo xtask test`, `cargo xtask test browser --build-only`, `cargo xtask build web`, `cargo xtask test browser`, and `cargo xtask test web`.

    **Validate immediately:** inspect `git diff --check`, root lockfile changes, deployment output, and artifact redaction. No legacy path may be deleted or redirected.

20. Append the phase-09 row in `docs/migration/gates.md` with exact commands, deterministic artifacts, approved exceptions, and reviewer. Do not modify other rows.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/09-shared-ui-and-website.md` and verify tainted-canvas, proxy policy, and three-browser results are linked.

## Deterministic User Workflows

### Website Direct Fetch

1. Run `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` and read the `website-direct-success` scenario under `testdata/scenarios/website/website-direct-success/`.
2. Open the printed website URL in Chromium.
3. Paste the printed source URL and submit.
4. Verify active transport says `Direct from your browser` and no proxy control
   or request appears.
5. Select the only image and highest level.
6. Save PNG and compare decoded pixels, dimensions, and MIME with the scenario; compare exact bytes only when the repository-owned deterministic encoder is selected.
7. Verify the request transcript contains direct metadata/tile requests and zero `/api/proxy` requests.
8. Repeat through automated Firefox and WebKit projects.

### Metadata Proxy Fallback

1. Load `website-cors-denied-proxy-metadata`.
2. Submit the source URL.
3. Verify active transport is `Direct from your browser` until the direct browser fetch fails
   with the scenario's classified CORS/network outcome.
4. Verify the eligible public non-credential metadata request automatically retries with
   active transport `Metadata proxy`, without another user action.
5. Verify tiles: readable tiles use the direct browser fetch when CORS-allowed;
   CORS-blocked tiles fall back to ordinary image display or a handoff
   suggestion, and the transcript contains zero proxy tile requests.
6. Verify proxy request bodies contain only protocol version and target URL;
   client and upstream logs contain no browser/website/source cookies,
   `Authorization`, browser credentials, or user-provided credential headers.
7. Enable proxy opt-out in a second run and verify the classified direct failure
   occurs but no proxy request is made.
8. Repeat with a credential-bearing target and verify it is ineligible before
   `/api/proxy`, regardless of opt-out state.

### Tainted Canvas Safety

1. Load `website-tainted-canvas-trap`.
2. In the test control, draw the cross-origin image and verify pixel read throws `SecurityError`; this proves the scenario is genuinely tainted.
3. Enable proxy opt-out, start the app's readable path, verify the direct
   browser attempt fails with the classified CORS/network outcome, then choose
   ordinary image display.
4. Verify the image tiles are visibly assembled in the app display canvas,
   `originClean` is false, save guidance is shown, and programmatic save is
   disabled without an app read/process/hash/save attempt.
5. Disable the proxy opt-out and restart readable acquisition; verify the direct
   failure precedes automatic metadata CORS proxy fallback for the metadata
   request (never tiles) and both transports are visibly identified.
6. Save and verify the resulting canvas is origin-clean and its decoded pixels,
   dimensions, and MIME match; compare exact bytes only with the repository-owned
   deterministic encoder.

### Large Image Handoff

1. Load `website-too-large` with deterministic low browser limits.
2. Verify preflight makes zero tile requests.
3. Verify extension is not offered as a memory-limit solution unless its declared capability differs.
4. Verify native launch and manual CLI choices show the exact source URL after redaction preview.
5. Reject launch and verify the website remains usable with no repeated prompt.

### Guided App Choice And Honest Failures

1. Load the `website-guidance` scenario with test integrations representing three capability states: web-only, extension-available, and native-available.
2. Verify the app-choice guidance matches generated capabilities for each state, recommends only available apps, and states each app's limits as plain facts.
3. Load the `website-access-denied-guidance` scenario and submit an ineligible source.
4. Verify the first failure message is one plain sentence naming what happened and one best next action, with no technical terms.
5. Expand "what happened" and verify a plain-language explanation of the block and the honest alternatives, including what the extension or desktop app would do differently.
6. Copy diagnostics and verify it contains the error code, phase, transport, redacted origin, and app/protocol versions, and no cookies, credentials, sensitive query values, or response content.
7. Repeat in one additional browser engine to confirm wording comes from capability data, not browser detection.

### Protocol And Store Lag

1. Start test integrations for protocol current, N-1, N-2, and future versions.
2. Verify current and N-1 actions remain available.
3. Verify N-2 and future incompatible test integrations show an update/manual path without losing the entered source.
4. Set extension store status to `pending` and desktop updater status to `staged`; verify the website does not advertise a feature absent from their generated capability documents.

## Stop Conditions

- Stop if proxy restrictions cannot prevent private-network access and redirect bypasses in the selected hosting platform.
- Stop if the proxy must receive browser cookies, source-site authorization, or arbitrary user headers.
- Stop if proxy is attempted before a classified direct CORS/network failure,
  for an ineligible metadata request, for a tile, or while the user opt-out is enabled.
- Stop if direct/proxy active transport is not visible or either website
  transport includes browser credentials.
- Stop if any website path claims a tainted display is origin-clean/savable,
  or if app code attempts programmatic pixel reads, processing, hashing,
  `toBlob`, or `toDataURL` while `originClean` is false.
- Stop if user-facing guidance or error copy leads with technical jargon,
  claims a capability the active app does not have, or leaves the user
  without a next action.
- Stop if React components import WebExtension or Tauri APIs directly.
- Stop if deterministic CORS/taint tests do not fail in the unsafe control case; the fixture is invalid.
- Stop if deployment requires exposing secrets in Vite client variables.
- Stop if current and N-1 protocol scenarios cannot render a safe guided fallback.
- Stop if any required test reaches the public internet or relies on extension-store availability.

## Risks And Mitigations

- **Proxy becomes an SSRF/open-proxy service:** strict URL/IP/redirect validation, quotas, method/header stripping, byte limits, and dedicated abuse tests.
- **Users mistake proxy for direct access:** persistent active-transport label,
  clear automatic-fallback disclosure, and a user opt-out.
- **Canvas taint regression:** explicit `originClean` state, visible-display and
  controlled-`SecurityError` tests, app-call instrumentation, and separate
  readable processing/saving coverage in every engine.
- **Shared UI accumulates app conditionals:** integration capability interface and boundary lint rules.
- **Website outruns store releases:** generated capability/version checks, N-1 compatibility, and manual/native alternatives.
- **Large-image browser crash:** preflight before tiles and a native handoff suggestion.
- **Sensitive URL leakage:** POST proxy API, redaction, referrer policy, no URL analytics, and artifact scanning.

## Safe Rollback

1. Save targeted diffs for `packages/shared-ui`, `apps/web`, `crates/xtask/src/web.rs`, `testdata/scenarios/website`, and only the root registration hunks.
2. Disable a deployed preview using the hosting provider's version rollback; do not alter DNS or legacy production routing in this phase.
3. Remove newly added files only after checking no concurrent worker modified them.
4. Revert manifest and lockfile entries with an exact patch, preserving unrelated dependencies.
5. Re-run phase-08 gates to prove browser runtime remains intact.
6. Never reset the worktree, delete untracked directories broadly, or restore entire shared manifests from `HEAD`.

## Artifacts

- `artifacts/phase-09/preflight.md`
- `artifacts/phase-09/results.json`
- `artifacts/phase-09/visual-review.md`
- `artifacts/phase-09/proxy-policy-tests.json`
- `artifacts/phase-09/request-transcripts/*.json`
- `artifacts/phase-09/bundle-report.json`
- Failure-only Playwright traces/screenshots
- Deployment preview URL and immutable build identifier, recorded without credentials

## Completion Checklist

- [ ] Shared React UI has no website, extension, or Tauri imports.
- [ ] Plain-language app-choice guidance renders from generated capabilities
  and states each app's limits honestly without jargon.
- [ ] Error presentation uses progressive disclosure: specific, jargon-free
  first messages that name a next action, plain-language expanded causes, and
  technical detail only in diagnostics and docs.
- [ ] Copy diagnostics includes structured redacted failure context and version
  identifiers without secrets.
- [ ] Website always tries a direct browser fetch before using the metadata CORS
  proxy (metadata only) or exposing ordinary display fallback.
- [ ] After classified CORS/network failure, eligible public non-credential
  metadata requests automatically use the metadata CORS proxy unless the user
  opted out; tiles never use the proxy; no additional user decision is required.
- [ ] Active transport is visible and tests prove no proxy before classified
  failure, opt-out suppression, ineligible-target rejection, zero proxy tile
  requests, and credential
  omission/stripping on both proxy hops.
- [ ] Proxy rejects private networks, unsafe redirects, methods, headers, ports, types, and sizes.
- [ ] Ordinary cross-origin image assembly remains visible, records
  `originClean = false`, displays save guidance, and never reaches app
  programmatic read/process/hash/save code.
- [ ] Direct browser-fetch saves are origin-clean; the proxy never serves tiles;
  cross-browser checks
  compare decoded pixels/dimensions/MIME and exact bytes only for the
  repository-owned deterministic encoder.
- [ ] Tainted-canvas controls and app-safe behavior pass in Chromium, Firefox, and WebKit.
- [ ] Large images get a handoff suggestion before tile downloads.
- [ ] Extension/native guided handoff supports current and N-1 protocol capabilities.
- [ ] Store/update lag states are tested without public services.
- [ ] Accessibility, responsive, CSP, privacy, and bundle gates pass.
- [ ] `cargo xtask build web` and `cargo xtask test web` pass twice without source drift.
- [ ] The phase-09 migration gate row links deterministic web and proxy evidence.
- [ ] Legacy deployment remains untouched.
