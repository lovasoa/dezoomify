//! Normalized human/machine reporting: stdout = JSON events with --json,
//! stderr = human progress. Never mixed.

use dezoomify::model::{DiagnosticLevel, Progress, ProgressPhase};
use dezoomify_native::diagnostics::Diagnostics;
use indicatif::{ProgressBar, ProgressStyle};
use std::cell::Cell;
use std::collections::BTreeMap;

/// One job's terminal display. Drop clears it after native settlement, including
/// failure paths; publication and the final result remain the caller's concern.
pub struct InteractiveProgress {
    bar: ProgressBar,
    phase: Cell<Option<(ProgressPhase, bool)>>,
}

impl InteractiveProgress {
    pub fn new(enabled: bool) -> Self {
        let bar = if enabled {
            ProgressBar::new_spinner().with_message("Discovering images…")
        } else {
            ProgressBar::hidden()
        };
        if enabled {
            bar.enable_steady_tick(std::time::Duration::from_millis(100));
        }
        Self {
            bar,
            phase: Cell::new(None),
        }
    }

    pub fn update(&self, progress: &Progress) {
        let counted = progress.phase == ProgressPhase::Acquisition
            && progress.total.is_some_and(|total| total > 0);
        if self.phase.replace(Some((progress.phase, counted))) != Some((progress.phase, counted)) {
            let style = if counted {
                ProgressStyle::default_bar()
            } else {
                ProgressStyle::default_spinner()
            };
            // These templates are authored here, not user input.
            let template = if counted {
                "{spinner} [{elapsed_precise}] [{wide_bar}] {pos}/{len} tiles ({eta} remaining)"
            } else {
                "{spinner} {msg} [{elapsed_precise}]"
            };
            self.bar.set_style(
                style
                    .template(template)
                    .unwrap_or_else(|_| ProgressStyle::default_spinner()),
            );
            self.bar.reset_elapsed();
        }
        if counted {
            self.bar.set_length(progress.total.unwrap_or(0));
            self.bar.set_position(progress.completed);
        } else {
            self.bar.unset_length();
            self.bar.set_message(match progress.phase {
                ProgressPhase::Discovery => "Discovering images…",
                ProgressPhase::Planning => "Planning download…",
                ProgressPhase::Acquisition => "Downloading tiles…",
                ProgressPhase::Output => "Saving image…",
            });
        }
    }

    /// Clear the bar while reading a selection, before acquisitions start.
    pub fn without_display<T>(&self, action: impl FnOnce() -> T) -> T {
        self.bar.suspend(action)
    }
}

impl Drop for InteractiveProgress {
    fn drop(&mut self) {
        self.bar.finish_and_clear();
    }
}

pub fn human_progress(progress: &Progress) -> String {
    match progress.phase {
        ProgressPhase::Discovery => "Discovering images…".to_string(),
        ProgressPhase::Planning => "Planning download…".to_string(),
        ProgressPhase::Acquisition => match progress.total {
            Some(total) => format!("Downloading tiles: {}/{total}", progress.completed),
            None => format!("Downloading tiles: {} completed", progress.completed),
        },
        ProgressPhase::Output => "Saving image…".to_string(),
    }
}

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

#[must_use]
pub fn machine_event_detail(
    job: &str,
    seq: u64,
    kind: &str,
    detail: &BTreeMap<String, String>,
) -> String {
    serde_json::json!({"job": job, "seq": seq, "kind": kind, "detail": detail}).to_string()
}

/// Fields for the terminal machine-readable completion record.
pub struct CompletedOutput<'a> {
    pub job: &'a str,
    pub seq: u64,
    pub format: &'a str,
    pub width: u32,
    pub height: u32,
    pub tile_count: usize,
}

#[must_use]
pub fn machine_completed(summary: &CompletedOutput<'_>) -> String {
    serde_json::json!({
        "job": summary.job,
        "seq": summary.seq,
        "kind": "completed",
        "format": summary.format,
        "width": summary.width,
        "height": summary.height,
        "tileCount": summary.tile_count,
    })
    .to_string()
}

/// The terminal machine-readable failure record for a single job: `failed`,
/// or `cancelled`, carrying the serialized typed error (its `kind` names the
/// failure).
#[must_use]
pub fn machine_failed(job: &str, error: &dezoomify::model::Error) -> String {
    use dezoomify::model::Error;
    serde_json::json!({
        "job": job,
        "kind": if matches!(error.cause(), Error::Cancelled) { "cancelled" } else { "failed" },
        "error": serde_json::to_value(error).unwrap_or(serde_json::Value::Null),
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
        "debug" => 3,
        "trace" => 4,
        _ => 2,
    }
}

pub fn job_diagnostics(level: &str, progress: &InteractiveProgress) -> Diagnostics {
    let diagnostics = Diagnostics::new("cli", crate::arguments::APP_VERSION);
    let threshold = log_level_rank(level);
    let bar = progress.bar.clone();
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
                    | "cancelled"
                    | "failed"
                    | "runtime-failed"
                    | "validation-failed"
            )
        {
            return;
        }
        bar.suspend(|| {
            eprintln!(
                "+{:.3}s {} {}",
                record.elapsed_ms / 1000.0,
                record.event,
                serde_json::to_string(&record.fields).unwrap_or_default()
            );
        });
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

/// Human progress shows at info and above; error/warn suppress it.
/// Machine `--json` events are never filtered.
#[must_use]
pub fn show_progress(level: &str) -> bool {
    log_level_rank(level) >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_counts_become_a_saving_spinner_and_clear_on_drop() {
        let bar = {
            let display = InteractiveProgress::new(false);
            let mut progress = Progress {
                phase: ProgressPhase::Acquisition,
                completed: 3,
                total: Some(10),
                ..Default::default()
            };
            display.update(&progress);
            assert_eq!(display.bar.position(), 3);
            assert_eq!(display.bar.length(), Some(10));
            progress.phase = ProgressPhase::Output;
            display.update(&progress);
            assert_eq!(display.bar.length(), None);
            assert_eq!(display.bar.message(), "Saving image…");
            assert!(!display.bar.is_finished());
            display.bar.clone()
        };
        assert!(bar.is_finished());
    }

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
    fn terminal_failure_record_carries_the_typed_error() {
        use dezoomify::model::Error;
        let failed: serde_json::Value = serde_json::from_str(&machine_failed(
            "job:cli-1",
            &Error::SizeLimit { max_bytes: 8 },
        ))
        .expect("json");
        assert_eq!(failed["job"], "job:cli-1");
        assert_eq!(failed["kind"], "failed");
        assert_eq!(failed["error"]["kind"], "size-limit");
        assert_eq!(failed["error"]["max_bytes"], 8);
        let cancelled: serde_json::Value =
            serde_json::from_str(&machine_failed("job:cli-1", &Error::Cancelled)).expect("json");
        assert_eq!(cancelled["kind"], "cancelled");
        assert_eq!(cancelled["error"]["kind"], "cancelled");
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
