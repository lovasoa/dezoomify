//! Per-origin admission and feedback, independent of transports and retry loops.
mod controller;

use crate::{
    Host,
    model::{Error, Gate},
};
use controller::{Admission, Controller, Feedback};
use futures_util::future::poll_fn;
use std::{
    cell::RefCell,
    collections::HashMap,
    task::{Poll, Waker},
};

struct Origin {
    controller: Controller,
    waiters: Vec<Waker>,
}

/// One attempt's admission generation. Late completions cannot reopen a cooldown.
pub(crate) struct Ticket {
    origin: String,
    generation: u64,
    tile: u32,
}

pub(crate) struct Scheduler {
    origins: RefCell<HashMap<String, Origin>>,
    initial_interval_ms: u32,
}

impl Scheduler {
    pub(crate) fn new(initial_interval_ms: u32) -> Self {
        Self {
            origins: RefCell::default(),
            initial_interval_ms,
        }
    }

    pub(crate) async fn admit(
        &self,
        host: &impl Host,
        uri: &str,
        tile: u32,
    ) -> Result<Option<Ticket>, Error> {
        let Some(origin) = http_origin(uri) else {
            return Ok(None);
        };
        loop {
            host.checkpoint(Gate::Acquisition).await?;
            let now = host.now_ms().await?;
            let admission = self.with_origin(&origin, |state| state.admit(now, tile));
            match admission {
                Admission::Ready(generation) => {
                    return Ok(Some(Ticket {
                        origin,
                        generation,
                        tile,
                    }));
                }
                Admission::Wait(delay) => host.sleep(delay).await?,
                Admission::Blocked => self.changed(&origin, tile).await,
            }
        }
    }

    pub(crate) async fn succeeded(
        &self,
        host: &impl Host,
        ticket: Option<Ticket>,
    ) -> Result<(), Error> {
        if let Some(ticket) = ticket {
            let now = host.now_ms().await?;
            self.with_origin(&ticket.origin, |state| {
                state.succeeded(ticket.generation, ticket.tile, now);
            });
            self.wake(&ticket.origin);
        }
        Ok(())
    }

    /// Returns whether this failure uses the shared recovery gate. The error
    /// itself is preserved, including ambiguous HTTP 403 responses.
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
        let now = host.now_ms().await?;
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

    fn with_origin<T>(&self, key: &str, action: impl FnOnce(&mut Controller) -> T) -> T {
        let mut origins = self.origins.borrow_mut();
        let origin = origins.entry(key.into()).or_insert_with(|| Origin {
            controller: Controller::new(self.initial_interval_ms),
            waiters: Vec::new(),
        });
        action(&mut origin.controller)
    }

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

fn http_origin(uri: &str) -> Option<String> {
    let url = url::Url::parse(uri).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}
