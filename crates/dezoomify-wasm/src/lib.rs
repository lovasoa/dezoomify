//! Narrow deterministic adapter from portable core/job/protocol types to
//! JavaScript (`crates/dezoomify-wasm`, phase 07).
//!
//! This crate is adapter-only: it performs no network or filesystem I/O,
//! decodes no images, touches no DOM/canvas/storage/workers/timers, encodes
//! no output, and depends only on `dezoomify-core`, `dezoomify-protocol`,
//! `serde`, `serde_json`, and `wasm-bindgen`. It must stay free of `web-sys`
//! (Window/Document/fetch/Canvas/storage/worker features), `reqwest`,
//! `tokio`, and image codecs; the future browser runtime owns all host
//! effects, and the host supplies every byte the adapter reads.
//!
//! ## Required JavaScript surface
//!
//! | JS export      | Rust entrypoint                                              |
//! |---             |---                                                           |
//! | protocolVersion | [`protocol_version`]                                        |
//! | Session        | [`session::Session`] constructor (`Session::new`)            |
//! | dispatch       | [`session::Session::dispatch`] (canonical control bytes)     |
//! | drain          | [`session::Session::drain_messages`] (FIFO, exactly once)    |
//! | buffers        | `allocate_buffer` / `write_buffer` / `commit_buffer` /      |
//! |                | `take_buffer` / `free_buffer` / `protocol_handle` on Session |
//! | process        | [`session::Session::process_crop`] (`composite-crop` only)   |
//! | dispose        | [`session::Session::dispose`] (repeat-safe)                   |
//!
//! ## Ownership, reentrancy, disposal
//!
//! * Session: one Rust [`session::Session`] owns exactly one job, one byte
//!   arena, and one message queue. It is never cloned and cannot be used
//!   after [`dispose`][session::Session::dispose] except for draining.
//! * Input control bytes: borrowed for the call only; the adapter copies
//!   what it needs before returning.
//! * Input binary buffers: host bytes live in the arena; `commit` seals them
//!   immutable, `take` moves them exactly once. The host must not mutate a
//!   committed view.
//! * Output messages: canonical bytes owned by the host after `drain`; a
//!   successful drain removes them, so each message is delivered once.
//! * Output buffers: adapter-produced pixels move out via `take_buffer` with
//!   explicit `free_buffer` release; nothing is silently base64-encoded.
//! * Typed-array views: any call may grow WASM memory and invalidate views
//!   obtained earlier; hosts must re-acquire views after each call and must
//!   finish writing before `commit`.
//! * Reentrancy: the adapter never calls back into the host while a Rust
//!   borrow is active. Hosts poll with `drain` after `dispatch` returns;
//!   nested or concurrent calls into one session are not supported.
//! * Disposal: `dispose` cancels the job, releases buffers, marks the
//!   session unusable (`disposed` on later dispatch/buffer/process calls),
//!   and stays safe to repeat. A handwritten JS wrapper may add a finalizer
//!   only as a leak fallback, never as semantic cancellation.
//! * Errors: every failure is a stable [`AdapterError`] code convertible to
//!   a protocol `ErrorDto`; panics never cross the boundary (the crate
//!   forbids `unsafe_code` and checks every index and length).
//!
//! ## Deviations recorded by this phase
//!
//! * The crate resolves standalone (`[workspace]` in its `Cargo.toml`)
//!   because the root workspace `members` list is frozen for this task; run
//!   `cargo test --manifest-path crates/dezoomify-wasm/Cargo.toml` (or
//!   `cargo test -p dezoomify-wasm` from inside `crates/dezoomify-wasm`).
//!   Add the crate to the root `members` and drop `[workspace]` when allowed.
//! * `dezoomify-job` now exists (`crates/dezoomify-job`), but [`session`]
//!   still embeds its temporary minimal state machine instead of delegating.
//!   Delegation is future work; the transcript shape is pinned by
//!   `tests/adapter.rs` until then.
//! * Real `wasm-pack` Node/browser tests need pinned `wasm-pack` plus
//!   browsers, neither installed here; `packages/wasm-harness` records that
//!   exception and runs native conformance instead.

#![forbid(unsafe_code)]

pub mod buffer;
pub mod codec;
pub mod error;
pub mod processing;
pub mod session;

pub use buffer::{ArenaHandle, ByteArena, MAX_BUFFERS, MAX_BUFFER_BYTES, MAX_TOTAL_BYTES};
pub use dezoomify_protocol::dto::{PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION};
pub use error::{redact, AdapterError, AdapterErrorCode};
pub use processing::{composite_crop, fnv1a64_hex, CropGeometry, PIXEL_BYTES};
pub use session::{
    Session, SessionState, DEFAULT_MAX_BUFFERS, DEFAULT_MAX_BUFFER_BYTES, DEFAULT_MAX_MESSAGES,
    DEFAULT_MAX_TOTAL_BYTES, FIXED_EFFECT_ID, FIXED_OUTPUT_ID, FIXED_REQUEST_ID, HARD_MAX_BUFFERS,
    HARD_MAX_BUFFER_BYTES, HARD_MAX_MESSAGES, HARD_MAX_TOTAL_BYTES, PROCESSING_OPERATION,
};

/// Protocol major/minor in lossless stable form (`"1.0"`), without creating
/// a job. This is the `protocolVersion` export.
#[must_use]
pub fn protocol_version() -> &'static str {
    PROTOCOL_VERSION
}

/// JavaScript (`wasm32`) bindings. Native targets and tests use the plain
/// Rust API above, which exercises the same logic without a browser.
#[cfg(target_arch = "wasm32")]
pub mod wasm_api {
    use super::{buffer::ArenaHandle, session::Session, CropGeometry};
    use wasm_bindgen::prelude::*;

    fn js_error(error: super::AdapterError) -> JsValue {
        JsValue::from_str(&error.to_string())
    }

    /// Map a non-adapter failure (e.g. handle JSON parsing) to a redacted
    /// `malformed` JS error.
    fn js_malformed(detail: impl std::fmt::Display) -> JsValue {
        js_error(super::AdapterError::new(
            super::AdapterErrorCode::Malformed,
            detail.to_string(),
        ))
    }

    /// The `protocolVersion` export.
    #[wasm_bindgen(js_name = "protocolVersion")]
    pub fn js_protocol_version() -> String {
        super::protocol_version().to_string()
    }

    /// The `Session` export: owns one job, one arena, one message queue.
    #[wasm_bindgen(js_name = "Session")]
    pub struct JsSession {
        inner: Session,
    }

    #[wasm_bindgen(js_class = "Session")]
    impl JsSession {
        /// Validate version/config; own exactly one job/session.
        #[wasm_bindgen(constructor)]
        pub fn new(protocol_version: &str, config_json: &str) -> Result<JsSession, JsValue> {
            Session::new(protocol_version, config_json)
                .map(|inner| JsSession { inner })
                .map_err(js_error)
        }

        /// Decode one protocol command/response, run the transition
        /// synchronously, and return status only (`dispatch`).
        #[wasm_bindgen(js_name = "dispatch")]
        pub fn dispatch(&mut self, control: &[u8]) -> Result<(), JsValue> {
            self.inner.dispatch(control).map_err(js_error)
        }

        /// Return queued canonical messages as a JSON array string, FIFO,
        /// exactly once (`drain`).
        #[wasm_bindgen(js_name = "drainMessages")]
        pub fn drain_messages(&mut self) -> Result<String, JsValue> {
            let messages = self.inner.drain_messages();
            super::codec::messages_to_json_array(&messages).map_err(js_error)
        }

        /// Reserve `length` bytes for host-supplied data (`buffers`).
        /// Returns the handle as JSON (`{"id":..,"generation":..}`).
        #[wasm_bindgen(js_name = "allocateBuffer")]
        pub fn allocate_buffer(&mut self, length: u32) -> Result<String, JsValue> {
            let handle = self
                .inner
                .allocate_buffer(u64::from(length))
                .map_err(js_error)?;
            serde_json::to_string(&handle).map_err(js_malformed)
        }

        /// Copy host bytes into an uncommitted allocation (`buffers`).
        #[wasm_bindgen(js_name = "writeBuffer")]
        pub fn write_buffer(
            &mut self,
            handle_json: &str,
            offset: u32,
            data: &[u8],
        ) -> Result<(), JsValue> {
            let handle: ArenaHandle = serde_json::from_str(handle_json).map_err(js_malformed)?;
            self.inner
                .write_buffer(handle, u64::from(offset), data)
                .map_err(js_error)
        }

        /// Seal one buffer for a subsequent correlated command (`buffers`).
        #[wasm_bindgen(js_name = "commitBuffer")]
        pub fn commit_buffer(&mut self, handle_json: &str, actual: u32) -> Result<(), JsValue> {
            let handle: ArenaHandle = serde_json::from_str(handle_json).map_err(js_malformed)?;
            self.inner
                .commit_buffer(handle, u64::from(actual))
                .map_err(js_error)
        }

        /// Move adapter-held bytes out exactly once (`buffers`).
        #[wasm_bindgen(js_name = "takeBuffer")]
        pub fn take_buffer(&mut self, handle_json: &str) -> Result<Vec<u8>, JsValue> {
            let handle: ArenaHandle = serde_json::from_str(handle_json).map_err(js_malformed)?;
            self.inner.take_buffer(handle).map_err(js_error)
        }

        /// Release a buffer handle; idempotent (`buffers`).
        #[wasm_bindgen(js_name = "freeBuffer")]
        pub fn free_buffer(&mut self, handle_json: &str) -> Result<(), JsValue> {
            let handle: ArenaHandle = serde_json::from_str(handle_json).map_err(js_malformed)?;
            self.inner.free_buffer(handle).map_err(js_error)
        }

        /// Execute one bounded pure pixel operation on supplied buffers
        /// (`process`). Only `composite-crop` exists in adapter v1; returns
        /// the output digest. `geometry_json` is `{"x":..,"y":..,"w":..,"h":..}`.
        #[allow(clippy::too_many_arguments)]
        #[wasm_bindgen(js_name = "process")]
        pub fn process(
            &mut self,
            operation: &str,
            input_json: &str,
            output_json: &str,
            geometry_json: &str,
            src_width: u32,
            src_height: u32,
        ) -> Result<String, JsValue> {
            let input: ArenaHandle = serde_json::from_str(input_json).map_err(js_malformed)?;
            let output: ArenaHandle = serde_json::from_str(output_json).map_err(js_malformed)?;
            let geometry: CropGeometry =
                CropGeometry::from_json(geometry_json).map_err(js_error)?;
            self.inner
                .process_crop(operation, input, output, src_width, src_height, &geometry)
                .map_err(js_error)
        }

        /// Cancel/release session resources; repeat-safe (`dispose`).
        #[wasm_bindgen(js_name = "dispose")]
        pub fn dispose(&mut self) -> Result<(), JsValue> {
            self.inner.dispose().map_err(js_error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_export_needs_no_session() {
        assert_eq!(protocol_version(), "1.0");
        assert_eq!(protocol_version(), PROTOCOL_VERSION);
        assert_eq!((PROTOCOL_MAJOR, PROTOCOL_MINOR), (1, 0));
    }
}
