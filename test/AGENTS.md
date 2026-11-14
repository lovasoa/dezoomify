- Cover a behavior at its owning layer: parser geometry in core tests,
  source access in extension tests, viewer adapters in page-agent tests.
  Shared `fixtures/` already exercise successful saves across products.
- Use the shared Playwright fixtures for page isolation. Give each UI scenario
  fresh state and storage; control pending work with barriers instead of sleeps.
- Keep fixture protocol behavior in fixture-local handlers. Unknown fixture
  requests must never reach the internet. Use the Node raw server for malformed
  wire responses; unmodified third-party test subjects are allowed.
- Browser binaries are separate prerequisites. Desktop window tests need a
  display (`xvfb-run -a` on headless Linux) and Windows checkouts need Git symlinks.
  PDF rendering tests need installed Poppler. Choose targets from xtask help.
