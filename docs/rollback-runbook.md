# Rollback runbook

Roll back only the affected channel to its previous immutable artifact; never
rebuild under an existing version. Verify with the same packaged parity
commands, preserve user output/settings, and record RTO and digests.

## Steps (todo 5.8: no auto-update, manual reinstall)

1. Pick the previous immutable GitHub Release tag (never rebuild under the
   existing version; `cargo xtask release publish` refuses to republish a tag).
2. Download the previous artifacts plus `SHA256SUMS` and every `.sig` from
   that release.
3. Verify before use: `sha256sum -c SHA256SUMS`, then `gpg --verify
   SHA256SUMS.sig` (and per-artifact `.sig` files) against
   `release/gpg-public-key.asc`. A mismatch or missing signature stops the
   rollback.
4. Reinstall manually: Linux `.deb` via the package manager; there is no
   in-app updater to pull the rollback (automatic updates are disabled) and
   no Windows/macOS installer in this wave.
5. Extension rollback is a resubmit of the previous per-browser zip to the
   existing listings (Chromium `iapjjopjejpelnfdonefbffahmcndfbm`, Firefox
   AMO guid `{14074c89-8a5f-4813-98df-a7117f062871}`) via `store-submit`;
   never create a new store item. AMO rejects duplicate version strings, so
   a rolled-back Firefox version must ship under a new version number.
6. Preserve user output and settings; record the RTO, the verified digests,
   and the release tags involved in the incident record.
