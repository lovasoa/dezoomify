# Cutover runbook

1. Verify candidate: `cargo xtask release verify --candidate release/cutover.toml`.
2. Packaged parity: `cargo xtask parity validate --packaged --candidate release/cutover.toml`.
3. Compatibility: `cargo xtask test scenario --suite cutover-compatibility --packaged`.
4. Promote each channel independently (website, updater, stores) with owner approval.
5. Observe acceptance windows in `release/cutover.toml` before legacy deletion.
