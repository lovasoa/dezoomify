//! Portable job states.
//!
//! The engine distinguishes every externally visible phase so hosts and UI
//! observers never infer lifecycle policy from messages. Terminal states emit
//! exactly one terminal event; all other states are non-terminal.

use serde::{Deserialize, Serialize};

/// All 19 externally distinguishable job states.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum State {
    Created,
    Discovering,
    AwaitingImageSelection,
    AwaitingLevelSelection,
    AwaitingDestination,
    Planning,
    AcquiringTiles,
    ProcessingTiles,
    AwaitingPartialDecision,
    AwaitingRecovery,
    Encoding,
    Finalizing,
    Publishing,
    CleaningUp,
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
            Self::AwaitingDestination => "AwaitingDestination",
            Self::Planning => "Planning",
            Self::AcquiringTiles => "AcquiringTiles",
            Self::ProcessingTiles => "ProcessingTiles",
            Self::AwaitingPartialDecision => "AwaitingPartialDecision",
            Self::AwaitingRecovery => "AwaitingRecovery",
            Self::Encoding => "Encoding",
            Self::Finalizing => "Finalizing",
            Self::Publishing => "Publishing",
            Self::CleaningUp => "CleaningUp",
            Self::Cancelling => "Cancelling",
            Self::Completed => "Completed",
            Self::PartiallyCompleted => "PartiallyCompleted",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
        }
    }

    /// Whether this state is terminal (exactly one terminal event emitted).
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::PartiallyCompleted | Self::Failed | Self::Cancelled
        )
    }
}

impl std::fmt::Display for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}
