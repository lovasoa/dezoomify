# Parity Decisions

Each section records one nontrivial `preserve_with_approved_change` or `retire`
decision with matrix IDs, old and intended behavior, user impact,
compatibility/handoff impact, deterministic test update, approval, and earliest
removal phase. Missing approval means `blocked`.

## D01: Website transport policy replaces silent proxy behavior

- Matrix IDs: HTTP-001; HTTP-002; SEC-001; UI-005 (preflight part)
- Old behavior: all metadata through `/proxy` with silent `X-Set-Cookie`
  accumulation into `&cookies=`; tiles direct; no transport visibility; no
  eligibility checks; proxy enforces no destination/method/size limits.
- Intended behavior: direct browser fetch first; automatic metadata CORS proxy
  fallback only after a classified CORS/network failure for an eligible public
  non-credential metadata request (never tiles) while proxy use is enabled;
  visible active transport; proxy opt-out instead of per-attempt consent; no
  cookies/Authorization/credentials on either proxy hop; SSRF-hardened proxy
  with method/scheme/port/content/size/time/redirect/concurrency/rate/
  session-budget limits.
- User impact: users see which transport is active and can opt out; sites that
  relied on cookie-forwarding metadata fetches now require the extension or
  desktop app (honest guidance, never silent failure).
- Compatibility/handoff impact: extension never uses the proxy; cookie handoff
  stays a separate explicitly consented native-only flow.
- Deterministic tests: `website/proxy-fallback`, `website/proxy-optout`,
  `website/tile-no-proxy`, `website/proxy-redaction`, `website/proxy-security`
  (phase 03 scenarios + phase 08/09 suites).
- Approval: owner approval (autonomous run, per program transport invariant).
- Earliest removal of legacy proxy code/flags: phase 14.

## D02: Retire NYPL format module

- Matrix IDs: FMT-021
- Old behavior: `nypl` core module at `cb13f0b`.
- Intended behavior: module absent; NYPL inputs yield typed no-candidate with a
  recovery action pointing at supported alternatives.
- User impact: NYPL URLs no longer resolve; guidance names the desktop/extension
  manual route.
- Compatibility/handoff impact: none; registry order snapshot covers the removal.
- Deterministic tests: `core/nypl-removed` negative scenario.
- Approval: upstream removal in resolved tip `a304e43` (commit `6f46bd2`-era
  cleanup of dezoomers no live site reaches).
- Earliest removal of legacy references: phase 14.

## D03: Retired extension recognizers stay negative

- Matrix IDs: EXT-002
- Old behavior: `.pff`, `/viewer/p.xml`, Rijksmuseum `getTilesInfo` recognized
  (pre-`d231dd0`); retired upstream in `d231dd0` (#80).
- Intended behavior: remain unrecognized (`undefined`); negative tests pin this.
- User impact: none beyond legacy retirement already shipped.
- Compatibility/handoff impact: none.
- Deterministic tests: `extension/negatives`.
- Approval: upstream retirement (#80) retained.
- Earliest removal of negative tests: never (they guard the retirement).

## D04: Blocking `prompt()` becomes a typed choice

- Matrix IDs: FMT-017
- Old behavior: XLimage page flow blocks on `prompt()` for a page number.
- Intended behavior: job pauses with a typed page-number choice; headless
  callers supply it in the start command.
- User impact: no blocking dialog; cancellable choice UI.
- Compatibility/handoff impact: choice DTO is part of protocol v1 recovery set.
- Deterministic tests: `web/xlimage` with supplied choice + cancellation.
- Approval: owner approval (autonomous run).
- Earliest removal of legacy prompt path: phase 14.

## D05: Silent canvas downscale becomes explicit preflight

- Matrix IDs: UI-005
- Old behavior: images above `UI.MAX_CANVAS_AREA` silently downscale via
  `UI.ratio` with no warning.
- Intended behavior: preflight checks limits before tile download and offers
  native handoff; explicit user-approved downscale remains available.
- User impact: users learn why quality is reduced and get the desktop option.
- Compatibility/handoff impact: handoff carries dimensions + estimates.
- Deterministic tests: `website/too-large` (zero tile requests before handoff).
- Approval: owner approval (autonomous run).
- Earliest removal of silent path: phase 14.

## D06: Extension least-privilege tightening

- Matrix IDs: EXT-008
- Old behavior: MV2 with permanent `<all_urls>` webRequest observation.
- Intended behavior: optional per-origin host/cookie permissions requested after
  explicit user intent; finite scan; no permanent broad hosts.
- User impact: permission prompts per site instead of install-time broad grant.
- Compatibility/handoff impact: denied permission yields classified failure
  with credential-free recovery, never proxy fallback.
- Deterministic tests: `extension/manifest` policy test + permission
  decline/grant/revoke suites.
- Approval: owner approval (autonomous run).
- Earliest removal of legacy manifest: phase 14.

## D07: Live checks are advisory; every live row has deterministic replacement

- Matrix IDs: all `L01-L35` in `live-inventory.csv`
- Old behavior: 35 public-site checks as compatibility evidence.
- Intended behavior: deterministic scenario per row (column
  `deterministic_replacement_id`); live suite stays opt-in and non-blocking.
- User impact: none.
- Compatibility/handoff impact: none.
- Deterministic tests: the replacement scenario IDs in the matrix.
- Approval: program rule (plans README sequencing rule 10).
- Earliest removal: live suite is retained post-cutover as diagnostic.

## D08: Tile Referer preserves legacy full-URI wire bytes

- Matrix IDs: TILE/HEAD parity rows for IIIF/krpano fixed grids
- Old behavior: `Referer` defaults to the full first-tile URI (including path
  and query) for tile requests that opt into referer defaulting.
- Intended behavior: preserve the exact legacy wire bytes; redaction happens
  at the log/diagnostic boundary via `redact_uri`, never by altering requests.
  An `origin_only` helper exists for future display/cache-key contexts but is
  not applied to wire headers in this phase.
- User impact: none (same requests as legacy).
- Compatibility/handoff impact: none.
- Deterministic tests: IIIF/krpano fixed-grid tests assert the full-URI
  Referer; `redact_uri` unit coverage proves logs strip userinfo/sensitive
  query/fragment.
- Approval: owner approval (autonomous run).
- Earliest removal of legacy header shape: only with a versioned protocol
  decision and golden updates.
