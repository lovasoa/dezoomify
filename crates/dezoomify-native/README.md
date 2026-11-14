# Native runtime

The platform support shared by the [CLI](../../apps/cli/) and
[desktop app](../../apps/desktop/). It provides networking, local-file access,
image encoding, caching, and saving, giving both products the same capabilities
for large images and output formats.

The [shared algorithm](../dezoomify/) decides what to download. This crate
connects those decisions to the operating system; each app supplies its own
interface and user interactions.
