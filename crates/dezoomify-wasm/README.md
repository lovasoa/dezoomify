# WebAssembly bridge

Makes the [shared Rust algorithm](../dezoomify/) available to JavaScript in the
website and extension. It carries asynchronous calls and shared data across the
language boundary, so browser products can use the same algorithm as native apps.

[Browser runtime](../../packages/browser-runtime/) supplies browser access and
image saving. Keeping those capabilities separate lets the bridge serve both
browser products without depending on their user interfaces or permissions.
