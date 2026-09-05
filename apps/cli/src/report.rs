//! Normalized human/machine reporting: stdout = JSON events with --json,
//! stderr = human progress. Never mixed.

use std::collections::BTreeMap;

#[must_use]
pub fn machine_event_detail(
    job: &str,
    seq: u64,
    kind: &str,
    detail: &BTreeMap<String, String>,
) -> String {
    serde_json::json!({"job": job, "seq": seq, "kind": kind, "detail": detail}).to_string()
}

#[must_use]
pub fn machine_completed(job: &str, seq: u64, output_hash: &str) -> String {
    serde_json::json!({
        "job": job,
        "seq": seq,
        "kind": "completed",
        "outputHash": output_hash,
    })
    .to_string()
}
