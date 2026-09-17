mod support;

use dezoomify_core::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify_job::{Config, JobCommand};
use support::{ScriptedHost, DZI, DZI_INPUT_URL};

fn host_with_id(job: &str) -> ScriptedHost {
    ScriptedHost::new(job, DZI_INPUT_URL, Config::default()).unwrap()
}

fn dzi_bytes() -> Vec<u8> {
    DZI.as_bytes().to_vec()
}

#[test]
fn duplicate_response_is_ignored() {
    let mut host = host_with_id("job:dup");
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: dzi_bytes(),
        final_uri: None,
    })
    .unwrap();
    let len = host.transcript().len();
    // Replaying the consumed discovery request is a safe no-op.
    let outcome = host
        .apply(JobCommand::ResourceBytes {
            request: 0,
            bytes: dzi_bytes(),
            final_uri: None,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");

    // Duplicate tile completion never double-completes work. The largest
    // level is a 2x2 grid, so one tile outcome leaves acquisition running.
    host.apply(JobCommand::SelectImage { image: 0 }).unwrap();
    host.apply(JobCommand::SelectLevel { level: 9 }).unwrap();
    host.apply(JobCommand::TileOutcome { tile: 0, ok: true })
        .unwrap();
    let len = host.transcript().len();
    let outcome = host
        .apply(JobCommand::TileOutcome { tile: 0, ok: true })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
}

#[test]
fn unknown_request_is_ignored_without_corruption() {
    let mut host = host_with_id("job:mine");
    host.start().unwrap();
    let len = host.transcript().len();
    let err = host
        .apply(JobCommand::ResourceBytes {
            request: 99,
            bytes: dzi_bytes(),
            final_uri: None,
        })
        .unwrap();
    assert_eq!(err, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "Discovering");
    // The outstanding request still proceeds normally afterwards.
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: dzi_bytes(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
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
    assert_eq!(host.terminal_count(), 1);
    let failed: Vec<&String> = host
        .transcript()
        .iter()
        .filter(|line| line.starts_with("event:failed:"))
        .collect();
    assert_eq!(failed.len(), 1);
    assert!(failed[0].contains("job.resource-limit"));
    // Post-terminal inputs stay stably rejected with no second terminal.
    let err = host.apply(JobCommand::Cancel).unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn double_cancel_is_idempotent() {
    let mut host = host_with_id("job:cancel2");
    host.start().unwrap();
    host.apply(JobCommand::Cancel).unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.terminal_count(), 1);
    let len = host.transcript().len();
    let err = host.apply(JobCommand::Cancel).unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn empty_resource_bytes_fail_without_catalog() {
    let mut host = host_with_id("job:empty");
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: Vec::new(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "Failed");
    assert_eq!(host.terminal_count(), 1);
    assert!(
        !host
            .transcript()
            .iter()
            .any(|line| line.starts_with("event:catalog:")),
        "empty bytes must not emit a catalog"
    );
}

#[test]
fn batch_sibling_answer_after_a_winner_is_ignored() {
    // A tile URL fans out to metadata plus the input itself; the first
    // answer may win discovery while the sibling fetch is still in flight.
    // The late sibling must be ignored so the winning catalog survives
    // (live NGV/ONB/Washington/TopViewer regression).
    let mut host = ScriptedHost::new(
        "job:batch",
        "https://example.test/TileGroup0/0-0-0.jpg",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    let requests: Vec<u32> = host
        .effects
        .iter()
        .filter(|effect| {
            effect.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource")
        })
        .filter_map(|effect| {
            effect
                .get("request")
                .and_then(serde_json::Value::as_u64)
                .and_then(|request| u32::try_from(request).ok())
        })
        .collect();
    assert_eq!(requests.len(), 2, "metadata plus input stay outstanding");
    let xml = r#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#;
    host.apply(JobCommand::ResourceBytes {
        request: requests[0],
        bytes: xml.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    let len = host.transcript().len();
    let late = host
        .apply(JobCommand::ResourceBytes {
            request: requests[1],
            bytes: vec![1, 2, 3],
            final_uri: None,
        })
        .unwrap();
    assert_eq!(late, dezoomify_job::Outcome::Ignored);
    let late_failure = host
        .apply(JobCommand::FetchFailure {
            request: requests[1],
            cause: FetchCause::new(FetchCode::DiscoveryFailed, TransportKind::Direct),
        })
        .unwrap();
    assert_eq!(late_failure, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");
}
