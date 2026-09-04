//! Canonical control-message conversion at the adapter boundary.
//!
//! The adapter accepts and emits exactly one representation: canonical
//! protocol v1 envelopes (UTF-8 JSON with sorted keys and a trailing LF, as
//! produced by [`dezoomify_protocol::codec`]). [`decode_envelope`] additionally
//! enforces the protocol version before any job transition runs, mapping
//! version failures to `version-unsupported` and every other decode failure
//! to `malformed` (without echoing raw bytes, which may carry secrets).
//! [`messages_to_json_array`] renders drained canonical messages as one JSON
//! array for transcript comparison.

use crate::error::{redact, AdapterError, AdapterErrorCode};
use dezoomify_protocol::codec;
use dezoomify_protocol::dto::ControlEnvelope;

/// Encode one envelope to canonical bytes.
///
/// # Errors
///
/// `malformed` when serialization fails (unreachable for constructed DTOs).
pub fn encode_envelope(envelope: &ControlEnvelope) -> Result<Vec<u8>, AdapterError> {
    codec::encode(envelope).map_err(|detail| {
        AdapterError::new(
            AdapterErrorCode::Malformed,
            format!("cannot encode control message: {}", redact(&detail)),
        )
    })
}

/// Decode and version-check one envelope. Rejects trailing garbage.
///
/// # Errors
///
/// `malformed` for undecodable input, `version-unsupported` for a wrong
/// `protocol` marker.
pub fn decode_envelope(bytes: &[u8]) -> Result<ControlEnvelope, AdapterError> {
    let envelope: ControlEnvelope = codec::decode(bytes).map_err(|detail| {
        AdapterError::new(
            AdapterErrorCode::Malformed,
            format!("malformed control message: {}", redact(&detail)),
        )
    })?;
    codec::check_envelope_version(&envelope).map_err(|detail| {
        AdapterError::new(AdapterErrorCode::VersionUnsupported, redact(&detail))
    })?;
    Ok(envelope)
}

/// Render drained canonical messages as one JSON array of decoded envelopes.
///
/// Used for transcript comparison (see `testdata/scenarios/wasm/...`).
///
/// # Errors
///
/// `malformed` when a message no longer decodes (unreachable for messages
/// this adapter enqueued itself).
pub fn messages_to_json_array(messages: &[Vec<u8>]) -> Result<String, AdapterError> {
    let mut values = Vec::with_capacity(messages.len());
    for bytes in messages {
        let text = std::str::from_utf8(bytes).map_err(|_| {
            AdapterError::new(AdapterErrorCode::Malformed, "drained message is not UTF-8")
        })?;
        let value: serde_json::Value = serde_json::from_str(text.trim()).map_err(|detail| {
            AdapterError::new(
                AdapterErrorCode::Malformed,
                format!(
                    "drained message is not JSON: {}",
                    redact(&detail.to_string())
                ),
            )
        })?;
        values.push(value);
    }
    serde_json::to_string_pretty(&values).map_err(|detail| {
        AdapterError::new(
            AdapterErrorCode::Malformed,
            format!("cannot render transcript: {detail}"),
        )
    })
}
