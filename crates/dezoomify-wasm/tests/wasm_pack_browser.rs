//! wasm-pack conformance suite, real browser runner
//! (`wasm-pack test --headless --chrome`).
#![cfg(target_arch = "wasm32")]

wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

mod conformance;
