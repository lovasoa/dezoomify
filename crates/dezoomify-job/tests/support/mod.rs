//! Scripted deterministic host for job workflow tests.
//!
//! The host feeds scripted [`JobResponse`] inputs to a [`Job`] and collects a
//! transcript of `state:` / `effect:` / `event:` strings in deterministic
//! order. It performs no I/O, clock reads, or randomness during execution.

#![allow(dead_code)]

use dezoomify_job::{Config, Job, JobError, JobResponse, Outcome};

/// Deterministic host wrapping one [`Job`] plus an ordered transcript.
#[derive(Debug)]
pub struct ScriptedHost {
    job: Job,
    transcript: Vec<String>,
    last_state: String,
}

impl ScriptedHost {
    /// Create a host with a validated job, recording the initial state.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] when the job id, URL, or config is invalid.
    pub fn new(job_id: &str, input_url: &str, config: Config) -> Result<Self, JobError> {
        let job = Job::new(job_id, input_url, config)?;
        let last_state = job.state().name().to_string();
        let mut host = Self {
            job,
            transcript: Vec::new(),
            last_state: String::new(),
        };
        host.transcript.push(format!("state:{last_state}"));
        host.last_state = last_state;
        Ok(host)
    }

    /// Start the job and record resulting effects/events/state.
    ///
    /// # Errors
    ///
    /// Propagates [`JobError`] from [`Job::start`].
    pub fn start(&mut self) -> Result<Outcome, JobError> {
        let outcome = self.job.start()?;
        self.record();
        Ok(outcome)
    }

    /// Apply one scripted response and record resulting effects/events/state.
    ///
    /// # Errors
    ///
    /// Propagates [`JobError`] rejections; rejected and ignored inputs leave
    /// the transcript unchanged.
    pub fn apply(&mut self, response: JobResponse) -> Result<Outcome, JobError> {
        let outcome = self.job.on_response(response);
        match &outcome {
            Ok(_) => {
                self.record();
            }
            Err(_) => {
                // Rejections must not add work: drains stay empty and state is
                // unchanged, so recording is a no-op. Drain defensively to
                // prove no queued work leaked.
                let effects = self.job.drain_effects();
                let events = self.job.drain_events();
                debug_assert!(effects.is_empty(), "rejection queued effects");
                debug_assert!(events.is_empty(), "rejection queued events");
            }
        }
        outcome
    }

    /// Ordered transcript of `state:` / `effect:` / `event:` entries.
    #[must_use]
    pub fn transcript(&self) -> &[String] {
        &self.transcript
    }

    /// Current job state name.
    #[must_use]
    pub fn state(&self) -> String {
        self.job.state().name().to_string()
    }

    /// Borrow the inner job for terminal and queue assertions.
    #[must_use]
    pub fn job(&self) -> &Job {
        &self.job
    }

    /// Count terminal events in the transcript (must be 0 or 1).
    #[must_use]
    pub fn terminal_count(&self) -> usize {
        self.transcript
            .iter()
            .filter(|line| {
                line.starts_with("event:completed:")
                    || line.starts_with("event:partial-completed:")
                    || line.starts_with("event:failed:")
                    || line.starts_with("event:cancelled:")
            })
            .count()
    }

    /// Canonical JSON array of the transcript (pretty, LF ending).
    #[must_use]
    pub fn canonical_json(&self) -> String {
        serde_json::to_string_pretty(&self.transcript).unwrap_or_else(|_| "[]".to_string()) + "\n"
    }

    fn record(&mut self) {
        let mut pending: Vec<(u64, String)> = Vec::new();
        for effect in self.job.drain_effects() {
            pending.push(format_effect(&effect));
        }
        for event in self.job.drain_events() {
            pending.push(format_event(&event));
        }
        pending.sort_by_key(|(seq, _)| *seq);
        for (_, line) in pending {
            self.transcript.push(line);
        }
        let current = self.job.state().name().to_string();
        if current != self.last_state {
            self.transcript.push(format!("state:{current}"));
            self.last_state = current;
        }
    }
}

fn seq_of(value: &serde_json::Value) -> u64 {
    value
        .get("seq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::MAX)
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn format_effect(value: &serde_json::Value) -> (u64, String) {
    let seq = seq_of(value);
    let kind = str_field(value, "kind").unwrap_or_else(|| "-".to_string());
    let corr = match kind.as_str() {
        "acquire-resource" => str_field(value, "request"),
        "acquire-tile" | "decode-pixels" => str_field(value, "tile"),
        "publish-output" => str_field(value, "output"),
        "request-decision" => str_field(value, "recovery"),
        _ => str_field(value, "effect"),
    }
    .or_else(|| str_field(value, "effect"))
    .unwrap_or_else(|| "-".to_string());
    (seq, format!("effect:{kind}:{corr}:seq:{seq}"))
}

fn format_event(value: &serde_json::Value) -> (u64, String) {
    let seq = seq_of(value);
    let kind = str_field(value, "kind").unwrap_or_else(|| "-".to_string());
    let detail = match kind.as_str() {
        "job-state" => str_field(value, "state"),
        "catalog" => value
            .get("images")
            .and_then(|images| images.as_array())
            .and_then(|images| images.first())
            .and_then(|first| first.get("id"))
            .and_then(|id| id.as_str())
            .map(ToString::to_string),
        "levels" => value
            .get("levels")
            .and_then(|levels| levels.as_array())
            .and_then(|levels| levels.first())
            .and_then(|id| id.as_str())
            .map(ToString::to_string),
        "progress" => {
            let acquired = value
                .get("acquired")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let total = value
                .get("total")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            Some(format!("{acquired}/{total}"))
        }
        "warning" => match (str_field(value, "tile"), value.get("attempt")) {
            (Some(tile), Some(attempt)) => Some(format!("{tile}#{attempt}")),
            (Some(tile), None) => Some(tile),
            _ => None,
        },
        "recovery-requested" => str_field(value, "reason"),
        "missing-work" => value.get("failed").and_then(|failed| {
            failed.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
        }),
        "completed" | "partial-completed" => str_field(value, "output"),
        "failed" => str_field(value, "code"),
        _ => None,
    }
    .unwrap_or_else(|| "-".to_string());
    (seq, format!("event:{kind}:{detail}:seq:{seq}"))
}
