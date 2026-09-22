//! wasm-pack conformance for the typed session surface.
#![cfg(target_arch = "wasm32")]

use dezoomify::model::{HostEffect, JobCommand, JobInput, SessionConfig};
use dezoomify_wasm::Session;
use wasm_bindgen_test::*;

#[wasm_bindgen_test]
fn typed_session_returns_messages_directly() {
    let mut session = Session::new(SessionConfig::default()).expect("session");
    let (messages, snapshot) = session
        .command(JobCommand::Start {
            inputs: vec![JobInput::new("https://example.com/image.dzi")],
        })
        .expect("start");
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostEffect::AcquireResource { .. })));
    assert_eq!(snapshot.lifecycle, dezoomify::model::JobState::Discovering);
}
