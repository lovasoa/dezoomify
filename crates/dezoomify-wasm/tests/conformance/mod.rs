//! wasm-pack conformance for the typed session surface.
#![cfg(target_arch = "wasm32")]

use dezoomify_protocol::dto::{HostEffect, JobCommand, JobInputDto, SessionConfig};
use dezoomify_wasm::Session;
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn typed_session_returns_messages_directly() {
    let mut session = Session::new(SessionConfig::default()).expect("session");
    let (messages, _snapshot) = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .expect("start");
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostEffect::AcquireResource { .. })));
    assert_eq!(session.state().as_str(), "Discovering");
}
