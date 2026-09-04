//! Normalized human/machine reporting: stdout = JSON events with --json,
//! stderr = human progress. Never mixed.

#[must_use]
pub fn machine_event(kind: &str, job: &str, seq: u64) -> String {
    serde_json::json!({"job": job, "seq": seq, "kind": kind}).to_string()
}

#[must_use]
pub fn human_progress(acquired: u64, total: u64) -> String {
    format!("progress {acquired}/{total}")
}
