//! Typed inputs and ordered outputs for the deterministic job engine.

use std::collections::BTreeMap;

use dezoomify_core::core::discovery::FetchCause;
use dezoomify_core::Vec2d;
use dezoomify_protocol::dto::CatalogDto;
use serde::{Deserialize, Serialize};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    Ignored,
}

/// Deterministic host/user input. Correlation is local to one `Job`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobCommand {
    ResourceBytes {
        request: u32,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    },
    FetchFailure {
        request: u32,
        /// Typed cause of the failed fetch; the engine groups discovery
        /// diagnostics on it, never on rendered text.
        cause: FetchCause,
    },
    SelectImage {
        image: u32,
    },
    SelectLevel {
        level: u32,
    },
    TileOutcome {
        tile: u32,
        ok: bool,
    },
    ProbeOutcome {
        tile: u32,
        available: bool,
        width: u64,
        height: u64,
    },
    RecoveryChoice {
        generation: u32,
        choice: RecoveryChoice,
    },
    FinalizationSucceeded,
    FinalizationFailed {
        code: String,
        message: String,
    },
    Cancel,
    Pause,
    Resume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryChoice {
    Keep,
    Retry,
    Discard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobEffect {
    AcquireResource {
        request: u32,
        uri: String,
        header_names: Vec<String>,
    },
    AcquireTile {
        tile: u32,
        uri: String,
        headers: BTreeMap<String, String>,
        processing: String,
        destination: Vec2d,
        expected_size: Option<Vec2d>,
        canvas: Option<Vec2d>,
        probe: bool,
    },
    FinalizeOutput {
        partial: bool,
        format: String,
        canvas: Option<Vec2d>,
    },
    CancelWork,
    RequestDecision {
        generation: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobEvent {
    State { state: crate::State },
    Catalog { catalog: CatalogDto },
    Levels { image: u32, levels: Vec<u32> },
    Progress { acquired: u64, total: u64 },
    Warning { tile: u32, attempt: u32 },
    MissingWork { failed: Vec<u32> },
    RecoveryRequested { generation: u32 },
    Completed,
    PartialCompleted,
    Failed { code: String, message: String },
    Cancelled,
    Paused,
    Resumed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobMessageBody {
    Effect(JobEffect),
    Event(JobEvent),
}

/// One item in the job's single FIFO queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobMessage {
    pub sequence: u32,
    pub body: JobMessageBody,
}
