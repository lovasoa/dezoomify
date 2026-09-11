# React and Vite migration

Status: implemented through Phases 1, 2, 3, and 5. The extension job tab now
renders through the React shared UI and the vendored mirrors, modal, and
generated website JS are gone. Phase 4.3-4.5 (a job-tab native-handoff action
built on `connectNative`) remains as the one follow-up; the runtime and
background handoff code stays in place meanwhile.

## Grounding

- `packages/shared-ui/src/view.ts` is the host-neutral, imperative renderer.
  It is used by `src/main.ts`, `apps/desktop/src/main.ts`, and the extension
  job tab. `packages/shared-ui/src/controller.ts` remains the shared state
  contract.
- The website is a static module graph assembled by
  `scripts/build-site.mjs`, served below `/beta`; the legacy website remains
  at `/`. `plans/legacy-retirement.md` is the only authority for the future
  root cutover.
- The desktop app already uses Vite with Tauri. Its host integration owns IPC,
  native output, deep-link validation, and external navigation policy.
- WXT now owns the extension build at `apps/extension/wxt.config.ts`.
  Chromium uses its MV3 service worker and Firefox uses the tested classic
  IIFE `background.scripts` output. The manifest's least-privilege contract
  is enforced by `apps/extension/tests/unit/manifest-policy.test.mjs`.
- The extension's dedicated WXT job page is the shipped graphical extension
  flow. `apps/extension/src/modal/` is dormant code, but it currently contains
  the only product wiring for native handoff.

## Non-negotiable contracts

- Core remains pure and deterministic. Dependencies continue to point inward;
  shared UI has no host globals, Tauri imports, or extension APIs.
- Preserve direct browser fetch first and metadata CORS proxy fallback for the
  website. Keep browser-session fetch in the extension.
- Preserve normal image display versus readable bytes: a tainted canvas stays
  display-only and is never pixel-read or serialized afterward.
- Keep extension permissions limited to `activeTab`, `scripting`, and
  `nativeMessaging`, with `cookies` and HTTP(S) hosts optional. Do not add
  `tabs`, `downloads`, content scripts, offscreen documents, permanent hosts,
  or web-accessible resources.
- Native handoff is a shipped extension job-tab feature. It uses one
  `runtime.connectNative` port bound to the active job; consent names only
  origins and cookie names, precedes optional-cookie permission and reads, and
  never persists credentials. Decline and typed failures leave the extension
  job cookieless.
- Nothing generated for the website is committed. Remove generated mirrors
  only once Vite and WXT no longer consume them.

## Phase 1: React shared UI

1. Add React and its type dependencies to `packages/shared-ui` and the product
   packages that mount it. Keep the shared package source-first; do not add a
   second prebuilt shared-UI distribution.
2. Replace `packages/shared-ui/src/view.ts`'s `renderView`, DOM mutation, and
   string-HTML modal helpers with typed React components for input/history,
   active job, display-only, completed, failed, cancelled, image/level choice,
   and confirmation dialogs.
3. Preserve controller state, public callback semantics, stable element IDs,
   `dz-*` styling hooks, focus behavior, and the parchment visual language.
   Translate all visible copy through `t(...)` and update all locale tables in
   lockstep.
4. Move only presentation into React. Keep `components.ts` helpers that remain
   useful as pure formatting functions; do not move browser, native, or
   extension effects into shared UI.
5. Replace mock-DOM renderer assertions with React DOM tests for state phases,
   form actions, modal keyboard/focus behavior, localization, accessibility,
   and mobile layouts.

## Phase 2: Website Vite migration

1. Add a root Vite configuration and React entrypoint for the new website,
   configured with `base: "/beta/"`. Convert `index.html` to a minimal Vite
   shell while moving navigation, footer, guidance dialogs, app status card,
   and preview controls into React components.
2. Keep job orchestration, queues, browser fetch policy, worker protocol,
   history persistence, canvas assembly, and Blob save as host effects. Expose
   a typed snapshot/subscription boundary from the web host to React rather
   than duplicating controller state in components.
3. Adapt the preview control in `packages/browser-runtime/src/preview.ts` to
   operate through a React ref or injected surface while retaining its
   transform-only, tainted-canvas-safe invariant.
4. Replace `scripts/sync-web-js.mjs` and the source-module graph copying in
   `scripts/build-site.mjs` with the Vite production build. The site builder
   still builds help and WASM, copies Vite assets plus help/WASM below
   `dist/beta/`, copies legacy at `/`, and writes both `/api/proxy` and
   `/proxy` routes.
5. Update `crates/xtask/src/browser.rs`, web tests, and
   `.github/workflows/website-deploy.yml` to validate the Vite manifest/assets,
   `/beta` base paths, worker/WASM MIME types, help, proxy routes, and source
   exposure without assuming `src/main.js` is served.

## Phase 3: Desktop React shell

1. Add the Vite React plugin to `apps/desktop/vite.config.ts` and mount a
   React root from `apps/desktop/src/main.ts` without changing Tauri's
   `beforeBuildCommand`, `beforeDevCommand`, `devUrl`, `frontendDist`, or CSP
   contract.
2. Keep IPC subscription, typed recovery, queue control, save/output actions,
   diagnostics construction, deep-link validation, and external-link
   validation in the desktop host. Feed their current state and callbacks to
   React through a typed snapshot.
3. Replace the imperative desktop settings panel, queue/recovery panels,
   deep-link confirmation, diagnostics-copy feedback, header, and footer with
   React components. Preserve local settings validation, secret-redaction, and
   fail-closed external navigation behavior.
4. Update desktop unit and real-window E2E coverage for settings, output
   actions, recovery choices, deep-link confirmation, and external link policy.

## Phase 4: Extension job-tab React and native handoff

1. Keep `apps/extension/entrypoints/background.ts`, `wxt.config.ts`, and the
   existing WXT manifest/package checks. Convert only the WXT job page and its
   UI integration to React.
2. Replace `apps/extension/src/job/index.ts` DOM rendering for shared view,
   host-permission prompt, and partial-output choice with React state and
   components. Preserve coordinator binding validation, source-operation
   transport, worker startup, permission flow, canvas assembly, and Blob-anchor
   save behavior.
3. Add a job-tab native-handoff action to completed and display-only results.
   Use `requestNativeHandoff` with `connectNative` and the current
   `{ jobId, tabId, frameId, documentGeneration }` binding; do not port the
   modal's legacy `sendNativeMessage` path.
4. Render consent in React. Consent shows the native host, exact origins,
   cookie names, and job ID, initially focuses the decline action, traps focus,
   and treats Escape/backdrop dismissal as decline. Optional `cookies` and
   host permissions are requested only from the explicit action.
5. Extend native-handoff tests for persistent-port messages from the real job
   binding, no cookie read before consent, scope isolation, typed disconnect
   failures, and one credential message at most. Extend packaged Chromium and
   Firefox coverage for the exposed action where the native host test harness
   can be installed deterministically.

## Phase 5: Remove superseded paths

After replacement tests are green, remove in the same change series:

- `packages/shared-ui/src/view.ts`'s imperative renderer and all generated
  website JS mirrors made obsolete by Vite.
- `scripts/sync-web-js.mjs` and its website-mirror tests.
- `apps/extension/src/vendor/` generated JS/CSS mirrors and their parity tests,
  after WXT bundles direct workspace imports.
- `apps/extension/src/modal/` and its modal-only loader/tests.
- `apps/extension/src/app/extensionIntegration.ts`, `src/app/messages.ts`, and
  their tests if the final reachability audit confirms no shipped consumer.

Do not remove `apps/extension/src/runtime/nativeHandoff.ts`, native-host code,
or native-messaging tests: they support the shipped job-tab handoff feature.

## Verification and completion

1. Run focused `cargo xtask test ui`, `cargo xtask test web`,
   `cargo xtask test desktop`, `cargo xtask test extension`, and
   `cargo xtask test native-messaging` after their respective phases.
2. Confirm the deployed tree still serves legacy at `/` and Vite React at
   `/beta`, including help, both proxy routes, and strict WASM MIME checks.
3. Confirm both WXT store packages retain manifest parity, no dead payload
   files, and Firefox's parseable classic background artifact.
4. Finish with `cargo xtask check`, `cargo xtask test`, `cargo xtask test all`,
   and `cargo xtask ci local`.
5. Run a reachability and generated-artifact audit before every deletion. The
   finished tree has one current implementation for each product flow, with no
   parallel imperative renderer, source mirror, dormant modal, or custom
   extension builder.
