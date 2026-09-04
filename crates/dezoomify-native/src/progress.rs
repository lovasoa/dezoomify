//! Absolute progress snapshots (no clock).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Progress {
    pub acquired: u64,
    pub decoded: u64,
    pub written: u64,
    pub failed: u64,
    pub total: u64,
}

impl Progress {
    #[must_use]
    pub fn new(total: u64) -> Self {
        Self {
            acquired: 0,
            decoded: 0,
            written: 0,
            failed: 0,
            total,
        }
    }
}
