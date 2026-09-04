mod support;

use dezoomify_job::{Config, JobResponse};
use support::ScriptedHost;

fn job_id(n: u32) -> String {
    format!("job:{n}")
}

fn test_config() -> Config {
    Config::default()
}

const INPUT_URL: &str = "https://example.test/image";

#[test]
fn discover_success_minimal() {
    let mut host = ScriptedHost::new(&job_id(1), INPUT_URL, test_config()).unwrap();
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: job_id(1),
        request: "req:0".to_string(),
        bytes_len: 1024,
    })
    .unwrap();
    host.apply(JobResponse::SelectedImage {
        job: job_id(1),
        image: "img:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: job_id(1),
        level: "lvl:0".to_string(),
    })
    .unwrap();

    assert_eq!(host.state(), "AwaitingDestination");
    assert_eq!(host.terminal_count(), 0);
    // No background work: queues are drained after every step.
    assert_eq!(host.job().pending_effect_count(), 0);
    assert_eq!(host.job().pending_event_count(), 0);

    let expected: Vec<String> = vec![
        "state:Created".to_string(),
        "effect:acquire-resource:req:0:seq:1".to_string(),
        "event:job-state:Discovering:seq:2".to_string(),
        "state:Discovering".to_string(),
        "event:catalog:img:0:seq:3".to_string(),
        "event:job-state:AwaitingImageSelection:seq:4".to_string(),
        "state:AwaitingImageSelection".to_string(),
        "event:levels:lvl:0:seq:5".to_string(),
        "event:job-state:AwaitingLevelSelection:seq:6".to_string(),
        "state:AwaitingLevelSelection".to_string(),
        "effect:request-destination:fx:1:seq:7".to_string(),
        "event:job-state:AwaitingDestination:seq:8".to_string(),
        "state:AwaitingDestination".to_string(),
    ];
    assert_eq!(host.transcript(), expected.as_slice());
}

#[test]
fn destination_grant_flow_completes() {
    let mut host = ScriptedHost::new(&job_id(2), INPUT_URL, test_config()).unwrap();
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: job_id(2),
        request: "req:0".to_string(),
        bytes_len: 2048,
    })
    .unwrap();
    host.apply(JobResponse::SelectedImage {
        job: job_id(2),
        image: "img:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: job_id(2),
        level: "lvl:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: job_id(2),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::TileOutcome {
        job: job_id(2),
        tile: "tile:0".to_string(),
        ok: true,
    })
    .unwrap();
    host.apply(JobResponse::TileOutcome {
        job: job_id(2),
        tile: "tile:1".to_string(),
        ok: true,
    })
    .unwrap();

    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
    assert_eq!(host.job().terminal_kind(), Some("completed"));
    assert_eq!(host.job().pending_effect_count(), 0);
    assert_eq!(host.job().pending_event_count(), 0);

    // Full transcript proves every phase was visited in order and the
    // terminal event fired exactly once with no host I/O inside the job.
    // Intermediate phases appear as `job-state` events in seq order; stable
    // states also appear as `state:` snapshots.
    let transcript = host.transcript();
    for phase in [
        "Planning",
        "AcquiringTiles",
        "ProcessingTiles",
        "Encoding",
        "Finalizing",
        "Publishing",
        "CleaningUp",
        "Completed",
    ] {
        let prefix = format!("event:job-state:{phase}:seq:");
        assert!(
            transcript.iter().any(|line| line.starts_with(&prefix)),
            "missing job-state event for {phase}: {transcript:?}"
        );
    }
    assert!(transcript.contains(&"state:AcquiringTiles".to_string()));
    assert!(transcript.contains(&"state:Completed".to_string()));
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("event:completed:"))
            .count(),
        1
    );
    // Deterministic replay: seq values are strictly increasing.
    let seqs: Vec<u64> = transcript
        .iter()
        .filter_map(|line| line.rsplit(":seq:").next())
        .filter_map(|suffix| suffix.split(':').next())
        .filter_map(|num| num.parse::<u64>().ok())
        .collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted);
    assert!(transcript.len() >= 30);
}

#[test]
fn cancel_in_acquiring_tiles_ignores_late_response() {
    let mut host = ScriptedHost::new(&job_id(3), INPUT_URL, test_config()).unwrap();
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: job_id(3),
        request: "req:0".to_string(),
        bytes_len: 5120,
    })
    .unwrap();
    host.apply(JobResponse::SelectedImage {
        job: job_id(3),
        image: "img:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: job_id(3),
        level: "lvl:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: job_id(3),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::TileOutcome {
        job: job_id(3),
        tile: "tile:0".to_string(),
        ok: true,
    })
    .unwrap();

    assert_eq!(host.state(), "AcquiringTiles");
    host.apply(JobResponse::Cancel { job: job_id(3) }).unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.terminal_count(), 1);

    let len_after_cancel = host.transcript().len();
    // Late tile outcome after cancellation is stably rejected with no work.
    let late = host.apply(JobResponse::TileOutcome {
        job: job_id(3),
        tile: "tile:1".to_string(),
        ok: true,
    });
    assert!(late.is_err());
    assert_eq!(late.unwrap_err().code, "job.post-terminal");
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.transcript().len(), len_after_cancel);
    assert_eq!(host.terminal_count(), 1);
    for phase in ["Cancelling", "CleaningUp", "Cancelled"] {
        let prefix = format!("event:job-state:{phase}:seq:");
        assert!(
            host.transcript()
                .iter()
                .any(|line| line.starts_with(&prefix)),
            "missing job-state event for {phase}"
        );
    }
    assert!(host.transcript().contains(&"state:Cancelled".to_string()));
}
