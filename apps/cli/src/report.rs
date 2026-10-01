//! Normalized human/machine reporting: stdout = JSON events with --json,
//! stderr = human progress. Never mixed.

use dezoomify::model::DiagnosticLevel;
use dezoomify_native::diagnostics::Diagnostics;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct ProgressGate {
    phase: String,
    at: std::time::Duration,
}

impl ProgressGate {
    pub fn allow(&mut self, phase: &str, now: std::time::Duration) -> bool {
        if self.phase != phase || now.saturating_sub(self.at) >= std::time::Duration::from_secs(1) {
            self.phase = phase.to_owned();
            self.at = now;
            true
        } else {
            false
        }
    }
}

/// One CLI machine event: the fields shared by every machine record.
pub struct Event<'a> {
    pub job: &'a str,
    pub seq: u64,
    pub kind: &'a str,
    pub detail: &'a BTreeMap<String, String>,
}

impl Event<'_> {
    /// The event as one line-delimited JSON record.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::json!({"job": self.job, "seq": self.seq, "kind": self.kind, "detail": self.detail})
            .to_string()
    }
}

/// Fields for the terminal machine-readable completion record.
/// `partial` distinguishes a kept
/// `.partial` sibling (`partial-completed`) from a complete save.
pub struct CompletedOutput<'a> {
    pub job: &'a str,
    pub seq: u64,
    pub format: &'a str,
    pub width: u32,
    pub height: u32,
    pub tile_count: usize,
    pub partial: bool,
}

#[must_use]
pub fn machine_completed(summary: &CompletedOutput<'_>) -> String {
    serde_json::json!({
        "job": summary.job,
        "seq": summary.seq,
        "kind": if summary.partial { "partial-completed" } else { "completed" },
        "format": summary.format,
        "width": summary.width,
        "height": summary.height,
        "tileCount": summary.tile_count,
        "partial": summary.partial,
    })
    .to_string()
}

/// One bulk entry outcome for summaries: `ok`, or `failed` carrying the
/// serialized typed error (its `kind` names the failure).
#[derive(Clone, Debug)]
pub struct BulkItem {
    pub index: usize,
    pub url: String,
    pub output: String,
    pub status: String,
    pub detail: String,
    pub error: Option<serde_json::Value>,
}

impl BulkItem {
    #[must_use]
    pub fn ok(index: usize, url: &str, output: &str) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "ok".to_string(),
            detail: String::new(),
            error: None,
        }
    }

    #[must_use]
    pub fn failed(index: usize, url: &str, output: &str, error: &dezoomify::model::Error) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "failed".to_string(),
            detail: format!("{}: {}", error.cause().kind(), error),
            error: Some(serde_json::to_value(error).unwrap_or(serde_json::Value::Null)),
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
    let mut event = serde_json::json!({
        "kind": "bulk-item",
        "index": item.index,
        "url": item.url,
        "output": item.output,
        "status": item.status,
        "detail": item.detail,
    });
    if let Some(error) = &item.error {
        event["error"] = error.clone();
    }
    event.to_string()
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

pub fn job_diagnostics(level: &str) -> Diagnostics {
    let diagnostics = Diagnostics::new("cli", crate::arguments::APP_VERSION);
    let threshold = log_level_rank(level);
    diagnostics.set_sink(move |record| {
        let rank = match record.level {
            DiagnosticLevel::Error => 0,
            DiagnosticLevel::Warn => 1,
            DiagnosticLevel::Info => 2,
            DiagnosticLevel::Debug => 3,
            DiagnosticLevel::Trace => 4,
        };
        // Human progress and final output report these milestones.
        if rank > threshold
            || matches!(
                record.event.as_str(),
                "start"
                    | "phase"
                    | "completed"
                    | "partial-completed"
                    | "failed"
                    | "runtime-failed"
                    | "validation-failed"
            )
        {
            return;
        }
        eprintln!(
            "+{:.3}s {} {}",
            record.elapsed_ms / 1000.0,
            record.event,
            serde_json::to_string(&record.fields).unwrap_or_default()
        );
    });
    diagnostics
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
        let item = BulkItem::ok(0, "https://example.test/a.dzi", "a_1.png");
        let line: serde_json::Value =
            serde_json::from_str(&machine_bulk_item(&item)).expect("json");
        assert_eq!(line["kind"], "bulk-item");
        assert_eq!(line["status"], "ok");
    }
}
