//! Narrow deterministic adapter from the portable Dezoomify domain to
//! JavaScript (`crates/dezoomify-wasm`).
//!
//! This crate is adapter-only: it performs no network or filesystem I/O,
//! decodes no images, touches no DOM/canvas/storage/workers/timers, encodes
//! no output, and depends only on the pure `dezoomify` crate,
//! `serde`, `tsify`, `serde-wasm-bindgen`, and `wasm-bindgen`. It stays free of `web-sys`
//! (Window/Document/fetch/Canvas/storage/worker features), `reqwest`,
//! `tokio`, and image codecs; the future browser runtime owns all host
//! effects, and the host supplies every byte the adapter reads.
//!
//! ## Required JavaScript surface
//!
//! | JS export      | Rust entrypoint                                              |
//! |---             |---                                                           |
//! | Session        | [`session::Session`] constructor (`Session::new`)            |
//! | dispatch       | [`session::Session::dispatch`] (typed command/result)        |
//! | applyProcessing | [`session::Session::apply_processing`] (pure recipe op)     |
//! | snapshot       | [`session::Session::snapshot`] (canonical engine snapshot)   |
//! | dispose        | [`session::Session::dispose`] (repeat-safe)                   |
//!
//! ## Ownership, reentrancy, disposal
//!
//! * Session: one Rust [`session::Session`] owns exactly one job. It is
//!   never cloned and cannot be used after
//!   [`dispose`][session::Session::dispose].
//! * Commands, messages, and configuration cross as generated JavaScript
//!   objects with fallible Rust deserialization. Discovery bodies cross
//!   directly in `provide-resource` commands (`bytes: number[]`); tile
//!   success is body-free (`provide-display-outcome`); nothing is retained
//!   adapter-side and nothing is silently base64-encoded.
//! * Output messages are returned directly by each state transition.
//! * Reentrancy: the adapter never calls back into the host while a Rust
//!   borrow is active. Nested or concurrent calls into one session are not
//!   supported.
//! * Disposal: `dispose` cancels the job, marks the session unusable
//!   (`disposed` on later dispatch/process calls), and stays safe to
//!   repeat. A JS finalizer is only a leak fallback, never semantic
//!   cancellation.
//! * Errors: every failure is a stable [`AdapterError`] code convertible to
//!   a protocol `Error`; panics never cross the boundary (the crate
//!   forbids `unsafe_code` and checks every index and length).
//!
//! ## Adapter scope
//!
//! * [`session`] delegates its whole lifecycle to `dezoomify::engine`; host
//!   effects and snapshots already use the canonical model unchanged.
//!   Discovery and planning are format-aware through `dezoomify`:
//!   metadata bytes parse into real catalogs and real per-level tile plans.
//! * Node conformance runs against the generated bindings:
//!   `packages/wasm-harness` drives the emitted JavaScript surface.

#![forbid(unsafe_code)]
// Shipped adapter code maps failures to typed `AdapterError`s instead of
// panicking (see the pure crate's model policy for how
// tests stay exempt).
#![deny(clippy::unwrap_used)]

pub mod discovery;
pub mod error;
pub mod session;

pub use error::{redact, AdapterError, AdapterErrorCode};
pub use session::Session;

/// JavaScript (`wasm32`) bindings. Native targets and tests use the plain
/// Rust API above, which exercises the same logic without a browser.
#[cfg(target_arch = "wasm32")]
pub mod wasm_api {
    use super::session::Session;
    use dezoomify::model::{
        Error, HostCompletion, HostEffect, JobCommand, ProcessingRequest, SessionConfig, Snapshot,
    };
    use serde::Serialize;
    use tsify::{Ts, Tsify};
    use wasm_bindgen::prelude::*;

    #[derive(Serialize, Tsify)]
    #[serde(tag = "status", rename_all = "kebab-case")]
    pub enum DispatchResult {
        Ok {
            messages: Vec<HostEffect>,
            snapshot: Snapshot,
        },
        Error {
            error: Error,
        },
    }

    fn result(value: Result<(Vec<HostEffect>, Snapshot), super::AdapterError>) -> DispatchResult {
        match value {
            Ok((messages, snapshot)) => DispatchResult::Ok { messages, snapshot },
            Err(error) => DispatchResult::Error {
                error: error.to_error(),
            },
        }
    }

    fn conversion_error(error: impl std::fmt::Display) -> JsError {
        JsError::new(&format!("typed ABI conversion failed: {error}"))
    }

    /// The `Session` export: owns one job.
    #[wasm_bindgen(js_name = "Session")]
    pub struct JsSession {
        inner: Session,
    }

    #[wasm_bindgen(js_class = "Session")]
    impl JsSession {
        /// Validate typed configuration and own exactly one job session.
        #[wasm_bindgen(constructor)]
        pub fn new(config: Ts<SessionConfig>) -> Result<JsSession, JsError> {
            let config = config.to_rust().map_err(conversion_error)?;
            Session::new(config)
                .map(|inner| JsSession { inner })
                .map_err(|error| JsError::new(&error.to_string()))
        }

        /// Run one typed user command and return its ordered host effects
        /// plus the canonical snapshot after the answer. User commands
        /// never carry bytes or claim publication.
        #[wasm_bindgen(js_name = "command")]
        pub fn command(&mut self, command: Ts<JobCommand>) -> Result<Ts<DispatchResult>, JsError> {
            let command = command.to_rust().map_err(conversion_error)?;
            result(self.inner.command(command))
                .into_ts()
                .map_err(conversion_error)
        }

        /// Answer one outstanding host effect and return its ordered host
        /// effects plus the canonical snapshot after the answer. Only
        /// completions carry bytes, failures, observations, and
        /// publication claims.
        #[wasm_bindgen(js_name = "complete")]
        pub fn complete(
            &mut self,
            completion: Ts<HostCompletion>,
        ) -> Result<Ts<DispatchResult>, JsError> {
            let completion = completion.to_rust().map_err(conversion_error)?;
            result(self.inner.complete(completion))
                .into_ts()
                .map_err(conversion_error)
        }

        /// Apply one core processing recipe to tile bytes (pure: no job
        /// state, same recipes as the discovery adapter).
        #[wasm_bindgen(js_name = "applyProcessing")]
        pub fn apply_processing(
            &self,
            request: Ts<ProcessingRequest>,
            bytes: &[u8],
        ) -> Result<Vec<u8>, JsError> {
            let request = request.to_rust().map_err(conversion_error)?;
            self.inner
                .apply_processing(request.recipe, bytes.to_vec())
                .map_err(|error| JsError::new(&error.to_string()))
        }

        /// Project the canonical engine snapshot for the active job.
        /// Absolute state for UI rendering; issues no work.
        #[wasm_bindgen(js_name = "snapshot")]
        pub fn snapshot(&self) -> Result<Ts<Snapshot>, JsError> {
            self.inner
                .snapshot()
                .map_err(|error| JsError::new(&error.to_string()))?
                .into_ts()
                .map_err(conversion_error)
        }

        /// Cancel/release session resources; repeat-safe (`dispose`).
        #[wasm_bindgen(js_name = "dispose")]
        pub fn dispose(&mut self) -> Result<Ts<DispatchResult>, JsError> {
            result(self.inner.dispose())
                .into_ts()
                .map_err(conversion_error)
        }
    }
}
