use crate::model::Error;
use std::collections::VecDeque;

const RAMP_INTERVAL_MS: u64 = 30_000;
const FORBIDDEN_WINDOW_MS: u64 = 60_000;
const QUICK_PROBE_MS: u64 = 1_000;
const ESTABLISHED_SUCCESSES: u32 = 8;
const MAX_RATE: f64 = 64.0;

pub(super) enum Admission {
    Ready(u64),
    Wait(u32),
    Blocked,
}

pub(super) enum Feedback {
    Ordinary,
    Shared,
    Backoff(u64),
}

struct Recovery {
    tile: u32,
    until: u64,
    started: u64,
    forbidden: bool,
    // An isolated, permanently refused tile gets only the quick retry.
    widespread: bool,
    quick: bool,
}

/// AIMD controls request starts/second, independently of worker concurrency.
/// A recovery admits only its owner until a probe has actually succeeded.
pub(super) struct Controller {
    rate: f64,
    ceiling: f64,
    starts: VecDeque<u64>,
    last_start: Option<u64>,
    next_ramp: u64,
    generation: u64,
    successes: u32,
    inflight: u32,
    recovery: Option<Recovery>,
}

impl Controller {
    pub(super) fn new(initial_interval_ms: u32) -> Self {
        Self {
            rate: if initial_interval_ms == 0 {
                0.0
            } else {
                1000.0 / f64::from(initial_interval_ms)
            },
            ceiling: MAX_RATE,
            starts: VecDeque::new(),
            last_start: None,
            next_ramp: RAMP_INTERVAL_MS,
            generation: 0,
            successes: 0,
            inflight: 0,
            recovery: None,
        }
    }

    pub(super) fn blocked(&self, tile: u32) -> bool {
        // Drain the old cohort before probing: collect corroborating refusals
        // and honor its longest Retry-After before releasing any new traffic.
        self.recovery
            .as_ref()
            .is_some_and(|recovery| recovery.tile != tile || self.inflight > 0)
    }

    pub(super) fn admit(&mut self, now: u64, tile: u32) -> Admission {
        if self.blocked(tile) {
            return Admission::Blocked;
        }
        let ready = self.recovery.as_ref().map_or_else(
            || {
                self.last_start
                    .map_or(0, |last| last.saturating_add(self.interval_ms()))
            },
            |recovery| recovery.until,
        );
        if ready > now {
            return Admission::Wait((ready - now).min(u64::from(u32::MAX)) as u32);
        }
        // Idle time buys neither burst credits nor an immediate rate increase.
        if self
            .last_start
            .is_none_or(|last| now.saturating_sub(last) > self.interval_ms().saturating_mul(2))
        {
            self.next_ramp = now.saturating_add(RAMP_INTERVAL_MS);
        }
        self.last_start = Some(now);
        self.inflight += 1;
        self.starts.push_back(now);
        while self.starts.len() > 64
            || self
                .starts
                .front()
                .is_some_and(|start| now.saturating_sub(*start) > 10_000)
        {
            self.starts.pop_front();
        }
        Admission::Ready(self.generation)
    }

    pub(super) fn succeeded(&mut self, generation: u64, tile: u32, now: u64) {
        self.inflight -= 1;
        if generation != self.generation {
            return;
        }
        self.successes = self.successes.saturating_add(1);
        if self
            .recovery
            .as_ref()
            .is_some_and(|recovery| recovery.tile == tile)
        {
            self.recovery = None;
            self.next_ramp = now.saturating_add(FORBIDDEN_WINDOW_MS);
        } else if self.rate > 0.0 && now >= self.next_ramp {
            self.rate = (self.rate + 0.25).min(self.ceiling);
            self.next_ramp = now.saturating_add(RAMP_INTERVAL_MS);
        }
    }

    pub(super) fn failed(
        &mut self,
        generation: u64,
        tile: u32,
        error: &Error,
        now: u64,
        delay_ms: u64,
    ) -> Feedback {
        self.inflight -= 1;
        let cause = error.cause();
        let forbidden = matches!(cause, Error::HttpError { status: 403, .. });
        let explicit = matches!(
            cause,
            Error::RateLimited { .. } | Error::HttpError { status: 429, .. }
        ) || (forbidden && error.retry_after_ms().is_some());
        if !explicit && !forbidden {
            if generation == self.generation {
                self.recovery = None
            }
            return Feedback::Ordinary;
        }
        if generation != self.generation {
            if let Some(recovery) = &mut self.recovery {
                recovery.widespread |= forbidden && recovery.tile != tile;
                if explicit {
                    recovery.until = recovery.until.max(now.saturating_add(delay_ms));
                    recovery.quick = false;
                }
            }
            return Feedback::Shared;
        }
        if let Some(recovery) = &mut self.recovery
            && forbidden
            && recovery.forbidden
        {
            if !recovery.quick || !recovery.widespread {
                return Feedback::Ordinary;
            }
            recovery.quick = false;
            // One final probe after the window; never repeat this wait for 403.
            recovery.until = recovery
                .started
                .saturating_add(FORBIDDEN_WINDOW_MS)
                .max(now);
            return Feedback::Backoff(recovery.until.saturating_sub(now));
        }
        if forbidden && !explicit && self.successes < ESTABLISHED_SUCCESSES {
            return Feedback::Ordinary;
        }
        self.reduce_rate(now);
        self.generation += 1;
        self.recovery = Some(Recovery {
            tile,
            started: now,
            until: now.saturating_add(if explicit { delay_ms } else { QUICK_PROBE_MS }),
            forbidden,
            widespread: false,
            quick: !explicit,
        });
        Feedback::Backoff(if explicit { delay_ms } else { QUICK_PROBE_MS })
    }

    fn reduce_rate(&mut self, now: u64) {
        let observed = self
            .starts
            .front()
            .zip(self.starts.back())
            .and_then(|(first, last)| {
                (last > first)
                    .then(|| (self.starts.len() - 1) as f64 * 1000.0 / (last - first) as f64)
            })
            .unwrap_or(4.0);
        let current = if self.rate == 0.0 {
            observed
        } else {
            self.rate.min(observed)
        };
        self.rate = (current * 0.5).clamp(0.01, MAX_RATE);
        self.ceiling = self.ceiling.min(current * 0.8).max(self.rate);
        self.next_ramp = now.saturating_add(FORBIDDEN_WINDOW_MS);
    }

    fn interval_ms(&self) -> u64 {
        if self.rate == 0.0 {
            return 0;
        }
        (1000.0 / self.rate).ceil() as u64
    }
}
