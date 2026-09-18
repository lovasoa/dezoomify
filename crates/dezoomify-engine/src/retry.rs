//! Typed tile-failure classification and deterministic retry budgets.
//!
//! Tile results carry structured failures, and this module owns the closed
//! classification:
//!
//! * [`classify_tile_failure`] maps one structured failure (stable code plus
//!   an optional HTTP status) onto [`FailureCategory`]. Permanent failures
//!   (auth refusals, missing resources, bad metadata, deterministic decode
//!   failures, unknown codes) are never retried: exactly one attempt.
//!   Transient failures (timeouts, network errors, rate limits, 5xx) retry
//!   up to the job's exact budget.
//! * [`retry_delay_ms`] derives the explicit timer delay for attempt `n`
//!   from pure arithmetic (no clocks in the engine): exponential backoff
//!   with a bounded ceiling, honoring an explicit `retry-after` hint when
//!   the host observed one.
//! * [`TileFailure`] carries the bounded structured facts for one failed
//!   attempt: category, stable code, HTTP status, retry-after hint, and a
//!   length-capped diagnostic detail string. Secrets, pixels, paths, and
//!   handles never enter it.
//!
//! Everything here is pure and deterministic: no I/O, no clocks, no tasks.

/// Retryability of one classified tile failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FailureCategory {
    /// Never retried: exactly one attempt (auth, 4xx, bad metadata,
    /// deterministic decode failure, unknown code).
    Permanent,
    /// Retried up to the job's exact budget with explicit timer effects.
    Transient,
}

impl FailureCategory {
    /// Whether the engine may schedule another attempt.
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::Transient)
    }
}

/// Structured facts for one failed tile attempt.
///
/// `detail` is capped at [`MAX_FAILURE_DETAIL_CHARS`] characters; longer
/// input is truncated on construction so diagnostics stay bounded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TileFailure {
    /// Stable machine-readable code (never branched on display text).
    pub code: String,
    /// Closed retry category derived at construction via
    /// [`classify_tile_failure`].
    pub category: FailureCategory,
    /// Observed HTTP status, when the failure was an HTTP refusal.
    pub http: Option<u16>,
    /// Host-observed `retry-after` hint in milliseconds, when present.
    pub retry_after_ms: Option<u64>,
    /// Bounded diagnostic detail (server signal excerpt, never secrets).
    pub detail: Option<String>,
}

/// Maximum diagnostic detail characters kept per failure.
pub const MAX_FAILURE_DETAIL_CHARS: usize = 300;
/// Maximum honored `retry-after` hint (5 minutes); larger values clamp.
pub const MAX_RETRY_AFTER_MS: u64 = 300_000;
/// Backoff base delay for the first retry (1 second).
pub const RETRY_BASE_DELAY_MS: u64 = 1_000;
/// Backoff ceiling (30 seconds).
pub const RETRY_MAX_DELAY_MS: u64 = 30_000;

impl TileFailure {
    /// Build a classified failure, truncating `detail` to the bounded
    /// cap and clamping `retry_after_ms` to the honored maximum.
    #[must_use]
    pub fn new(
        code: impl Into<String>,
        http: Option<u16>,
        retry_after_ms: Option<u64>,
        detail: Option<String>,
    ) -> Self {
        let code = code.into();
        let category = classify_tile_failure(&code, http);
        let retry_after_ms = retry_after_ms
            .filter(|_| category.is_retryable())
            .map(|value| value.min(MAX_RETRY_AFTER_MS));
        let detail = detail.map(|text| {
            let truncated: String = text.chars().take(MAX_FAILURE_DETAIL_CHARS).collect();
            truncated
        });
        Self {
            code,
            category,
            http,
            retry_after_ms,
            detail,
        }
    }

    /// Whether the engine may schedule another attempt for this failure.
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        self.category.is_retryable()
    }
}

/// Classify one structured tile failure.
///
/// HTTP status dominates when present: 408/425/429 and 5xx are transient
/// (429 honors `retry-after`); every other 4xx (including 403 auth
/// refusals and 404s) is permanent. Without a status, only the known
/// transient transport/service codes retry; anything else (bad metadata,
/// deterministic decode failures, unknown codes) is permanent so novel
/// failures fail closed instead of burning the retry budget.
#[must_use]
pub fn classify_tile_failure(code: &str, http: Option<u16>) -> FailureCategory {
    if let Some(status) = http {
        return match status {
            408 | 425 | 429 => FailureCategory::Transient,
            400..=499 => FailureCategory::Permanent,
            500..=599 => FailureCategory::Transient,
            _ => FailureCategory::Permanent,
        };
    }
    match code {
        "TRANSPORT_TIMEOUT"
        | "TRANSPORT_NETWORK_ERROR"
        | "UPSTREAM_RATE_LIMITED"
        | "PROXY_RATE_LIMITED"
        | "PROXY_NETWORK_ERROR"
        | "PROXY_ERROR"
        | "TRANSPORT_HTTP_ERROR"
        | "DISCOVERY_HTTP_ERROR" => FailureCategory::Transient,
        _ => FailureCategory::Permanent,
    }
}

/// Deterministic backoff delay in milliseconds for retry `attempt`
/// (1-based: the first retry is attempt 1).
///
/// Doubling from [`RETRY_BASE_DELAY_MS`] up to [`RETRY_MAX_DELAY_MS`];
/// an explicit `retry_after_ms` hint overrides the computed backoff when
/// it is larger (hosts that observed `retry-after` wait at least that
/// long). Pure arithmetic: the host owns the clock and reports elapsed
/// time back as an explicit completion.
#[must_use]
pub fn retry_delay_ms(attempt: u32, retry_after_ms: Option<u64>) -> u64 {
    let shift = attempt.saturating_sub(1).min(5);
    let backoff = RETRY_BASE_DELAY_MS
        .saturating_mul(1 << shift)
        .min(RETRY_MAX_DELAY_MS);
    match retry_after_ms {
        Some(hint) => backoff.max(hint.min(MAX_RETRY_AFTER_MS)),
        None => backoff,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_is_permanent_single_attempt() {
        assert_eq!(
            classify_tile_failure("TRANSPORT_HTTP_ERROR", Some(403)),
            FailureCategory::Permanent
        );
        assert_eq!(
            classify_tile_failure("anything", Some(404)),
            FailureCategory::Permanent
        );
        assert_eq!(
            classify_tile_failure("anything", Some(401)),
            FailureCategory::Permanent
        );
    }

    #[test]
    fn transient_statuses_retry() {
        for status in [408, 425, 429, 500, 502, 503] {
            assert_eq!(
                classify_tile_failure("TRANSPORT_HTTP_ERROR", Some(status)),
                FailureCategory::Transient,
                "status {status}"
            );
        }
        for code in [
            "TRANSPORT_TIMEOUT",
            "TRANSPORT_NETWORK_ERROR",
            "UPSTREAM_RATE_LIMITED",
            "PROXY_RATE_LIMITED",
            "PROXY_NETWORK_ERROR",
        ] {
            assert_eq!(
                classify_tile_failure(code, None),
                FailureCategory::Transient,
                "code {code}"
            );
        }
    }

    #[test]
    fn unknown_and_decode_codes_fail_closed() {
        assert_eq!(
            classify_tile_failure("extension.network", None),
            FailureCategory::Permanent
        );
        assert_eq!(
            classify_tile_failure("decode.unsupported", None),
            FailureCategory::Permanent
        );
        assert_eq!(classify_tile_failure("", None), FailureCategory::Permanent);
    }

    #[test]
    fn backoff_doubles_to_ceiling_and_honors_retry_after() {
        assert_eq!(retry_delay_ms(1, None), 1_000);
        assert_eq!(retry_delay_ms(2, None), 2_000);
        assert_eq!(retry_delay_ms(3, None), 4_000);
        assert_eq!(retry_delay_ms(10, None), RETRY_MAX_DELAY_MS);
        assert_eq!(retry_delay_ms(1, Some(5_000)), 5_000);
        assert_eq!(retry_delay_ms(4, Some(500)), 8_000);
        assert_eq!(retry_delay_ms(1, Some(u64::MAX)), MAX_RETRY_AFTER_MS);
    }

    #[test]
    fn permanent_failure_drops_retry_hint_and_bounds_diagnostics() {
        let long = "x".repeat(10_000);
        let failure = TileFailure::new("TRANSPORT_HTTP_ERROR", Some(403), Some(5_000), Some(long));
        assert_eq!(failure.category, FailureCategory::Permanent);
        // Permanent failures drop the retry hint: nothing to wait for.
        assert_eq!(failure.retry_after_ms, None);
        assert_eq!(failure.detail.as_ref().map(String::len), Some(300));
        assert!(!failure.is_retryable());
    }

    #[test]
    fn transient_failure_keeps_clamped_hint() {
        let failure = TileFailure::new("TRANSPORT_TIMEOUT", Some(503), Some(u64::MAX), None);
        assert_eq!(failure.retry_after_ms, Some(MAX_RETRY_AFTER_MS));
        assert!(failure.is_retryable());
    }
}
