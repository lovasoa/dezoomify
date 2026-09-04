# Release

This directory is the single reviewed release inventory. Signing keys are
referenced by CI secret name and never checked in. Promotion steps
(build → sign → publish → deploy → store → updater) run independently with
digest verification at every transition.
