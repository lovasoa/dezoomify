# dezoomify-core

Recognizes zoomable-image formats (IIIF, Deep Zoom, Zoomify, krpano, …) and
turns pages and metadata into exact tile-download plans. Pure logic: give it
bytes, get back a plan. It never touches the network, disk, clock, or image
codecs, so every host (web, desktop, CLI, extension) shares identical
behavior. Purity is enforced by tests, not convention.

```sh
cargo xtask test core            # full core suite
cargo xtask test core --parity   # format-parity corpus
cargo xtask test core --purity   # dependency/purity audit
```
