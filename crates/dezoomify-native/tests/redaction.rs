//! Canary redaction: no secret in snapshots, terminals, or output paths.
//!
//! The job runs through the real typed runner against an unroutable local
//! port (fast connection-refused, no public network): every observable
//! surface must carry only redacted transport diagnostics, never the
//! credential-bearing query.

use dezoomify_native::{JobOptions, NativeRunner, OutputTarget};
use std::time::Duration;

#[test]
fn canaries_never_appear_in_snapshots_or_terminals() {
    let work = std::env::temp_dir().join(format!("dz-redact-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("temp dir");
    let job = NativeRunner::start(JobOptions {
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
    match job.join() {
        Err(_) => {}
        Ok(summary) => {
            panic!("refused input must not publish: {summary:?}")
        }
    }
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
