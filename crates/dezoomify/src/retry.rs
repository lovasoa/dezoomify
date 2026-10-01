//! Retry classification and bounded backoff.
use crate::model::{Error, ErrorCode};
/// Maximum honored `retry-after` hint (5 minutes); larger values clamp.
pub const MAX_RETRY_AFTER_MS: u64 = 300_000;
/// Backoff base delay for the first retry (1 second).
pub const RETRY_BASE_DELAY_MS: u64 = 1_000;
/// Backoff ceiling (30 seconds).
pub const RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Failures that end the whole job instead of settling one resource:
/// cancellation and binding-layer refusals. Discovery tolerates retries
/// only for codes outside this set (plus its own resource-limit sentinel).
#[must_use]
pub fn is_terminal_failure(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::JobCancelled | ErrorCode::TransportCancelled | ErrorCode::BindingInvalidValue
    )
}

/// Recompute `Error::retryable` from its `(code, http)` facts. Every code
/// rewrite goes through here (or [`crate::model::Error::with_code`]) so the
/// stored verdict never disagrees with [`is_retryable`].
#[must_use]
pub fn classify(mut error: Error) -> Error {
    error.retryable = is_retryable(error.code, error.http);
    error
}

/// Retry verdict for a job-level aggregate of settled resource failures:
/// any transient constituent keeps retry available ("transient failures
/// invite retry"), while an all-permanent failure set stays permanent.
#[must_use]
pub fn aggregate_retryable(failures: impl IntoIterator<Item = Error>) -> bool {
    failures.into_iter().any(|error| error.retryable)
}

/// Whether a failed resource acquisition may be retried.
///
/// HTTP status dominates when present: 408/425/429 and 5xx are transient
/// (429 honors `retry-after`); every other 4xx (including 403 auth
/// refusals and 404s) is permanent. Without a status, only the known
/// transient transport/service codes retry; anything else (bad metadata,
/// deterministic decode failures, other codes) is permanent so novel
/// failures fail closed instead of burning the retry budget.
#[must_use]
pub fn is_retryable(code: ErrorCode, http: Option<u16>) -> bool {
    if let Some(status) = http {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    matches!(
        code,
        ErrorCode::TransportTimeout
            | ErrorCode::TransportNetworkError
            | ErrorCode::UpstreamRateLimited
            | ErrorCode::ProxyRateLimited
            | ErrorCode::ProxyNetworkError
            | ErrorCode::ProxyError
            | ErrorCode::TransportHttpError
            | ErrorCode::DiscoveryHttpError
    )
}

/// Deterministic backoff delay in milliseconds for retry `attempt`
/// (1-based: the first retry is attempt 1).
///
/// Doubling from `base_ms` (the job's configured base, defaulting to
/// [`RETRY_BASE_DELAY_MS`]) up to [`RETRY_MAX_DELAY_MS`];
/// an explicit `retry_after_ms` hint overrides the computed backoff when
/// it is larger (hosts that observed `retry-after` wait at least that
/// long). Pure arithmetic: the Host owns the clock.
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
    fn retryable_is_always_derived_from_code_and_http() {
        // Birth derives from the code; rewrites re-derive; classification at
        // host boundaries re-derives from (code, http). The stored verdict
        // never disagrees with `is_retryable`.
        let error = Error::new(
            ErrorCode::TransportTimeout,
            crate::model::ErrorPhase::Acquisition,
            "x",
        );
        assert!(error.retryable);
        let error = error.with_code(ErrorCode::TransportBadUrl);
        assert!(!error.retryable);
        let mut error = Error::new(
            ErrorCode::HostInternal,
            crate::model::ErrorPhase::Discovery,
            "x",
        );
        error.http = Some(503);
        let error = classify(error);
        assert!(error.retryable);
        assert_eq!(error.retryable, is_retryable(error.code, error.http));
    }

    #[test]
    fn aggregate_verdict_comes_from_the_failure_set() {
        let transient = Error::new(
            ErrorCode::TransportNetworkError,
            crate::model::ErrorPhase::Acquisition,
            "x",
        );
        let permanent = Error::new(
            ErrorCode::TileDecodeFailed,
            crate::model::ErrorPhase::Decode,
            "x",
        );
        assert!(aggregate_retryable([transient.clone(), permanent.clone()]));
        assert!(!aggregate_retryable([permanent]));
        assert!(!aggregate_retryable([]));
    }

    #[test]
    fn forbidden_is_permanent_single_attempt() {
        assert!(!is_retryable(ErrorCode::TransportHttpError, Some(403)));
        // HTTP status dominates over even transient codes.
        assert!(!is_retryable(ErrorCode::TransportTimeout, Some(404)));
        assert!(!is_retryable(ErrorCode::TransportNetworkError, Some(401)));
    }

    #[test]
    fn transient_statuses_retry() {
        for status in [408, 425, 429, 500, 502, 503] {
            assert!(
                is_retryable(ErrorCode::TransportHttpError, Some(status)),
                "status {status}"
            );
        }
        for code in [
            ErrorCode::TransportTimeout,
            ErrorCode::TransportNetworkError,
            ErrorCode::UpstreamRateLimited,
            ErrorCode::ProxyRateLimited,
            ErrorCode::ProxyNetworkError,
        ] {
            assert!(is_retryable(code, None), "code {code}");
        }
    }

    #[test]
    fn non_transient_codes_fail_closed() {
        assert!(!is_retryable(ErrorCode::TileDecodeFailed, None));
        assert!(!is_retryable(ErrorCode::JobInvalidInput, None));
        assert!(!is_retryable(ErrorCode::CanvasPlanInvalid, None));
        assert!(!is_retryable(ErrorCode::HostInternal, None));
    }

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
