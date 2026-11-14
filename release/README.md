# Release and recovery

The [release workflow](../.github/workflows/release.yml) publishes immutable
artifacts from a commit that passed CI. Dispatch it on the reviewed branch;
retry failed jobs using their frozen artifacts. Never rebuild an existing version.

**Reconcile uncertain store submissions and incomplete draft releases before
retrying.** Check the store's exact version and the GitHub deployment ledger.
Firefox can reconcile an uncertain attempt when AMO confirms that version is
public; acceptance still does not mean store review has completed.

Keep signing keys backed up separately from source. Losing the updater key
breaks trust for installed apps. Verify installation through the
[desktop workflow](../.github/workflows/desktop.yml) before publishing.

To roll back, reinstall an older immutable artifact. Stores and automatic
updates require an increasing version: release the reverted code as a new version.
For compromised credentials, pause affected publishers, rotate credentials,
and preserve release provenance and recovery decisions in the incident.

The [website workflow](../.github/workflows/website-deploy.yml) publishes the
assembled site. Previews are public; exclude private source and credentials.
