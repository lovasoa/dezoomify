//! Canary redaction: no secret in snapshots, terminals, or output paths.
//!
//! The job runs through the native job service against an unroutable local
//! port (fast connection-refused, no public network). Snapshots omit the
//! credential-bearing query; local diagnostics retain the reproduction input.

use dezoomify_native::{start_job, JobOptions, OutputTarget};
use std::time::Duration;

#[test]
fn canaries_never_appear_in_snapshots_or_terminals() {
    let work = std::env::temp_dir().join(format!("dz-redact-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("temp dir");
    let job = start_job(JobOptions {
        input_url: "http://127.0.0.1:9/item?token=CANARY-TOKEN".into(),
        output: OutputTarget::File(work.join("out.png")),
        ..Default::default()
    })
    .expect("runner starts");
    // The input URL flows through the driver without entering snapshots.
    let mut snapshots = Vec::new();
    loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        assert_eq!(snapshot.job, job.id, "snapshots stay job-scoped");
        let done = snapshot.snapshot.terminal.is_some() || snapshot.published.is_some();
        snapshots.push(snapshot);
        if done {
            break;
        }
    }
    assert!(!snapshots.is_empty(), "started plus terminal snapshots");
    let text = format!("{snapshots:?}");
    assert!(
        !text.contains("CANARY-TOKEN"),
        "canary leaked into snapshots: {text}"
    );
    let diagnostics = job.diagnostics.clone();
    match job.join() {
        Err(_) => {}
        Ok(summary) => {
            panic!("refused input must not publish: {summary:?}")
        }
    }
    let report = diagnostics.report();
    assert_eq!(report.outcome.unwrap().event, "failed");
    assert!(report.counters["request_failures"] > 0.0);
    assert_eq!(
        serde_json::to_value(&report.context).unwrap()["input"],
        "http://127.0.0.1:9/item?token=CANARY-TOKEN"
    );
    let _ = std::fs::remove_dir_all(&work);
}

#[test]
fn auth_debug_redacts_values() {
    use dezoomify_native::auth::{AuthorizationScope, EphemeralAuthorization};
    use std::collections::HashMap;
    let auth = EphemeralAuthorization::new(
        AuthorizationScope {
            scheme: "https".into(),
            host: "h".into(),
            port: None,
            path_prefix: "/".into(),
            job_id: None,
        },
        HashMap::from([("session".to_string(), "CANARY-VALUE".to_string())]),
    )
    .unwrap();
    assert!(!format!("{auth:?}").contains("CANARY-VALUE"));
}

#[test]
fn diagnostic_budget_protects_problem_samples_and_terminal() {
    use dezoomify::model::DiagnosticLevel as Level;
    use dezoomify_native::diagnostics::{Diagnostics, MAX_BYTES};
    use serde_json::json;
    let d = Diagnostics::new("test", "test");
    d.context(json!({"selection_policy": "automatic", "path": "/home/me/output.png"}));
    d.record(
        Level::Warn,
        "request",
        json!({"http":403,"preview":"challenge"}),
    );
    for i in 0..2000 {
        d.record(Level::Warn, "request", json!({"http":403,"tile":i}));
        d.record(Level::Debug, "sample", json!({"text":"界".repeat(2000)}));
    }
    d.finish("failed", json!({"code":"tile.download-failed"}));
    d.finish("retired", json!({}));
    let report = d.report();
    let context = serde_json::to_value(&report.context).unwrap();
    assert_eq!(context["selection_policy"], "automatic");
    assert_eq!(context["path"], "/home/me/output.png");
    assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_BYTES);
    assert!(report.records.len() <= 1000 && report.omitted_records > 0);
    assert_eq!(report.failures[0].count, 2001);
    assert_eq!(report.outcome.unwrap().event, "failed");
    assert!(serde_json::to_string(&report.failures[0].first)
        .unwrap()
        .contains("challenge"));
}
