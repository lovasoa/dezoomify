# Legacy website retirement

The legacy website remains at `/` and the new website remains at `/beta`.
This plan concerns a future switch and requires an explicit owner decision.

## Preconditions

- The owner accepts the new website as the full replacement, including image
  compatibility, help, saving, and the metadata CORS proxy.
- All required checks pass on `master`, including `cargo xtask check`,
  `cargo xtask test`, `cargo xtask test all`, and `cargo xtask ci local`.
- The website-deploy workflow is the sole publisher to the existing Cloudflare
  Pages project, with working deployment credentials and production checks.

## One atomic change

1. Delete `legacy/` and the `functions/proxy.js` entry point. Remove `/proxy`
   from the routing manifest and deployment checks. Verify no imports depend
   on those files before deleting them.
2. Configure Vite and `scripts/build-site.mjs` to build the new website directly
   into `dist/`. Remove legacy copying and the `/beta` prefix. Keep generated
   help, hashed JavaScript and WASM assets, and the `/api/proxy` function.
3. Update the website deployment checks to inspect the built entry page and
   its actual asset URLs. Require correct JavaScript and WASM MIME types,
   working help, a restricted metadata proxy, and no exposed repository files.
   Check that retired website paths return 404.
4. Update fixture-server routes, browser tests, documentation, and `AGENTS.md`
   to the single website layout. Remove this plan when the switch lands.

## Verification

- A clean `node scripts/build-site.mjs` produces the new website at `dist/`
  with help and assets reachable from its entry page. There is no `dist/beta/`
  or legacy website code in the output.
- `_routes.json` includes only `/api/proxy`.
- Browser scenarios cover starting, cancelling, saving, partial output,
  metadata proxy fallback, and help at the root address.
- `cargo xtask check`, `cargo xtask test`, `cargo xtask test all`, and
  `cargo xtask ci local` pass before the commit lands.
- The website-deploy workflow passes its production checks after deployment.

## Rollback

Revert the single switch commit and let the normal workflow redeploy. The
revert restores the legacy website at `/`, the new website at `/beta`, and
their routing and deployment checks. No stored user data changes during the
switch.
