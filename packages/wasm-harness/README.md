# WASM harness

Tests the compiled Rust/JavaScript bridge with asynchronous Host capabilities.
It catches promise, value-conversion and error-propagation failures that native
Rust tests cannot exercise. Its offline environment isolates those failures
from browser permissions and product UI.

The harness connects [dezoomify-wasm](../../crates/dezoomify-wasm/) to test Hosts
and [browser-runtime](../browser-runtime/). Browser and packaged-product tests
cover the surrounding user flows separately.
