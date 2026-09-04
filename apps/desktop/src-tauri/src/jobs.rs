// In-memory desktop job table (lean shell, standard library only).
//
// Shapes mirror the dezoomify-job transcript event kinds (job-state,
// progress, completed, cancelled, failed) without depending on the real
// runtime, so this standalone manifest stays offline. The native runtime owns
// execution; this table only tracks lifecycle, scoped seq ordering, and
// terminal-once guarantees for the creating window/session.

use std::collections::HashMap;

/// Lifecycle states tracked by the shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Created,
    Discovering,
    AwaitingChoice,
    AwaitingDestination,
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl JobState {
    pub fn name(&self) -> &'static str {
        match self {
            JobState::Created => "created",
            JobState::Discovering => "discovering",
            JobState::AwaitingChoice => "awaiting-choice",
            JobState::AwaitingDestination => "awaiting-destination",
            JobState::Running => "running",
            JobState::Completed => "completed",
            JobState::Cancelled => "cancelled",
            JobState::Failed => "failed",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, JobState::Completed | JobState::Cancelled | JobState::Failed)
    }
}

/// One ordered transcript event for a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobEvent {
    pub seq: u64,
    pub kind: String,
    pub detail: String,
}

/// One tracked job.
#[derive(Debug, Clone)]
pub struct JobRecord {
    pub id: String,
    pub state: JobState,
    pub seq: u64,
    pub events: Vec<JobEvent>,
    pub window: String,
}

/// In-memory table keyed by job id.
#[derive(Debug, Default)]
pub struct JobTable {
    jobs: HashMap<String, JobRecord>,
    next_job: u64,
    capability_seq: u64,
}

impl JobTable {
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
            next_job: 0,
            capability_seq: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Monotonic seq for capability queries (no job scope).
    pub fn capability_seq(&mut self) -> u64 {
        self.capability_seq = self.capability_seq.saturating_add(1);
        self.capability_seq
    }

    pub fn last_seq(&self, job: &str) -> Option<u64> {
        self.jobs.get(job).map(|r| r.seq)
    }

    pub fn events_for(&self, job: &str) -> Vec<JobEvent> {
        self.jobs.get(job).map(|r| r.events.clone()).unwrap_or_default()
    }

    fn push_event(&mut self, job: &str, kind: &str, detail: &str) -> u64 {
        let seq = self.jobs.get(job).map(|r| r.seq.saturating_add(1)).unwrap_or(1);
        if let Some(record) = self.jobs.get_mut(job) {
            record.seq = seq;
            record.events.push(JobEvent {
                seq,
                kind: kind.to_string(),
                detail: detail.to_string(),
            });
        }
        seq
    }

    /// Start one job and return its id immediately.
    pub fn start_job(&mut self, input_url: &str) -> Result<String, String> {
        if input_url.is_empty() || input_url.len() > 2048 {
            return Err("input_url must be 1..2048 bytes".to_string());
        }
        if !(input_url.starts_with("http://") || input_url.starts_with("https://")) {
            return Err("input_url must be http(s)".to_string());
        }
        let n = self.next_job;
        self.next_job = self.next_job.saturating_add(1);
        let id = format!("job:{n}");
        self.jobs.insert(
            id.clone(),
            JobRecord {
                id: id.clone(),
                state: JobState::Discovering,
                seq: 1,
                events: vec![JobEvent {
                    seq: 1,
                    kind: "job-state".to_string(),
                    detail: "discovering".to_string(),
                }],
                window: "main".to_string(),
            },
        );
        Ok(id)
    }

    fn require_live(&self, job: &str) -> Result<JobState, String> {
        match self.jobs.get(job) {
            None => Err("unknown".to_string()),
            Some(record) if record.state.is_terminal() => Err("stale".to_string()),
            Some(record) => Ok(record.state.clone()),
        }
    }

    /// Cancel a live job. Terminal jobs report stale; missing jobs report unknown.
    pub fn cancel_job(&mut self, job: &str) -> Result<u64, String> {
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::Cancelled;
        }
        Ok(self.push_event(job, "cancelled", "cancelled by user"))
    }

    /// Answer an image/level choice for a live job.
    pub fn answer_choice(&mut self, job: &str, choice: &str) -> Result<(u64, String), String> {
        self.require_live(job)?;
        if choice.is_empty() || choice.len() > 128 {
            return Err("choice must be 1..128 bytes".to_string());
        }
        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::Running;
        }
        let seq = self.push_event(job, "job-state", "running");
        Ok((seq, "job-state:running".to_string()))
    }

    /// Record a save destination grant for a live job.
    pub fn request_destination(&mut self, job: &str, format: &str) -> Result<(u64, String), String> {
        self.require_live(job)?;
        if !["png", "jpeg", "tiff"].contains(&format) {
            return Err("unsupported format".to_string());
        }
        let seq = self.push_event(job, "destination", format);
        Ok((seq, format!("destination:{format}")))
    }

    /// Complete a live job (test helper modelling native finalization).
    pub fn complete_job(&mut self, job: &str) -> Result<u64, String> {
        self.require_live(job)?;
        if let Some(record) = self.jobs.get_mut(job) {
            record.state = JobState::Completed;
        }
        Ok(self.push_event(job, "completed", "out:0"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_orders_events() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.answer_choice(&id, "img:0").unwrap();
        table.complete_job(&id).unwrap();
        let events = table.events_for(&id);
        let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
        assert!(events.iter().any(|e| e.kind == "completed"));
    }

    #[test]
    fn unknown_and_stale_rejected() {
        let mut table = JobTable::new();
        assert_eq!(table.cancel_job("job:missing").unwrap_err(), "unknown");
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(table.cancel_job(&id).unwrap_err(), "stale");
        assert_eq!(table.answer_choice(&id, "img:0").unwrap_err(), "stale");
    }
}
