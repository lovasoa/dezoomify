# Plans

Multi-step work runs through a plan file in this directory: propose it, get
owner acceptance, execute it phase by phase, and remove it when its work
lands (history keeps the record). There is no separate status ledger; an
active plan is simply a plan file that still has unfinished phases.

## Active plans

- [`website-deploy.md`](website-deploy.md) — GitHub Actions builds the
  entire website (mirrors, help, wasm glue) into `dist/` and deploys it
  to Cloudflare Pages with wrangler; no generated website artifacts stay
  committed and the deployment stops serving repository files. Owner
  Pages-project migration (WD4) gates the untrack phase (WD5).
