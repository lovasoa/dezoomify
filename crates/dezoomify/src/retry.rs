//! Deterministic backoff arithmetic. The retry verdict is
//! [`crate::model::Error::retryable`] (with its [`crate::model::Error::retry_after_ms`]
//! hint); this module owns only the pure delay computation. The Host owns
//! the clock.
/// Maximum honored `retry-after` hint (5 minutes); larger values clamp.
pub const MAX_RETRY_AFTER_MS: u64 = 300_000;
/// Backoff base delay for the first retry (1 second).
pub const RETRY_BASE_DELAY_MS: u64 = 1_000;
/// Backoff ceiling (30 seconds).
pub const RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Deterministic backoff delay in milliseconds for retry `attempt`
/// (1-based: the first retry is attempt 1).
///
/// Doubling from `base_ms` (the job's configured base, defaulting to
/// [`RETRY_BASE_DELAY_MS`]) up to [`RETRY_MAX_DELAY_MS`];
/// an explicit `retry_after_ms` hint overrides the computed backoff when
/// it is larger (hosts that observed `retry-after` wait at least that
/// long).
#[must_use]
pub fn retry_delay_ms(attempt: u32, retry_after_ms: Option<u64>, base_ms: u64) -> u64 {
    let shift = attempt.saturating_sub(1).min(5);
    let backoff = base_ms.saturating_mul(1 << shift).min(RETRY_MAX_DELAY_MS);
    match retry_after_ms {
        Some(hint) => backoff.max(hint.min(MAX_RETRY_AFTER_MS)),
        None => backoff,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_ceiling_and_honors_retry_after() {
        assert_eq!(retry_delay_ms(1, None, RETRY_BASE_DELAY_MS), 1_000);
        assert_eq!(retry_delay_ms(2, None, RETRY_BASE_DELAY_MS), 2_000);
        assert_eq!(retry_delay_ms(3, None, RETRY_BASE_DELAY_MS), 4_000);
        assert_eq!(
            retry_delay_ms(10, None, RETRY_BASE_DELAY_MS),
            RETRY_MAX_DELAY_MS
        );
        assert_eq!(retry_delay_ms(1, Some(5_000), RETRY_BASE_DELAY_MS), 5_000);
        assert_eq!(retry_delay_ms(4, Some(500), RETRY_BASE_DELAY_MS), 8_000);
        assert_eq!(
            retry_delay_ms(1, Some(u64::MAX), RETRY_BASE_DELAY_MS),
            MAX_RETRY_AFTER_MS
        );
        assert_eq!(retry_delay_ms(1, None, 2_000), 2_000);
    }
}
