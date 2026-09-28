//! Canary redaction: no secret in snapshots, terminals, or output paths.
//!
//! The job runs through the real typed runner against an unroutable local
//! port (fast connection-refused, no public network): every observable
//! surface must carry only redacted transport diagnostics, never the
//! credential-bearing query.

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
    // The input URL (with its secret query) flows through the driver; every
    // observable surface must never carry it back.
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
    assert!(!serde_json::to_string(&diagnostics.report())
        .unwrap()
        .contains("CANARY-TOKEN"));
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
    use dezoomify_native::diagnostics::{redact, Diagnostics, MAX_BYTES};
    use serde_json::json;
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../testdata/redaction-vectors.json")).unwrap();
    for key in vectors["sensitive_query_keys"].as_array().unwrap() {
        assert!(
            !redact(&format!(
                "https://h/?{}=CANARY&page=2",
                key.as_str().unwrap()
            ))
            .contains("CANARY"),
            "{key}"
        );
    }
    for vector in vectors["redaction_cases"].as_array().unwrap() {
        for secret in vector["must_not_contain"].as_array().unwrap() {
            assert!(!redact(vector["input"].as_str().unwrap()).contains(secret.as_str().unwrap()));
        }
    }
    assert_eq!(
        redact("https://h/a%2Fb?token=CANARY&page=2&sig=CANARY&lang=fr"),
        "https://h/a%2Fb?token=[redacted]&page=2&sig=[redacted]&lang=fr"
    );
    let d = Diagnostics::new("test", "test");
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
    assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_BYTES);
    assert!(report.records.len() <= 1000 && report.omitted_records > 0);
    assert_eq!(report.failures[0].count, 2001);
    assert_eq!(report.outcome.unwrap().event, "failed");
    assert!(serde_json::to_string(&report.failures[0].first)
        .unwrap()
        .contains("challenge"));
}
