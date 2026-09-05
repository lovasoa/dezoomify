//! wasm-pack conformance suite (runs under `wasm-pack test --node` and
//! `--headless --chrome`): the wasm-bindgen JS surface (protocol version,
//! the job-delegating `Session`, and the core-backed `DiscoverySession`)
//! must behave identically on the wasm target.

// Shared wasm-pack conformance suite: included by `wasm_pack.rs` (Node)
// and `wasm_pack_browser.rs` (real Chromium via --headless).
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::*;

use dezoomify_protocol::codec;
use dezoomify_protocol::dto::{ControlBody, ControlEnvelope, JobCommand};
use dezoomify_wasm::wasm_api::JsDiscoverySession;
use dezoomify_wasm::{protocol_version, Session};

fn envelope_bytes(body: ControlBody) -> Vec<u8> {
    let envelope = ControlEnvelope::new(body).expect("envelope constructs");
    codec::encode(&envelope).expect("envelope encodes")
}

#[wasm_bindgen_test]
fn protocol_version_is_1_0() {
    assert_eq!(protocol_version(), "1.0");
}

#[wasm_bindgen_test]
fn session_lifecycle_via_js_surface() {
    let mut session = Session::new("1.0", "{}").expect("session constructs");
    session
        .dispatch(&envelope_bytes(ControlBody::Command(JobCommand::Start {
            job: "job:wasm-pack-1".parse().expect("job id"),
            input_url: "https://example.com/item/1".to_string(),
        })))
        .expect("start");
    let messages = session.drain_messages();
    assert_eq!(messages.len(), 2, "acquire-resource + job-state");
    let transcript = String::from_utf8_lossy(&messages[0]);
    assert!(transcript.contains("acquire-resource"));
    assert_eq!(session.state().as_str(), "Discovering");
}

#[wasm_bindgen_test]
fn session_rejects_wrong_version() {
    let error = Session::new("2.0", "{}").expect_err("2.0 rejected");
    assert!(error.to_string().contains("version"), "{error}");
    let error = Session::new("9.9", "{}").expect_err("9.9 rejected");
    assert!(error.to_string().contains("version"), "{error}");
}

#[wasm_bindgen_test]
fn discovery_session_resolves_a_zoomify_catalog_without_network() {
    const IMAGE_PROPERTIES: &str = r#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#;
    let mut session = JsDiscoverySession::new("https://example.com/a/ImageProperties.xml".into())
        .expect("discovery session");
    let need = session.next_need();
    let need: serde_json::Value = serde_json::from_str(&need).expect("need json");
    assert_eq!(need["uri"], "https://example.com/a/ImageProperties.xml");
    session
        .provide(
            need["id"].as_u64().unwrap() as usize,
            IMAGE_PROPERTIES.as_bytes(),
            "".into(),
        )
        .expect("provide");
    let catalog = session.finish().expect("catalog");
    let catalog: serde_json::Value = serde_json::from_str(&catalog).expect("catalog parses");
    assert_eq!(catalog["images"][0]["format"], "zoomify");
    // The 512-wide level must plan a real 2x2 tile grid, matching the native
    // conformance suite (src/discovery.rs tests).
    let levels = catalog["images"][0]["levels"]
        .as_array()
        .expect("levels array")
        .len();
    let mut plan = None;
    for level in 0..levels {
        let candidate: serde_json::Value =
            serde_json::from_str(&session.level_tiles(0, level as u32).expect("plan"))
                .expect("plan json");
        if candidate["canvas"]["x"] == 512 {
            plan = Some(candidate);
            break;
        }
    }
    let plan = plan.expect("512-wide level exists");
    assert_eq!(plan["kind"], "resolved");
    assert_eq!(plan["tiles"].as_array().expect("tiles").len(), 4);
}
