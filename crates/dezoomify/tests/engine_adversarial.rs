mod support;

use dezoomify::engine::{Config, UserCommand};
use support::{DZI, DZI_INPUT_URL, ScriptedHost};

fn dzi_bytes() -> Vec<u8> {
    DZI.as_bytes().to_vec()
}

#[test]
fn over_limit_tiles_become_typed_terminal_failure() {
    let tight = Config {
        max_concurrent_fetches: 1,
        max_tiles: 1,
        ..Config::default()
    };
    let mut host = ScriptedHost::new("job:limited", DZI_INPUT_URL, tight).unwrap();
    host.start().unwrap();
    host.provide_metadata(0, &dzi_bytes(), None).unwrap();
    host.command(UserCommand::SelectImage { image: 0 }).unwrap();
    host.command(UserCommand::SelectLevel { level: 9 }).unwrap();
    // Planning the four-tile largest level against max_tiles=1 is a typed
    // resource-limit failure, never a panic or silent truncation. The
    // assertion reads the canonical engine snapshot, not a harness-derived
    // event transcript.
    assert_eq!(host.state(), "Failed");
    match &host.job().snapshot().terminal {
        Some(dezoomify::model::Terminal::Failed { error }) => {
            assert_eq!(error.code, "job.resource-limit");
        }
        other => panic!("expected failed terminal, got {other:?}"),
    }
    // Post-terminal inputs stay stably rejected.
    let err = host.command(UserCommand::Cancel).unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
}
