# Rollback runbook

Roll back only the affected channel to its previous immutable artifact; never
rebuild under an existing version. Verify with the same packaged parity
commands, preserve user output/settings, and record the RTO.

## Steps (todo 5.8: no auto-update, manual reinstall)

1. Pick the previous immutable GitHub Release tag (never rebuild under the
   existing version; `cargo xtask release publish` refuses to republish a tag).
2. Download the previous artifacts from that release.
3. Reinstall the matching previous Linux x86_64 `.deb`, Windows x86_64 `.msi`,
   or Apple silicon macOS `.dmg` manually; there is no in-app updater to pull
   the rollback because automatic updates are disabled.
4. Extension stores do not accept an old version as a new submission. Revert
   the faulty change on `master`, let it produce a higher rolling version,
   then submit that signed release through `store-submit`; never create a new
   store item.
5. Preserve user output and settings; record the RTO and release tags
   involved in the incident record.
