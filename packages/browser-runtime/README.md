# Browser runtime

Runs the Rust downloader in the website and extension, supplying browser
networking, image decoding and canvas output. Sharing this runtime keeps
download behavior consistent while each product supplies its own source
access, permissions and saving.

It connects the downloader to [shared-ui](../shared-ui/) and the product's
browser capabilities. The extension also uses [page-agent](../page-agent/) to
reach image sources inside the page the user is viewing.
