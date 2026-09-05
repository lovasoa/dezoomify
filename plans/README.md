# Plans

Multi-step work runs through a plan file in this directory: propose it, get
owner acceptance, execute it phase by phase, and remove it when its work
lands (history keeps the record). There is no separate status ledger — an
active plan is simply a plan file that still has unfinished phases.

## Active plans

- [`cloudflare-build.md`](cloudflare-build.md) — Cloudflare Pages compiles
  and generates the entire website at deploy time into `dist/`; no
  generated website artifacts stay committed and the deployment stops
  serving repository files. Owner dashboard flip (CB3) gates the untrack
  phase (CB4).
