# Plans

Multi-step work runs through a plan file in this directory: propose it, get
owner acceptance, execute it phase by phase, and remove it when its work
lands (history keeps the record). There is no separate status ledger; an
active plan is simply a plan file that still has unfinished phases.

## Completed plans

Website deployment consolidation (2026-09-05): one Pages project (the
original `dezoomify`), one build (GitHub Actions to `dist/` via
`scripts/build-site.mjs`, uploaded with wrangler), one branch (`master`):
legacy at `/`, new app at `/beta`, nothing generated committed, no
repository files served. Plan removed; git history is the record.
