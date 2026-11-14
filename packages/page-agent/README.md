# Page agent

Gives the [extension](../../apps/extension/) access to image evidence inside
the page the user is viewing. Some viewers expose their image source only
through running page code, so fetching the page's HTML alone is insufficient.

This package identifies viewers and makes their metadata or live tiles
available to the downloader. The extension handles access and communication;
the Rust core interprets the evidence and assembles the image.
