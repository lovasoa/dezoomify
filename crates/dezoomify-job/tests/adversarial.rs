mod support;

use dezoomify_job::{Config, JobResponse};
use support::ScriptedHost;

const INPUT_URL: &str = "https://example.test/image";

fn host_with_id(job: &str) -> ScriptedHost {
    ScriptedHost::new(job, INPUT_URL, Config::default()).unwrap()
}

#[test]
fn duplicate_response_is_ignored() {
    let mut host = host_with_id("job:dup");
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: "job:dup".to_string(),
        request: "req:0".to_string(),
        bytes_len: 1024,
    })
    .unwrap();
    let len = host.transcript().len();
    // Replaying the consumed discovery request is a safe no-op.
    let outcome = host
        .apply(JobResponse::ResourceBytes {
            job: "job:dup".to_string(),
            request: "req:0".to_string(),
            bytes_len: 1024,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");

    // Duplicate tile completion never double-completes work.
    host.apply(JobResponse::SelectedImage {
        job: "job:dup".to_string(),
        image: "img:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: "job:dup".to_string(),
        level: "lvl:0".to_string(),
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
            bytes_len: 1024,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-job");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "Discovering");
    // The rightful job still proceeds normally afterwards.
    host.apply(JobResponse::ResourceBytes {
        job: "job:mine".to_string(),
        request: "req:0".to_string(),
        bytes_len: 1024,
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
    let mut host = ScriptedHost::new("job:limited", INPUT_URL, tight).unwrap();
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: "job:limited".to_string(),
        request: "req:0".to_string(),
        bytes_len: 1024,
    })
    .unwrap();
    host.apply(JobResponse::SelectedImage {
        job: "job:limited".to_string(),
        image: "img:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: "job:limited".to_string(),
        level: "lvl:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: "job:limited".to_string(),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    // Planning two tiles against max_tiles=1 is a typed resource-limit
    // failure, never a panic or silent truncation.
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
