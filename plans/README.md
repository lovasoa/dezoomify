# Plans

Multi-step work runs through a plan file in this directory: propose it, get
owner acceptance, execute it phase by phase, and remove it when its work
lands (history keeps the record). There is no separate status ledger; an
active plan is simply a plan file that still has unfinished phases.

## Completed plans

- [`website-deploy.md`](website-deploy.md): one Pages project (the
  original `dezoomify`), one build (GitHub Actions → `dist/` via
  `scripts/build-site.mjs`, uploaded with wrangler), one branch
  (`master`): legacy at `/`, new app at `/beta`, nothing generated
  committed, no repository files served (completed 2026-09-05).
