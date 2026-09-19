//! Portable job states.
//!
//! The engine exposes only phases it can observe directly. Host-local codec
//! and save progress is not represented here.

use serde::{Deserialize, Serialize};

/// Portable engine phases.
///
/// Pause is an orthogonal suspend-acquisition overlay
/// (`Job::is_paused`), not new states: `paused` stops scheduling new
/// `acquire-tile` effects, finishes in-flight work, retains decoded output,
/// and re-drives on resume. State names and terminal semantics are unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum State {
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    Planning,
    AcquiringTiles,
    AwaitingPartialDecision,
    Finalizing,
    Cancelling,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

impl State {
    /// Stable PascalCase name used in transcripts and `job-state` events.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Discovering => "Discovering",
            Self::AwaitingImageSelection => "AwaitingImageSelection",
            Self::AwaitingLevelSelection => "AwaitingLevelSelection",
            Self::Planning => "Planning",
            Self::AcquiringTiles => "AcquiringTiles",
            Self::AwaitingPartialDecision => "AwaitingPartialDecision",
            Self::Finalizing => "Finalizing",
            Self::Cancelling => "Cancelling",
            Self::Completed => "Completed",
            Self::PartiallyCompleted => "PartiallyCompleted",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }
}

impl std::fmt::Display for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}
