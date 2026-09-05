//! `NativeRuntime`: shared pools + per-job state. Events carry job ID,
//! monotonic sequence, protocol version, and redacted context.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::download::{Scheduler, SchedulerConfig};

/// Redacted job origin: scheme + host (+ port if non-default), never the
/// path, query, or fragment, which may carry credentials or tokens.
fn redact_origin(input_url: &str) -> String {
    match url::Url::parse(input_url) {
        Ok(mut parsed) => {
            parsed.set_path("");
            parsed.set_query(None);
            parsed.set_fragment(None);
            parsed.as_str().trim_end_matches('/').to_string()
        }
        Err(_) => "unknown-origin".to_string(),
    }
}

pub struct NativeRuntime {
    max_bytes: u64,
    next_job: AtomicU64,
}

#[derive(Clone, Debug)]
pub struct JobRequest {
    pub input_url: String,
    pub output_path: String,
    pub overwrite: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobEvent {
    pub job: String,
    pub seq: u64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub detail: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct JobResult {
    pub output_hash: String,
    pub events: usize,
}

pub struct JobHandle {
    pub id: String,
    /// Redacted input origin (scheme://host); the full URL is never stored.
    pub origin: String,
    scheduler: Scheduler,
    events: Vec<JobEvent>,
    seq: u64,
    cancelled: bool,
    done: bool,
}

impl NativeRuntime {
    #[must_use]
    pub fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            next_job: AtomicU64::new(1),
        }
    }

    pub fn start(&self, request: JobRequest) -> Result<JobHandle, String> {
        if request.input_url.len() > 2048 {
            return Err("input url too long".to_string());
        }
        let id = self.next_job.fetch_add(1, Ordering::SeqCst);
        Ok(JobHandle {
            id: format!("job:native-{id}"),
            origin: redact_origin(&request.input_url),
            scheduler: Scheduler::new(SchedulerConfig::default()),
            events: Vec::new(),
            seq: 0,
            cancelled: false,
            done: false,
        })
    }

    #[must_use]
    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }
}

impl JobHandle {
    pub fn queue_tiles(&mut self, tiles: Vec<String>) -> Result<(), String> {
        for tile in tiles {
            self.scheduler.push(tile)?;
        }
        Ok(())
    }

    pub fn emit(&mut self, kind: &str) {
        self.emit_detail(kind, BTreeMap::new());
    }

    pub fn emit_detail(&mut self, kind: &str, detail: BTreeMap<String, String>) {
        self.seq = self.seq.checked_add(1).expect("seq overflow");
        self.events.push(JobEvent {
            job: self.id.clone(),
            seq: self.seq,
            kind: kind.to_string(),
            detail,
        });
    }

    pub fn cancel(&mut self) {
        if !self.done {
            self.cancelled = true;
            self.emit("cancelled");
            self.done = true;
        }
    }

    #[must_use]
    pub fn seq(&self) -> u64 {
        self.seq
    }

    #[must_use]
    pub fn events(&self) -> &[JobEvent] {
        &self.events
    }

    /// Finish with a caller-supplied output digest: hosts must supply a
    /// digest of bytes they actually wrote, never a stub. The pipeline
    /// computes the real sha256 of the encoded output it wrote.
    pub fn finish(&mut self, output_hash: String) -> JobResult {
        if !self.done {
            self.emit("completed");
            self.done = true;
        }
        JobResult {
            output_hash,
            events: self.events.len(),
        }
    }

    pub fn event_context(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("job".to_string(), self.id.clone()),
            ("protocol".to_string(), "1.0".to_string()),
            ("input".to_string(), self.origin.clone()),
        ])
    }
}
