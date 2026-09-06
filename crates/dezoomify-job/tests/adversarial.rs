mod support;

use dezoomify_job::{Config, JobResponse};
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
    host.apply(JobResponse::ResourceBytes {
        job: "job:dup".to_string(),
        request: "req:0".to_string(),
        bytes: dzi_bytes(),
        final_uri: None,
    })
    .unwrap();
    let len = host.transcript().len();
    // Replaying the consumed discovery request is a safe no-op.
    let outcome = host
        .apply(JobResponse::ResourceBytes {
            job: "job:dup".to_string(),
            request: "req:0".to_string(),
            bytes: dzi_bytes(),
            final_uri: None,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");

    // Duplicate tile completion never double-completes work. The largest
    // level is a 2x2 grid, so one tile outcome leaves acquisition running.
    host.apply(JobResponse::SelectedImage {
        job: "job:dup".to_string(),
        image: "img:dzi:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: "job:dup".to_string(),
        level: "lvl:dzi:0:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: "job:dup".to_string(),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::TileOutcome {
        job: "job:dup".to_string(),
        tile: "tile:0".to_string(),
        ok: true,
    })
    .unwrap();
    let len = host.transcript().len();
    let outcome = host
        .apply(JobResponse::TileOutcome {
            job: "job:dup".to_string(),
            tile: "tile:0".to_string(),
            ok: true,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
}

#[test]
fn wrong_job_is_rejected_without_corruption() {
    let mut host = host_with_id("job:mine");
    host.start().unwrap();
    let len = host.transcript().len();
    let err = host
        .apply(JobResponse::ResourceBytes {
            job: "job:other".to_string(),
            request: "req:0".to_string(),
            bytes: dzi_bytes(),
            final_uri: None,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-job");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "Discovering");
    // The rightful job still proceeds normally afterwards.
    host.apply(JobResponse::ResourceBytes {
        job: "job:mine".to_string(),
        request: "req:0".to_string(),
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
    host.apply(JobResponse::ResourceBytes {
        job: "job:limited".to_string(),
        request: "req:0".to_string(),
        bytes: dzi_bytes(),
        final_uri: None,
    })
    .unwrap();
    host.apply(JobResponse::SelectedImage {
        job: "job:limited".to_string(),
        image: "img:dzi:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: "job:limited".to_string(),
        level: "lvl:dzi:0:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: "job:limited".to_string(),
        destination: "dst:0".to_string(),
    })
    .unwrap();
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
    let err = host
        .apply(JobResponse::Cancel {
            job: "job:limited".to_string(),
        })
        .unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn double_cancel_is_idempotent() {
    let mut host = host_with_id("job:cancel2");
    host.start().unwrap();
    host.apply(JobResponse::Cancel {
        job: "job:cancel2".to_string(),
    })
    .unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.terminal_count(), 1);
    let len = host.transcript().len();
    let err = host
        .apply(JobResponse::Cancel {
            job: "job:cancel2".to_string(),
        })
        .unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn empty_resource_bytes_fail_without_catalog() {
    let mut host = host_with_id("job:empty");
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: "job:empty".to_string(),
        request: "req:0".to_string(),
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
    let requests: Vec<String> = host
        .effects
        .iter()
        .filter(|effect| {
            effect.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource")
        })
        .filter_map(|effect| {
            effect
                .get("request")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(requests.len(), 2, "metadata plus input stay outstanding");
    let xml = r#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#;
    host.apply(JobResponse::ResourceBytes {
        job: "job:batch".to_string(),
        request: requests[0].clone(),
        bytes: xml.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    let len = host.transcript().len();
    let late = host
        .apply(JobResponse::ResourceBytes {
            job: "job:batch".to_string(),
            request: requests[1].clone(),
            bytes: vec![1, 2, 3],
            final_uri: None,
        })
        .unwrap();
    assert_eq!(late, dezoomify_job::Outcome::Ignored);
    let late_failure = host
        .apply(JobResponse::FetchFailure {
            job: "job:batch".to_string(),
            request: requests[1].clone(),
        })
        .unwrap();
    assert_eq!(late_failure, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");
}
