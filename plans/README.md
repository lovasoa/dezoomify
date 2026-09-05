# Plans

Multi-step work runs through a plan file in this directory: propose it, get
owner acceptance, execute it phase by phase, and remove it when its work
lands (history keeps the record). There is no separate status ledger; an
active plan is simply a plan file that still has unfinished phases.

## Active plans

- [`website-deploy.md`](website-deploy.md): one Pages project, one build:
  the legacy site vendored under `legacy/` serves `/`, the new app
  serves `/beta`, and a GitHub Actions workflow builds and deploys
  everything with wrangler. Owner project setup (WD6) gates untracking
  the generated artifacts (WD7).
