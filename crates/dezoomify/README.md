# Shared Rust algorithm

The image-download algorithm used by every Dezoomify product. It understands
source formats, finds images and resolutions, and schedules tile downloads.
Sharing this logic keeps site support and download behavior consistent across
the website, extension, desktop app, and CLI.

The algorithm is independent of its platform. The [native runtime](../dezoomify-native/)
supplies operating-system capabilities, while the [WebAssembly bridge](../dezoomify-wasm/)
connects it to browser capabilities.
