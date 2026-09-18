//! Narrow deterministic adapter from portable core/job/protocol types to
//! JavaScript (`crates/dezoomify-wasm`).
//!
//! This crate is adapter-only: it performs no network or filesystem I/O,
//! decodes no images, touches no DOM/canvas/storage/workers/timers, encodes
//! no output, and depends only on `dezoomify-core`, `dezoomify-protocol`,
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
//! | buffers        | `allocate_buffer` / `write_buffer` / `commit_buffer` /      |
//! |                | `take_buffer` / `free_buffer` / `buffer_handle` on Session   |
//! | applyProcessing | [`session::Session::apply_processing`] (pure recipe op)     |
//! | dispose        | [`session::Session::dispose`] (repeat-safe)                   |
//!
//! ## Ownership, reentrancy, disposal
//!
//! * Session: one Rust [`session::Session`] owns exactly one job, one byte
//!   arena. It is never cloned and cannot be used after
//!   [`dispose`][session::Session::dispose].
//! * Commands, messages, configuration, and handles cross as generated
//!   JavaScript objects with fallible Rust deserialization.
//! * Input binary buffers: host bytes live in the arena; `commit` seals them
//!   immutable, `take` moves them exactly once. The host must not mutate a
//!   committed view.
//! * Output messages are returned directly by each state transition.
//! * Output buffers: adapter-produced pixels move out via `take_buffer` with
//!   explicit `free_buffer` release; nothing is silently base64-encoded.
//! * Typed-array views: any call may grow WASM memory and invalidate views
//!   obtained earlier; hosts must re-acquire views after each call and must
//!   finish writing before `commit`.
//! * Reentrancy: the adapter never calls back into the host while a Rust
//!   borrow is active. Nested or concurrent calls into one session are not
//!   supported.
//! * Disposal: `dispose` cancels the job, releases buffers, marks the
//!   session unusable (`disposed` on later dispatch/buffer/process calls),
//!   and stays safe to repeat. A JS finalizer is only a leak fallback, never
//!   semantic cancellation.
//! * Errors: every failure is a stable [`AdapterError`] code convertible to
//!   a protocol `ErrorDto`; panics never cross the boundary (the crate
//!   forbids `unsafe_code` and checks every index and length).
//!
//! ## Adapter scope
//!
//! * [`session`] delegates its whole lifecycle to `dezoomify-job`; the
//!   adapter projects engine effects/events onto typed protocol messages.
//!   Discovery and planning are format-aware through `dezoomify-core`:
//!   metadata bytes parse into real catalogs and real per-level tile plans.
//! * Node conformance runs against the generated bindings:
//!   `packages/wasm-harness` drives the emitted JavaScript surface.

#![forbid(unsafe_code)]
// Shipped adapter code maps failures to typed `AdapterError`s instead of
// panicking (see the crate-root comment in `dezoomify-protocol` for how
// tests stay exempt).
#![deny(clippy::unwrap_used)]

pub mod buffer;
pub mod discovery;
pub mod error;
pub mod session;

pub use buffer::{ArenaHandle, ByteArena, MAX_BUFFERS, MAX_BUFFER_BYTES, MAX_TOTAL_BYTES};
pub use error::{redact, AdapterError, AdapterErrorCode};
pub use session::{
    Session, SessionState, DEFAULT_MAX_BUFFERS, DEFAULT_MAX_BUFFER_BYTES, DEFAULT_MAX_TOTAL_BYTES,
    HARD_MAX_BUFFERS, HARD_MAX_BUFFER_BYTES, HARD_MAX_TOTAL_BYTES,
};

/// JavaScript (`wasm32`) bindings. Native targets and tests use the plain
/// Rust API above, which exercises the same logic without a browser.
#[cfg(target_arch = "wasm32")]
pub mod wasm_api {
    use super::{buffer::ArenaHandle, session::Session};
    use dezoomify_protocol::dto::{
        BufferHandle, EngineSnapshotDto, ErrorDto, HostMessage, JobCommand, ProcessingRequest,
        SessionConfig,
    };
    use serde::Serialize;
    use tsify::{Ts, Tsify};
    use wasm_bindgen::prelude::*;

    #[derive(Serialize, Tsify)]
    #[serde(tag = "status", rename_all = "kebab-case")]
    pub enum DispatchResult {
        Ok { messages: Vec<HostMessage> },
        Error { error: ErrorDto },
    }

    fn result(value: Result<Vec<HostMessage>, super::AdapterError>) -> DispatchResult {
        match value {
            Ok(messages) => DispatchResult::Ok { messages },
            Err(error) => DispatchResult::Error {
                error: error.to_error_dto(),
            },
        }
    }

    fn conversion_error(error: impl std::fmt::Display) -> JsError {
        JsError::new(&format!("typed ABI conversion failed: {error}"))
    }

    /// The `Session` export: owns one job and one byte arena.
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

        /// Run one typed command and return its ordered host messages.
        #[wasm_bindgen(js_name = "dispatch")]
        pub fn dispatch(&mut self, command: Ts<JobCommand>) -> Result<Ts<DispatchResult>, JsError> {
            let command = command.to_rust().map_err(conversion_error)?;
            result(self.inner.dispatch(command))
                .into_ts()
                .map_err(conversion_error)
        }

        /// Reserve `length` bytes for host-supplied data (`buffers`).
        #[wasm_bindgen(js_name = "allocateBuffer")]
        pub fn allocate_buffer(&mut self, length: u32) -> Result<Ts<ArenaHandle>, JsError> {
            let handle = self
                .inner
                .allocate_buffer(u64::from(length))
                .map_err(|error| JsError::new(&error.to_string()))?;
            handle.into_ts().map_err(conversion_error)
        }

        /// Copy host bytes into an uncommitted allocation (`buffers`).
        #[wasm_bindgen(js_name = "writeBuffer")]
        pub fn write_buffer(
            &mut self,
            handle: Ts<ArenaHandle>,
            offset: u32,
            data: &[u8],
        ) -> Result<(), JsError> {
            let handle = handle.to_rust().map_err(conversion_error)?;
            self.inner
                .write_buffer(handle, u64::from(offset), data)
                .map_err(|error| JsError::new(&error.to_string()))
        }

        /// Seal one buffer for a subsequent correlated command (`buffers`).
        #[wasm_bindgen(js_name = "commitBuffer")]
        pub fn commit_buffer(
            &mut self,
            handle: Ts<ArenaHandle>,
            actual: u32,
        ) -> Result<(), JsError> {
            let handle = handle.to_rust().map_err(conversion_error)?;
            self.inner
                .commit_buffer(handle, u64::from(actual))
                .map_err(|error| JsError::new(&error.to_string()))
        }

        /// Project an arena handle onto its canonical protocol reference
        /// (`buffers`): typed `provide-resource` commands carry a
        /// `BufferHandle`, distinct from the
        /// arena form `allocateBuffer` returns.
        #[wasm_bindgen(js_name = "bufferHandle")]
        pub fn buffer_handle_js(
            &mut self,
            handle: Ts<ArenaHandle>,
        ) -> Result<Ts<BufferHandle>, JsError> {
            let handle = handle.to_rust().map_err(conversion_error)?;
            let protocol = self
                .inner
                .buffer_handle(handle)
                .map_err(|error| JsError::new(&error.to_string()))?;
            protocol.into_ts().map_err(conversion_error)
        }

        /// Move adapter-held bytes out exactly once (`buffers`).
        #[wasm_bindgen(js_name = "takeBuffer")]
        pub fn take_buffer(&mut self, handle: Ts<ArenaHandle>) -> Result<Vec<u8>, JsError> {
            let handle = handle.to_rust().map_err(conversion_error)?;
            self.inner
                .take_buffer(handle)
                .map_err(|error| JsError::new(&error.to_string()))
        }

        /// Release a buffer handle; idempotent (`buffers`).
        #[wasm_bindgen(js_name = "freeBuffer")]
        pub fn free_buffer(&mut self, handle: Ts<ArenaHandle>) -> Result<(), JsError> {
            let handle = handle.to_rust().map_err(conversion_error)?;
            self.inner
                .free_buffer(handle)
                .map_err(|error| JsError::new(&error.to_string()))
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
        pub fn snapshot(&self) -> Result<Ts<EngineSnapshotDto>, JsError> {
            self.inner
                .snapshot()
                .map_err(|error| JsError::new(&error.to_string()))?
                .into_ts()
                .map_err(conversion_error)
        }

        /// Currently retained arena bytes (live allocations only). Hosts
        /// use it to observe quota pressure; ordinary tile
        /// acknowledgements retain zero bytes.
        #[wasm_bindgen(js_name = "retainedBytes")]
        pub fn retained_bytes(&self) -> u64 {
            self.inner.retained_bytes()
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
