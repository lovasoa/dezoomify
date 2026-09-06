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
pub fn machine_completed(
    job: &str,
    seq: u64,
    output_hash: &str,
    format: &str,
    width: u32,
    height: u32,
    tile_count: usize,
) -> String {
    serde_json::json!({
        "job": job,
        "seq": seq,
        "kind": "completed",
        "outputHash": output_hash,
        "format": format,
        "width": width,
        "height": height,
        "tileCount": tile_count,
    })
    .to_string()
}

/// One bulk entry outcome for summaries: `ok` with an output hash, or
/// `failed` with a stable error code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkItem {
    pub index: usize,
    pub url: String,
    pub output: String,
    pub status: String,
    pub detail: String,
}

impl BulkItem {
    #[must_use]
    pub fn ok(index: usize, url: &str, output: &str, output_hash: &str) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "ok".to_string(),
            detail: output_hash.to_string(),
        }
    }

    #[must_use]
    pub fn failed(index: usize, url: &str, output: &str, code: &str, message: &str) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "failed".to_string(),
            detail: format!("{code}: {message}"),
        }
    }
}

#[must_use]
pub fn human_bulk_summary(total: usize, succeeded: usize, failed: usize) -> String {
    format!("bulk: {succeeded} succeeded, {failed} failed, {total} total")
}

#[must_use]
pub fn machine_bulk_summary(total: usize, succeeded: usize, failed: usize) -> String {
    serde_json::json!({
        "kind": "bulk-completed",
        "total": total,
        "succeeded": succeeded,
        "failed": failed,
    })
    .to_string()
}

#[must_use]
pub fn machine_bulk_item(item: &BulkItem) -> String {
    serde_json::json!({
        "kind": "bulk-item",
        "index": item.index,
        "url": item.url,
        "output": item.output,
        "status": item.status,
        "detail": item.detail,
    })
    .to_string()
}

/// Log verbosity rank for `--logging`: error=0, warn=1, info=2, debug=3,
/// trace=4. Unknown defaults to info (defensive; the parser validates).
/// Controls human stderr only; `--json` stdout is never filtered.
#[must_use]
pub fn log_level_rank(level: &str) -> u8 {
    match level.trim().to_ascii_lowercase().as_str() {
        "error" => 0,
        "warn" => 1,
        "info" => 2,
        "debug" => 3,
        "trace" => 4,
        _ => 2,
    }
}

/// Warnings (`warning: ...`, EOF notices) show at warn and above.
#[must_use]
pub fn show_warning(level: &str) -> bool {
    log_level_rank(level) >= 1
}

/// Success lines (`saved ...`, human bulk summaries) show at info and above;
/// error/warn stay quiet on success. Failures and `error:` lines always show.
#[must_use]
pub fn show_success(level: &str) -> bool {
    log_level_rank(level) >= 2
}

/// Progress events (`started`, `discovery`, `downloading`, `encoding`) show at
/// info and above; error/warn suppress them. Machine `--json` events are
/// never filtered.
#[must_use]
pub fn show_progress(level: &str) -> bool {
    log_level_rank(level) >= 2
}

/// Extra per-run diagnostics show at debug and above.
#[must_use]
pub fn is_verbose(level: &str) -> bool {
    log_level_rank(level) >= 3
}

/// Full event payloads show at trace only.
#[must_use]
pub fn is_trace(level: &str) -> bool {
    log_level_rank(level) >= 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_levels_gate_human_output() {
        assert_eq!(log_level_rank("error"), 0);
        assert_eq!(log_level_rank("warn"), 1);
        assert_eq!(log_level_rank("info"), 2);
        assert_eq!(log_level_rank("debug"), 3);
        assert_eq!(log_level_rank("trace"), 4);
        assert_eq!(log_level_rank("nope"), 2);
        assert!(!show_warning("error"));
        assert!(show_warning("warn"));
        assert!(!show_success("error"));
        assert!(!show_success("warn"));
        assert!(show_success("info"));
        assert!(!show_progress("warn"));
        assert!(show_progress("info"));
        assert!(show_progress("debug"));
        assert!(!is_verbose("info"));
        assert!(is_verbose("debug"));
        assert!(is_verbose("trace"));
        assert!(!is_trace("debug"));
        assert!(is_trace("trace"));
    }

    #[test]
    fn bulk_summary_shapes() {
        assert_eq!(
            human_bulk_summary(3, 2, 1),
            "bulk: 2 succeeded, 1 failed, 3 total"
        );
        let machine: serde_json::Value =
            serde_json::from_str(&machine_bulk_summary(3, 2, 1)).expect("json");
        assert_eq!(machine["kind"], "bulk-completed");
        assert_eq!(machine["total"], 3);
        assert_eq!(machine["succeeded"], 2);
        assert_eq!(machine["failed"], 1);
        let item = BulkItem::ok(0, "https://example.test/a.dzi", "a_1.png", "sha256:abc");
        let line: serde_json::Value =
            serde_json::from_str(&machine_bulk_item(&item)).expect("json");
        assert_eq!(line["kind"], "bulk-item");
        assert_eq!(line["status"], "ok");
    }
}
