//! Deterministic inputs, outcomes, errors, and message builders.
//!
//! [`JobResponse`] is the lean test-oriented input enum: every variant carries
//! its owning `job` id so wrong-job correlation is rejected without state
//! corruption. Effects and events are `serde_json::Value` objects with
//! `{kind, seq, job}` plus correlation ids.

use serde::{Deserialize, Serialize};

/// Stable error for rejected inputs and typed terminal failures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

impl JobError {
    #[must_use]
    pub fn new(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            message,
        }
    }

    #[must_use]
    pub fn wrong_job(expected: &str) -> Self {
        Self::new(
            "job.wrong-job",
            format!("response for unknown job, expected {expected}"),
        )
    }

    #[must_use]
    pub fn post_terminal() -> Self {
        Self::new(
            "job.post-terminal",
            "job is terminal; input rejected with no new work".to_string(),
        )
    }

    #[must_use]
    pub fn invalid_state(detail: &str) -> Self {
        Self::new(
            "job.invalid-state",
            format!("input not valid in current state: {detail}"),
        )
    }

    #[must_use]
    pub fn invalid_id(detail: &str) -> Self {
        Self::new("job.invalid-id", format!("invalid id: {detail}"))
    }

    #[must_use]
    pub fn invalid_config(detail: String) -> Self {
        Self::new("job.invalid-config", detail)
    }

    #[must_use]
    pub fn resource_limit(detail: String) -> Self {
        Self::new("job.resource-limit", detail)
    }

    #[must_use]
    pub fn overflow(detail: &str) -> Self {
        Self::new("job.overflow", format!("counter overflow: {detail}"))
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for JobError {}

/// Result of applying one response: state changed or safely ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    Ignored,
}

/// Deterministic host/user input driving the state machine.
///
/// Every variant carries the owning `job` id for correlation. The enum is
/// synchronous and carries no bytes, clocks, or I/O handles—only ids, sizes,
/// and decisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobResponse {
    ResourceBytes {
        job: String,
        request: String,
        bytes_len: u64,
    },
    FetchFailure {
        job: String,
        request: String,
    },
    SelectedImage {
        job: String,
        image: String,
    },
    SelectedLevel {
        job: String,
        level: String,
    },
    DestinationGranted {
        job: String,
        destination: String,
    },
    DestinationDenied {
        job: String,
    },
    TileOutcome {
        job: String,
        tile: String,
        ok: bool,
    },
    RetryReady {
        job: String,
        attempt: String,
    },
    PartialKeep {
        job: String,
        keep: bool,
    },
    Cancel {
        job: String,
    },
}

impl JobResponse {
    /// Owning job id for correlation checks.
    #[must_use]
    pub fn job_id(&self) -> &str {
        match self {
            Self::ResourceBytes { job, .. }
            | Self::FetchFailure { job, .. }
            | Self::SelectedImage { job, .. }
            | Self::SelectedLevel { job, .. }
            | Self::DestinationGranted { job, .. }
            | Self::DestinationDenied { job }
            | Self::TileOutcome { job, .. }
            | Self::RetryReady { job, .. }
            | Self::PartialKeep { job, .. }
            | Self::Cancel { job } => job,
        }
    }
}

/// Build an effect object with `{kind, seq, job}` plus caller detail.
///
/// Detail keys are merged after the base keys; base keys always win on
/// collision so correlation can never be spoofed by detail payloads.
pub(crate) fn make_effect(
    kind: &str,
    seq: u64,
    job: &str,
    detail: serde_json::Value,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "kind".to_string(),
        serde_json::Value::String(kind.to_string()),
    );
    map.insert("seq".to_string(), serde_json::Value::from(seq));
    map.insert(
        "job".to_string(),
        serde_json::Value::String(job.to_string()),
    );
    if let serde_json::Value::Object(extra) = detail {
        for (k, v) in extra {
            if k != "kind" && k != "seq" && k != "job" {
                map.insert(k, v);
            }
        }
    }
    serde_json::Value::Object(map)
}

/// Build an event object with `{kind, seq, job}` plus caller detail.
pub(crate) fn make_event(
    kind: &str,
    seq: u64,
    job: &str,
    detail: serde_json::Value,
) -> serde_json::Value {
    make_effect(kind, seq, job, detail)
}
