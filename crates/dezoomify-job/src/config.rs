//! Validated job configuration and resource limits.
//!
//! Bounds are explicit, target-safe, and checked before any work starts.
//! The lean engine enforces tile, byte, retry, and sequence bounds during
//! transitions; concurrency bounds gate how many tile fetches are in flight
//! at once.

use serde::{Deserialize, Serialize};

/// Maximum concurrent tile fetches allowed by validation.
pub const MAX_FETCHES: u32 = 64;
/// Maximum concurrent decodes allowed by validation.
pub const MAX_DECODES: u32 = 64;
/// Maximum tiles allowed by validation (matches protocol `MAX_COUNT` scale).
pub const MAX_TILES_LIMIT: u32 = 16_777_216;
/// Maximum retries allowed by validation.
pub const MAX_RETRIES_LIMIT: u32 = 1_024;
/// Maximum retained buffers allowed by validation.
pub const MAX_BUFFERS_LIMIT: u32 = 65_536;
/// Minimum metadata bytes accepted (smaller is a configuration error).
pub const MIN_BYTES: u64 = 1_024;
/// Maximum bytes for a single resource allowed by validation (4 GiB).
pub const MAX_BYTES_LIMIT: u64 = 4_294_967_296;

/// Typed configuration error with a stable machine-readable code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigError {
    pub code: String,
    pub message: String,
}

impl ConfigError {
    fn new(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            message,
        }
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ConfigError {}

/// Deterministic resource bounds for one job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub max_concurrent_fetches: u32,
    pub max_concurrent_decodes: u32,
    pub max_tiles: u32,
    pub max_retries: u32,
    pub max_buffers: u32,
    pub max_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_concurrent_fetches: 4,
            max_concurrent_decodes: 2,
            max_tiles: 4_096,
            max_retries: 3,
            max_buffers: 16,
            max_bytes: 67_108_864,
        }
    }
}

impl Config {
    /// Validate all bounds, rejecting zero, overflow, and unreasonable combos.
    ///
    /// # Errors
    ///
    /// Returns a typed [`ConfigError`] when any bound is zero, exceeds its
    /// documented maximum, or forms an unreasonable combination.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.max_concurrent_fetches == 0
            || self.max_concurrent_decodes == 0
            || self.max_tiles == 0
            || self.max_retries == 0
            || self.max_buffers == 0
            || self.max_bytes == 0
        {
            return Err(ConfigError::new(
                "job.invalid-config",
                "all config bounds must be non-zero".to_string(),
            ));
        }
        if self.max_concurrent_fetches > MAX_FETCHES {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!(
                    "max_concurrent_fetches {} exceeds {MAX_FETCHES}",
                    self.max_concurrent_fetches
                ),
            ));
        }
        if self.max_concurrent_decodes > MAX_DECODES {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!(
                    "max_concurrent_decodes {} exceeds {MAX_DECODES}",
                    self.max_concurrent_decodes
                ),
            ));
        }
        if self.max_tiles > MAX_TILES_LIMIT {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!("max_tiles {} exceeds {MAX_TILES_LIMIT}", self.max_tiles),
            ));
        }
        if self.max_retries > MAX_RETRIES_LIMIT {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!(
                    "max_retries {} exceeds {MAX_RETRIES_LIMIT}",
                    self.max_retries
                ),
            ));
        }
        if self.max_buffers > MAX_BUFFERS_LIMIT {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!(
                    "max_buffers {} exceeds {MAX_BUFFERS_LIMIT}",
                    self.max_buffers
                ),
            ));
        }
        if self.max_bytes < MIN_BYTES || self.max_bytes > MAX_BYTES_LIMIT {
            return Err(ConfigError::new(
                "job.resource-limit",
                format!("max_bytes {} out of range", self.max_bytes),
            ));
        }
        if self.max_concurrent_fetches > self.max_tiles {
            return Err(ConfigError::new(
                "job.invalid-config",
                "max_concurrent_fetches cannot exceed max_tiles".to_string(),
            ));
        }
        if self.max_concurrent_decodes > self.max_tiles {
            return Err(ConfigError::new(
                "job.invalid-config",
                "max_concurrent_decodes cannot exceed max_tiles".to_string(),
            ));
        }
        if self.max_buffers < self.max_concurrent_fetches {
            return Err(ConfigError::new(
                "job.invalid-config",
                "max_buffers cannot be smaller than max_concurrent_fetches".to_string(),
            ));
        }
        Ok(())
    }
}
