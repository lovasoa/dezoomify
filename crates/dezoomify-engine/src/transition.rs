//! Typed inputs and ordered effects for the deterministic job engine.

use std::collections::BTreeMap;

use dezoomify_core::Vec2d;
use dezoomify_core::core::discovery::FetchCause;
/// Canonical partial-decision vocabulary, owned by the protocol. The engine
/// answers the outstanding partial decision with this exact type; there is
/// no engine-local duplicate.
pub use dezoomify_protocol::dto::RecoveryChoice;
use dezoomify_protocol::dto::{OutputFormat, ProbeOutcome as ProbeObservation};
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
    /// Follow one still-deferred catalog entry within the same job: the
    /// engine fetches the entry's follow-up URI with a bounded,
    /// cycle-guarded budget and replaces the catalog on success. No host
    /// recursive replacement jobs: the job ID and revision lineage never
    /// change. Valid only before any image is selected.
    FollowDeferred {
        image: u32,
    },
    SelectLevel {
        level: u32,
    },
    /// Successful tile acquisition: the host holds the decoded tile and the
    /// engine records progress. Native hosts decode during acquisition;
    /// browser hosts report an ordinary image element through
    /// `TileDisplayed`. Both settle the tile identically; the host-side
    /// observation (readable bytes vs display-only) is reported through the
    /// output disposition, never through this command.
    TileAcquired {
        tile: u32,
    },
    /// Display-only success for one tile: the host holds an ordinary image
    /// element with no readable bytes. Records progress exactly like
    /// `TileAcquired`; the tainted output completes as display-only
    /// downstream.
    TileDisplayed {
        tile: u32,
    },
    /// Typed tile result carrying structured failure facts (code, HTTP
    /// status, retry-after hint, bounded diagnostics). Permanent failures
    /// (e.g. HTTP 403) are never retried and transient failures retry on
    /// the exact budget with explicit timer effects.
    TileFailed {
        tile: u32,
        failure: crate::retry::TileFailure,
    },
    /// Host-reported elapsed retry timer for one pending retry. The engine
    /// owns no clocks; the host waits `delay_ms` from the matching
    /// `WaitForRetry` effect and answers with the same tile and attempt.
    /// Stale or duplicate completions are ignored.
    RetryTimerElapsed {
        tile: u32,
        attempt: u32,
    },
    ProbeOutcome {
        tile: u32,
        outcome: ProbeObservation,
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
        processing: dezoomify_core::core::model::ProcessingRecipe,
        destination: Vec2d,
        expected_size: Option<Vec2d>,
        canvas: Option<Vec2d>,
        probe: bool,
        probe_output: bool,
    },
    FinalizeOutput {
        partial: bool,
        format: OutputFormat,
        canvas: Option<Vec2d>,
    },
    /// Explicit retry wait: the host waits `delay_ms` (engine-computed
    /// backoff honoring any observed `retry-after`) and then answers with
    /// `RetryTimerElapsed` carrying the same tile and attempt. No new
    /// acquisition for this tile starts before that completion. While
    /// paused, timers are issued on resume instead.
    WaitForRetry {
        tile: u32,
        attempt: u32,
        delay_ms: u64,
    },
    CancelWork,
    RequestDecision {
        generation: u32,
    },
}
