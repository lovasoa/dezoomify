mod support;

use dezoomify_engine::Config;
use support::JobCommand;
use support::{ScriptedHost, DZI, DZI_INPUT_URL};

fn dzi_bytes() -> Vec<u8> {
    DZI.as_bytes().to_vec()
}

#[test]
fn over_limit_tiles_become_typed_terminal_failure() {
    let tight = Config {
        max_concurrent_fetches: 1,
        max_concurrent_decodes: 1,
        max_tiles: 1,
        max_buffers: 4,
        ..Config::default()
    };
    let mut host = ScriptedHost::new("job:limited", DZI_INPUT_URL, tight).unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: dzi_bytes(),
        final_uri: None,
    })
    .unwrap();
    host.apply(JobCommand::SelectImage { image: 0 }).unwrap();
    host.apply(JobCommand::SelectLevel { level: 9 }).unwrap();
    // Planning the four-tile largest level against max_tiles=1 is a typed
    // resource-limit failure, never a panic or silent truncation.
    assert_eq!(host.state(), "Failed");
    let failed = host.failed_events();
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0].get("code").and_then(serde_json::Value::as_str),
        Some("job.resource-limit")
    );
    // Post-terminal inputs stay stably rejected.
    let err = host.apply(JobCommand::Cancel).unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
}
