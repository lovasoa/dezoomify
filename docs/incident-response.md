# Incident response

Owners: release owners listed in `release/config.toml`. Severity: critical
(remote code, signing-key compromise, cookie exfiltration),
high (proxy abuse, store compromise), medium (flaky gate, store lag).

1. Pause the affected promotion (website alias or store submission; there is
   no updater rollout to pause) without rebuilding under the same version.
2. Preserve logs, digests, and evidence; revoke test credentials.
3. Follow `docs/rollback-runbook.md` for the affected channel only.
4. Record actions and missing automation in the incident record for the
   affected channel.
