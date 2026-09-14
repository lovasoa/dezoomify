//! Human and machine event rendering for the command-line tool.

use std::collections::{BTreeMap, BTreeSet};

use dezoomify_native::JobEvent;

use crate::report;

pub(crate) struct Reporter {
    json: bool,
    logging: String,
    tty: bool,
    progress_visible: bool,
    reported_failures: BTreeSet<String>,
}

impl Reporter {
    pub(crate) fn new(json: bool, logging: &str) -> Self {
        use std::io::IsTerminal as _;
        Self {
            json,
            logging: logging.to_string(),
            tty: std::io::stderr().is_terminal(),
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
        match event.kind.as_str() {
            "started" => self.line("Starting image download..."),
            "discovery" => self.line("Finding image information..."),
            "downloading" => self.progress(&event.detail),
            "encoding" => self.line("Building the image..."),
            "tile-failed" => {
                self.finish_progress();
                let tile = event
                    .detail
                    .get("tile")
                    .map(String::as_str)
                    .unwrap_or("unknown");
                let error = event
                    .detail
                    .get("error")
                    .map(String::as_str)
                    .unwrap_or("unknown error");
                if self.reported_failures.insert(tile.to_string()) {
                    eprintln!("Could not retrieve tile {tile}: {error}");
                }
            }
            "resource-failed" => {
                self.finish_progress();
                let error = event
                    .detail
                    .get("error")
                    .map(String::as_str)
                    .unwrap_or("unknown error");
                eprintln!("Could not retrieve image information: {error}");
            }
            "recovery-requested" => {
                self.line("Some tiles could not be retrieved. Preparing a partial image...");
            }
            "missing-work" => {
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
                eprintln!("trace {} {} {payload}", event.kind, event.job);
            }
        }
    }

    pub(crate) fn finish_progress(&mut self) {
        if self.progress_visible {
            eprintln!();
            self.progress_visible = false;
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
            eprint!("\rDownloading [{bar}] {percent:>3}% ({acquired}/{total} tiles)");
            use std::io::Write as _;
            let _ = std::io::stderr().flush();
            self.progress_visible = true;
        } else if acquired == 0 || acquired == total {
            self.line(&format!("Downloading: {acquired}/{total} tiles"));
        }
    }

    fn line(&mut self, message: &str) {
        self.finish_progress();
        eprintln!("{message}");
    }
}
