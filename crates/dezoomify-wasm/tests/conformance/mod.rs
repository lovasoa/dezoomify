//! wasm-pack conformance suite (runs under `wasm-pack test --node` and
//! `--headless --chrome`): the wasm-bindgen JS surface (protocol version and
//! the job-delegating `Session`) must behave identically on the wasm target.

// Shared wasm-pack conformance suite: included by `wasm_pack.rs` (Node)
// and `wasm_pack_browser.rs` (real Chromium via --headless).
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::*;

use dezoomify_protocol::codec;
use dezoomify_protocol::dto::{ControlBody, ControlEnvelope, JobCommand};
use dezoomify_wasm::{protocol_version, Session};

fn envelope_bytes(body: ControlBody) -> Vec<u8> {
    let envelope = ControlEnvelope::new(body).expect("envelope constructs");
    codec::encode(&envelope).expect("envelope encodes")
}

#[wasm_bindgen_test]
fn protocol_version_is_2_0() {
    assert_eq!(protocol_version(), "2.0");
}

#[wasm_bindgen_test]
fn session_lifecycle_via_js_surface() {
    let mut session = Session::new("2.0", "{}").expect("session constructs");
    session
        .dispatch(&envelope_bytes(ControlBody::Command(JobCommand::Start {
            input_url: "https://example.com/image.dzi".to_string(),
        })))
        .expect("start");
    let messages = session.drain_messages();
    assert_eq!(messages.len(), 2, "job-state + acquire-resource");
    let state = String::from_utf8_lossy(&messages[0]);
    assert!(state.contains("job-state"), "state leads: {state}");
    let effect = String::from_utf8_lossy(&messages[1]);
    assert!(
        effect.contains("acquire-resource"),
        "effect follows: {effect}"
    );
    assert_eq!(session.state().as_str(), "Discovering");
}

#[wasm_bindgen_test]
fn session_rejects_wrong_version() {
    let error = Session::new("1.0", "{}").expect_err("1.0 rejected");
    assert!(error.to_string().contains("version"), "{error}");
    let error = Session::new("9.9", "{}").expect_err("9.9 rejected");
    assert!(error.to_string().contains("version"), "{error}");
}
