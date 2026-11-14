# Browser extension

The extension downloads from a page the user is viewing, including pages that
require a browser login or expose image information only through their viewer.
It provides browser permissions, source-page access, and download integration.

The [page agent](../../packages/page-agent/) gathers information inside the
source page. The [browser runtime](../../packages/browser-runtime/) connects
that evidence to the shared Rust downloader and [shared UI](../../packages/shared-ui/).
The [website](../../src/) uses the same browser foundation with public-resource
access. See the [extension guide](../../docs/user/browser-extension.md) for use.
