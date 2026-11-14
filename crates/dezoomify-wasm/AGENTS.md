For bridge changes, run `cargo xtask test wasm`: ordinary Cargo tests do not
execute the JavaScript Host promises or validate the WASM ABI.
