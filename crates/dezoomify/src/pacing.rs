//! Per-origin admission and feedback, independent of transports and retry loops.
mod controller;

use crate::{
    Host,
    model::{Error, Gate, HostTiming, RequestPacing},
};
use controller::{Admission, Controller, Feedback};
use futures_util::future::poll_fn;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    task::{Poll, Waker},
};

/// One origin's controller and tasks awaiting a recovery-state change.
struct Origin {
    controller: Controller,
    waiters: Vec<Waker>,
}

/// Identifies one admitted HTTP attempt. Report it once through
/// [`Scheduler::succeeded`] or [`Scheduler::failed`], unless aborting the job.
pub(crate) struct Ticket {
    origin: String,
    generation: u64,
    tile: u32,
}

/// Job-scoped pacing and recovery shared across tiles and pyramid levels.
/// All calls must use the same Host timing origin.
pub(crate) struct Scheduler {
    origins: RefCell<HashMap<String, Origin>>,
    pacing: Option<RequestPacing>,
    observed_ms: Cell<u64>,
}

impl Scheduler {
    /// Use validated per-origin pacing; absence defers pacing until throttling.
    pub(crate) fn new(pacing: Option<RequestPacing>) -> Self {
        Self {
            origins: RefCell::default(),
            pacing,
            observed_ms: Cell::new(0),
        }
    }

    /// Wait to admit one attempt, using a job-unique `tile` index kept stable across retries.
    /// Non-HTTP URIs return `None` after passing the Host acquisition checkpoint.
    pub(crate) async fn admit(
        &self,
        host: &impl Host,
        uri: &str,
        tile: u32,
    ) -> Result<Option<Ticket>, Error> {
        let mut now = self.checkpoint(host, Gate::Acquisition).await?;
        let Some(origin) = http_origin(uri) else {
            return Ok(None);
        };
        loop {
            let admission = self.with_origin(&origin, |state| state.admit(now, tile));
            match admission {
                Admission::Ready(generation) => {
                    return Ok(Some(Ticket {
                        origin,
                        generation,
                        tile,
                    }));
                }
                Admission::Wait(delay) => self.sleep(host, delay).await?,
                Admission::Blocked => self.changed(&origin, tile).await,
            }
            now = self.checkpoint(host, Gate::Acquisition).await?;
        }
    }

    /// Consume the attempt's ticket after acquisition succeeds; `None` skips feedback.
    pub(crate) async fn succeeded(
        &self,
        host: &impl Host,
        ticket: Option<Ticket>,
    ) -> Result<(), Error> {
        if let Some(ticket) = ticket {
            let now = self.checkpoint(host, Gate::Cancellation).await?;
            self.with_origin(&ticket.origin, |state| {
                state.succeeded(ticket.generation, ticket.tile, now);
            });
            self.wake(&ticket.origin);
        }
        Ok(())
    }

    /// Consume a failed attempt's ticket before retrying, preserving its error.
    /// `delay_ms` is the proposed retry wait; `true` means the origin gate owns
    /// that wait, while `false` leaves retry policy and sleeping to the caller.
    pub(crate) async fn failed(
        &self,
        host: &impl Host,
        ticket: Option<Ticket>,
        error: &Error,
        delay_ms: u64,
    ) -> Result<bool, Error> {
        let Some(ticket) = ticket else {
            return Ok(false);
        };
        let now = self.checkpoint(host, Gate::Cancellation).await?;
        let feedback = self.with_origin(&ticket.origin, |state| {
            state.failed(ticket.generation, ticket.tile, error, now, delay_ms)
        });
        self.wake(&ticket.origin);
        match feedback {
            Feedback::Ordinary => Ok(false),
            Feedback::Shared => Ok(true),
            Feedback::Backoff(delay) => {
                host.warn(format!(
                    "Backing off tile requests to {} for {delay} ms after {}",
                    ticket.origin,
                    error.cause()
                ));
                Ok(true)
            }
        }
    }

    /// Perform a cancellable Host wait and record its completion timing.
    pub(crate) async fn sleep(&self, host: &impl Host, delay_ms: u32) -> Result<(), Error> {
        self.observe(host.sleep(delay_ms).await?);
        Ok(())
    }

    /// Apply the Host gate and return the latest observed completion milliseconds.
    async fn checkpoint(&self, host: &impl Host, gate: Gate) -> Result<u64, Error> {
        Ok(self.observe(host.checkpoint(gate).await?))
    }

    /// Record completion timing without moving backward on out-of-order delivery.
    fn observe(&self, timing: HostTiming) -> u64 {
        let now = self.observed_ms.get().max(timing.time_ms);
        self.observed_ms.set(now);
        now
    }

    /// Update a normalized HTTP origin's controller, creating it on first use.
    fn with_origin<T>(&self, key: &str, action: impl FnOnce(&mut Controller) -> T) -> T {
        let mut origins = self.origins.borrow_mut();
        let origin = origins.entry(key.into()).or_insert_with(|| Origin {
            controller: Controller::new(self.pacing),
            waiters: Vec::new(),
        });
        action(&mut origin.controller)
    }

    /// Wait until an existing origin's recovery permits `tile`; recheck admission afterward.
    async fn changed(&self, key: &str, tile: u32) {
        poll_fn(|cx| {
            let mut origins = self.origins.borrow_mut();
            let origin = origins
                .get_mut(key)
                .expect("admission registered the origin");
            if !origin.controller.blocked(tile) {
                return Poll::Ready(());
            }
            if !origin
                .waiters
                .iter()
                .any(|waker| waker.will_wake(cx.waker()))
            {
                origin.waiters.push(cx.waker().clone());
            }
            Poll::Pending
        })
        .await;
    }

    /// Wake and remove all recovery waiters for this origin.
    fn wake(&self, key: &str) {
        let waiters = self
            .origins
            .borrow_mut()
            .get_mut(key)
            .map(|origin| std::mem::take(&mut origin.waiters))
            .unwrap_or_default();
        for waiter in waiters {
            waiter.wake()
        }
    }
}

/// Normalize an HTTP(S) origin; invalid URIs and other schemes return `None`.
fn http_origin(uri: &str) -> Option<String> {
    let url = url::Url::parse(uri).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}
