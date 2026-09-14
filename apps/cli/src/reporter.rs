//! Human and machine event rendering for the command-line tool.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

use dezoomify_native::{JobEvent, JobEventKind};

use crate::report;

pub(crate) struct Reporter<W = std::io::Stderr> {
    json: bool,
    logging: String,
    tty: bool,
    output: W,
    progress_visible: bool,
    reported_failures: BTreeSet<String>,
}

impl Reporter<std::io::Stderr> {
    pub(crate) fn new(json: bool, logging: &str) -> Self {
        use std::io::IsTerminal as _;
        Self::with_output(
            json,
            logging,
            std::io::stderr().is_terminal(),
            std::io::stderr(),
        )
    }
}

impl<W: Write> Reporter<W> {
    fn with_output(json: bool, logging: &str, tty: bool, output: W) -> Self {
        Self {
            json,
            logging: logging.to_string(),
            tty,
            output,
            progress_visible: false,
            reported_failures: BTreeSet::new(),
        }
    }

    pub(crate) fn event(&mut self, event: &JobEvent) {
        if self.json {
            println!(
                "{}",
                report::machine_event_detail(
                    &event.job,
                    event.seq,
                    event.kind.as_str(),
                    &event.detail
                )
            );
            return;
        }
        if !report::show_progress(&self.logging) {
            return;
        }
        match &event.kind {
            JobEventKind::Started => self.line("Starting image download..."),
            JobEventKind::Discovery => self.line("Finding the zoomable image…"),
            JobEventKind::Downloading => self.progress(&event.detail),
            JobEventKind::Encoding => self.line("Assembling the final picture…"),
            JobEventKind::TileFailed => self.tile_failure(&event.detail),
            JobEventKind::ResourceFailed => {
                let error = event
                    .detail
                    .get("error")
                    .map(String::as_str)
                    .unwrap_or("unknown error");
                self.line(&format!("Could not retrieve image information: {error}"));
            }
            JobEventKind::RecoveryRequested => {
                self.line("Some tiles could not be retrieved. Preparing a partial image...");
            }
            JobEventKind::MissingWork => {
                let failed = event
                    .detail
                    .get("failed")
                    .map(String::as_str)
                    .unwrap_or("some");
                self.line(&format!("{failed} tiles could not be retrieved."));
            }
            _ => {}
        }
        if report::is_trace(&self.logging) {
            if let Ok(payload) = serde_json::to_string(&event.detail) {
                self.finish_progress();
                let _ = writeln!(self.output, "trace {} {} {payload}", event.kind, event.job);
            }
        }
    }

    pub(crate) fn finish_progress(&mut self) {
        if self.progress_visible {
            let _ = writeln!(self.output);
            self.progress_visible = false;
        }
    }

    fn tile_failure(&mut self, detail: &BTreeMap<String, String>) {
        let tile = detail.get("tile").map(String::as_str).unwrap_or("unknown");
        let error = detail
            .get("error")
            .map(String::as_str)
            .unwrap_or("unknown error");
        if self.reported_failures.insert(tile.to_string()) {
            self.line(&format!("Could not retrieve tile {tile}: {error}"));
        }
    }

    fn progress(&mut self, detail: &BTreeMap<String, String>) {
        let acquired = detail
            .get("acquired")
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        let total = detail
            .get("total")
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        if self.tty {
            let filled = acquired.saturating_mul(30).checked_div(total).unwrap_or(0);
            let bar = format!(
                "{}{}",
                "#".repeat(filled.min(30)),
                "-".repeat(30usize.saturating_sub(filled))
            );
            let percent = acquired.saturating_mul(100).checked_div(total).unwrap_or(0);
            let _ = write!(
                self.output,
                "\rSaving image tiles [{bar}] {percent:>3}% ({acquired}/{total} tiles)"
            );
            let _ = self.output.flush();
            self.progress_visible = true;
        } else if acquired == 0 || acquired == total {
            self.line(&format!("Saving image tiles: {acquired}/{total}"));
        }
    }

    fn line(&mut self, message: &str) {
        self.finish_progress();
        let _ = writeln!(self.output, "{message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: JobEventKind, detail: BTreeMap<String, String>) -> JobEvent {
        JobEvent {
            job: "job:test".to_string(),
            seq: 1,
            kind,
            detail,
        }
    }

    #[test]
    fn typed_events_render_a_tty_progress_bar() {
        let mut reporter = Reporter::with_output(false, "info", true, Vec::new());
        reporter.event(&event(JobEventKind::Started, BTreeMap::new()));
        reporter.event(&event(
            JobEventKind::Downloading,
            BTreeMap::from([
                ("acquired".to_string(), "2".to_string()),
                ("total".to_string(), "4".to_string()),
            ]),
        ));
        reporter.event(&event(JobEventKind::Encoding, BTreeMap::new()));

        let rendered = String::from_utf8(reporter.output).expect("utf8 terminal output");
        assert!(rendered.contains("Starting image download..."));
        assert!(rendered
            .contains("\rSaving image tiles [###############---------------]  50% (2/4 tiles)\n"));
        assert!(rendered.contains("Assembling the final picture…"));
    }

    #[test]
    fn tile_failure_is_rendered_once_per_tile() {
        let mut reporter = Reporter::with_output(false, "info", false, Vec::new());
        let detail = BTreeMap::from([
            ("tile".to_string(), "tile:1".to_string()),
            ("error".to_string(), "request returned HTTP 404".to_string()),
        ]);
        reporter.event(&event(JobEventKind::TileFailed, detail.clone()));
        reporter.event(&event(JobEventKind::TileFailed, detail));

        let rendered = String::from_utf8(reporter.output).expect("utf8 terminal output");
        assert_eq!(rendered.matches("Could not retrieve tile").count(), 1);
    }
}
