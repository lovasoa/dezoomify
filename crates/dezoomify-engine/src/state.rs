//! Portable job states.
//!
//! The canonical 13-phase vocabulary lives in `dezoomify-protocol`
//! ([`dezoomify_protocol::dto::JobState`]); this module only aliases it for
//! the inner machine. There is no engine-local lifecycle definition.
//!
//! The engine exposes only phases it can observe directly. Host-local codec
//! and save progress is not represented here.
//!
//! Pause is an orthogonal suspend-acquisition overlay
//! (`Job::is_paused`), not new states: `paused` stops scheduling new
//! `acquire-tile` effects, finishes in-flight work, retains decoded output,
//! and re-drives on resume. State names and terminal semantics are unchanged.

/// Portable engine phases (canonical protocol vocabulary).
pub use dezoomify_protocol::dto::JobState as State;
