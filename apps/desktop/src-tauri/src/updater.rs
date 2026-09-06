// Signed updater metadata validator (pure Rust; ed25519-dalek, no system
// libraries).
//
// Policy: HTTPS-only allowlisted endpoints, signed metadata required
// (strict ed25519 over the canonical dezoomify-updater-v1 message),
// anti-rollback (candidate must be newer than installed), stale timestamps
// rejected after 7 days, future timestamps rejected beyond +300s clock
// skew, and explicit user confirmation before staging anything. The app
// keeps working when metadata is missing, delayed, older, or newer than
// store versions. Unsigned packages are never staged or executed.
//
// Production endpoint and key status: the real update host and the
// production public key are still TBD. The allowlist keeps the placeholder
// `updates.dezoomify.example` HTTPS shape until the real host lands; the
// production public key follows the `release/gpg-public-key.asc` pattern
// (a new `release/updater-public-key.*` file, never a test key).
// TODO(task-3.4-updater-e2e, apps/desktop/src-tauri/src/updater.rs:20):
// replace the placeholder host and wire the production public key from
// release config once the real update host and key exist; keep this
// allowlist shape and the capability `updater.allowlist` entries in sync.

use ed25519_dalek::{Signature, VerifyingKey, PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH};

/// HTTPS endpoint allowlist (hosts only).
pub const UPDATER_ALLOWLIST_HOSTS: &[&str] = &["updates.dezoomify.example"];
/// Update channel.
pub const UPDATER_CHANNEL: &str = "stable";
/// Maximum metadata age in seconds before it counts as stale (7 days).
pub const UPDATER_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
/// Future clock-skew tolerance in seconds (timestamps beyond now + skew).
pub const UPDATER_FUTURE_SKEW_SECS: u64 = 300;
/// Full allowlisted endpoint template mirrored into
/// `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.endpoints`)
/// and `release/config.toml` (`[updater]`). The host stays within
/// `UPDATER_ALLOWLIST_HOSTS`; HTTPS only.
pub const UPDATER_ENDPOINTS: &[&str] =
    &["https://updates.dezoomify.example/stable/{{target}}/{{arch}}/{{current_version}}"];
/// Production updater public key for `tauri-plugin-updater` (minisign form
/// carries the same ed25519 key that `validate_update` verifies as hex).
/// TBD: empty until the real key lands; empty never validates (fail
/// closed). Test keys live in `#[cfg(test)]` only, never here.
pub const UPDATER_PUBKEY: &str = "";

/// Candidate update metadata (parsed, non-secret fields only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateMetadata {
    pub version: String,
    pub url: String,
    pub signature: Option<String>,
    pub sha256: String,
    pub timestamp: u64,
}

/// The exact bytes an updater signature covers: canonical, newline-joined
/// metadata fields with a domain separator. The producer signs these bytes;
/// this validator reconstructs them from the parsed fields so a signature
/// cannot be moved between candidates.
pub fn signed_message(candidate: &UpdateMetadata) -> Vec<u8> {
    format!(
        "dezoomify-updater-v1\n{}\n{}\n{}\n{}\n",
        candidate.version, candidate.url, candidate.sha256, candidate.timestamp
    )
    .into_bytes()
}

fn decode_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (index, chunk) in value.as_bytes().chunks(2).enumerate() {
        // to_digit yields 0..=15 for validated hex, so the casts are exact.
        let high = (chunk[0] as char).to_digit(16)? as u8;
        let low = (chunk[1] as char).to_digit(16)? as u8;
        out[index] = (high << 4) | low;
    }
    Some(out)
}

/// Parse an embedded release public key from its hex encoding.
///
/// # Errors
///
/// A stable error string when the key is not exactly 64 hex chars.
pub fn parse_public_key(public_key_hex: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_hex::<PUBLIC_KEY_LENGTH>(public_key_hex)
        .ok_or_else(|| "updater.rejected: malformed public key".to_string())?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|e| format!("updater.rejected: malformed public key: {e}"))
}

/// Verify an ed25519 signature over the canonical metadata message.
/// Signatures are `sig:` followed by 128 hex chars.
fn verify_candidate_signature(
    public_key: &VerifyingKey,
    candidate: &UpdateMetadata,
) -> Result<(), String> {
    let Some(sig) = &candidate.signature else {
        return Err("updater.rejected: unsigned metadata".to_string());
    };
    let Some(raw) = sig.strip_prefix("sig:") else {
        return Err("updater.rejected: unsigned metadata".to_string());
    };
    let Some(sig_bytes) = decode_hex::<SIGNATURE_LENGTH>(raw) else {
        return Err("updater.rejected: unsigned metadata".to_string());
    };
    let signature = Signature::from_bytes(&sig_bytes);
    public_key
        .verify_strict(&signed_message(candidate), &signature)
        .map_err(|_| "updater.rejected: signature verification failed".to_string())
}

/// Validator outcome: `Ok(true)` means the candidate may be offered for
/// explicit user confirmation; `Ok(false)` means no update; `Err` rejects.
///
/// # Errors
///
/// Stable `updater.rejected: ...` strings for every rejected candidate.
pub fn validate_update(
    current_version: &str,
    candidate: &UpdateMetadata,
    now_secs: u64,
    public_key: &VerifyingKey,
) -> Result<bool, String> {
    // HTTPS allowlist.
    let host =
        url_host(&candidate.url).ok_or_else(|| "updater.rejected: invalid url".to_string())?;
    if !candidate.url.starts_with("https://") {
        return Err("updater.rejected: https required".to_string());
    }
    if !UPDATER_ALLOWLIST_HOSTS.contains(&host.as_str()) {
        return Err("updater.rejected: host not allowlisted".to_string());
    }
    // Signed metadata required: missing, malformed, or forged signatures
    // never stage. Verification is strict ed25519 over the canonical message.
    verify_candidate_signature(public_key, candidate)?;
    // Hash must look like 64 hex chars; authenticity is enforced by the
    // signature that covers this field.
    if candidate.sha256.len() != 64 || !candidate.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("updater.rejected: tampered hash".to_string());
    }
    // Stale timestamps never stage.
    if candidate.timestamp > now_secs.saturating_add(UPDATER_FUTURE_SKEW_SECS) {
        return Err("updater.rejected: timestamp in the future".to_string());
    }
    if now_secs.saturating_sub(candidate.timestamp) > UPDATER_MAX_AGE_SECS {
        return Err("updater.rejected: stale metadata".to_string());
    }
    // Anti-rollback: candidate must be strictly newer than installed.
    match compare_versions(&candidate.version, current_version) {
        Some(core::cmp::Ordering::Greater) => {}
        Some(_) => return Err("updater.rejected: rollback or same version".to_string()),
        None => return Err("updater.rejected: malformed version".to_string()),
    }
    // Valid candidates still need explicit user confirmation; the validator
    // never auto-stages. Callers check this `true` as "offer for confirm".
    Ok(true)
}

fn url_host(url: &str) -> Option<String> {
    let after = url.split("://").nth(1)?;
    let host = after
        .split('/')
        .next()?
        .split(':')
        .next()?
        .split('?')
        .next()?
        .to_string();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

fn parse_version_triplet(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn compare_versions(a: &str, b: &str) -> Option<core::cmp::Ordering> {
    Some(parse_version_triplet(a)?.cmp(&parse_version_triplet(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn test_keypair() -> (SigningKey, VerifyingKey) {
        // Deterministic test key: production keys live in protected CI.
        let seed = [7u8; 32];
        let signing = SigningKey::from_bytes(&seed);
        let verifying = signing.verifying_key();
        (signing, verifying)
    }

    fn sign(signing: &SigningKey, candidate: &UpdateMetadata) -> String {
        use ed25519_dalek::Signer;
        format!(
            "sig:{}",
            signing
                .sign(&signed_message(candidate))
                .to_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    }

    fn valid() -> UpdateMetadata {
        UpdateMetadata {
            version: "0.2.0".to_string(),
            url: "https://updates.dezoomify.example/desktop/0.2.0/bundle".to_string(),
            signature: None,
            sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
            timestamp: 1_700_000_000,
        }
    }

    #[test]
    fn valid_signed_update_offered_for_confirm() {
        let (signing, verifying) = test_keypair();
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        assert_eq!(
            validate_update("0.1.0", &candidate, 1_700_000_100, &verifying),
            Ok(true)
        );
    }

    #[test]
    fn tampered_fields_fail_verification() {
        let (signing, verifying) = test_keypair();
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        // Any field change invalidates the signature (it covers all fields).
        candidate.version = "0.9.0".to_string();
        assert!(validate_update("0.1.0", &candidate, 1_700_000_100, &verifying).is_err());
        let mut hash_flipped = valid();
        hash_flipped.sha256 =
            "8f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string();
        assert!(validate_update("0.1.0", &hash_flipped, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn placeholder_garbled_and_missing_signatures_never_validate() {
        let (_, verifying) = test_keypair();
        let mut placeholder = valid();
        placeholder.signature = Some("sig:valid-placeholder".to_string());
        assert!(validate_update("0.1.0", &placeholder, 1_700_000_100, &verifying).is_err());
        let mut garbled = valid();
        garbled.signature = Some(
            "sig:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        );
        assert!(validate_update("0.1.0", &garbled, 1_700_000_100, &verifying).is_err());
        let mut missing = valid();
        missing.signature = None;
        assert!(validate_update("0.1.0", &missing, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn wrong_key_fails_verification() {
        let (signing, _) = test_keypair();
        let other_seed = [9u8; 32];
        let other = VerifyingKey::from(&SigningKey::from_bytes(&other_seed));
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        assert!(validate_update("0.1.0", &candidate, 1_700_000_100, &other).is_err());
    }

    #[test]
    fn unsigned_tampered_stale_rollback_rejected() {
        let (signing, verifying) = test_keypair();
        let mut unsigned = valid();
        unsigned.signature = Some(sign(&signing, &unsigned));
        unsigned.signature = None;
        assert!(validate_update("0.1.0", &unsigned, 1_700_000_100, &verifying).is_err());
        let mut tampered = valid();
        tampered.signature = Some(sign(&signing, &tampered));
        tampered.sha256 = "00".to_string();
        assert!(validate_update("0.1.0", &tampered, 1_700_000_100, &verifying).is_err());
        let mut stale = valid();
        stale.signature = Some(sign(&signing, &stale));
        stale.timestamp = 1_600_000_000;
        assert!(validate_update("0.1.0", &stale, 1_700_000_100, &verifying).is_err());
        let rollback = valid();
        assert!(validate_update("0.2.0", &rollback, 1_700_000_100, &verifying).is_err());
        assert!(validate_update("0.3.0", &rollback, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn non_https_or_foreign_host_rejected() {
        let (signing, verifying) = test_keypair();
        let mut plain = valid();
        plain.signature = Some(sign(&signing, &plain));
        let mut http = plain.clone();
        http.url = "http://updates.dezoomify.example/desktop/0.2.0/bundle".to_string();
        // Signature covers the url, so this is also a verification failure;
        // policy rejects the scheme before crypto.
        assert!(validate_update("0.1.0", &http, 1_700_000_100, &verifying).is_err());
        let mut foreign = valid();
        foreign.url = "https://evil.example/desktop/0.2.0/bundle".to_string();
        foreign.signature = Some(sign(&signing, &foreign));
        assert!(validate_update("0.1.0", &foreign, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn http_scheme_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut http = valid();
        http.url = "http://updates.dezoomify.example/desktop/0.2.0/bundle".to_string();
        http.signature = Some(sign(&signing, &http));
        let err = validate_update("0.1.0", &http, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("https required"), "unexpected error: {err}");
    }

    #[test]
    fn malformed_hash_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut bad_hash = valid();
        bad_hash.sha256 = "00".to_string();
        bad_hash.signature = Some(sign(&signing, &bad_hash));
        let err = validate_update("0.1.0", &bad_hash, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("tampered hash"), "unexpected error: {err}");
    }

    #[test]
    fn stale_metadata_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let now = 1_700_000_100u64;
        let mut stale = valid();
        stale.timestamp = now - UPDATER_MAX_AGE_SECS - 1;
        stale.signature = Some(sign(&signing, &stale));
        let err = validate_update("0.1.0", &stale, now, &verifying).unwrap_err();
        assert!(err.contains("stale metadata"), "unexpected error: {err}");
    }

    #[test]
    fn future_timestamp_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let now = 1_700_000_100u64;
        let mut future = valid();
        future.timestamp = now + UPDATER_FUTURE_SKEW_SECS + 1;
        future.signature = Some(sign(&signing, &future));
        let err = validate_update("0.1.0", &future, now, &verifying).unwrap_err();
        assert!(err.contains("in the future"), "unexpected error: {err}");
    }

    #[test]
    fn stale_and_future_boundaries_hold() {
        let (signing, verifying) = test_keypair();
        let now = 1_700_000_100u64;
        // Exactly at the bounds still validates (rejection is strictly beyond).
        let mut fresh_edge = valid();
        fresh_edge.timestamp = now - UPDATER_MAX_AGE_SECS;
        fresh_edge.signature = Some(sign(&signing, &fresh_edge));
        assert_eq!(
            validate_update("0.1.0", &fresh_edge, now, &verifying),
            Ok(true)
        );
        let mut skew_edge = valid();
        skew_edge.timestamp = now + UPDATER_FUTURE_SKEW_SECS;
        skew_edge.signature = Some(sign(&signing, &skew_edge));
        assert_eq!(
            validate_update("0.1.0", &skew_edge, now, &verifying),
            Ok(true)
        );
    }

    #[test]
    fn rollback_and_same_version_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut rollback = valid();
        rollback.version = "0.0.9".to_string();
        rollback.signature = Some(sign(&signing, &rollback));
        let err = validate_update("0.1.0", &rollback, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("rollback"), "unexpected error: {err}");
        let mut same = valid();
        same.version = "0.1.0".to_string();
        same.signature = Some(sign(&signing, &same));
        let err = validate_update("0.1.0", &same, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("rollback"), "unexpected error: {err}");
    }

    #[test]
    fn malformed_version_and_url_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut bad_version = valid();
        bad_version.version = "not-a-version".to_string();
        bad_version.signature = Some(sign(&signing, &bad_version));
        let err = validate_update("0.1.0", &bad_version, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("malformed version"), "unexpected error: {err}");
        let mut bad_url = valid();
        bad_url.url = "not a url".to_string();
        bad_url.signature = Some(sign(&signing, &bad_url));
        assert!(validate_update("0.1.0", &bad_url, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn malformed_public_key_never_validates() {
        assert!(parse_public_key("").is_err());
        assert!(parse_public_key("zzzz").is_err());
        assert!(parse_public_key(UPDATER_PUBKEY).is_err());
    }

    #[test]
    fn production_pubkey_placeholder_never_validates() {
        // The TBD placeholder must stay fail-closed until the real key lands.
        assert_eq!(UPDATER_PUBKEY, "");
    }

    #[test]
    fn missing_delayed_older_metadata_never_stages_app_keeps_working() {
        let (signing, verifying) = test_keypair();
        // Missing signature: no staging, caller sees Err and continues.
        let missing = valid();
        assert!(validate_update("0.1.0", &missing, 1_700_000_100, &verifying).is_err());
        // Delayed (stale) metadata: no staging, app keeps running.
        let mut delayed = valid();
        delayed.timestamp = 1_600_000_000;
        delayed.signature = Some(sign(&signing, &delayed));
        assert!(validate_update("0.1.0", &delayed, 1_700_000_100, &verifying).is_err());
        // Older candidate than installed: no staging, app keeps running.
        let mut older = valid();
        older.version = "0.0.1".to_string();
        older.signature = Some(sign(&signing, &older));
        assert!(validate_update("0.1.0", &older, 1_700_000_100, &verifying).is_err());
        // Newer-but-unsigned candidate: still never stages.
        let mut newer_unsigned = valid();
        newer_unsigned.version = "9.9.9".to_string();
        newer_unsigned.signature = None;
        assert!(validate_update("0.1.0", &newer_unsigned, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn endpoints_stay_within_allowlist_https_shape() {
        assert!(!UPDATER_ENDPOINTS.is_empty());
        assert_eq!(UPDATER_CHANNEL, "stable");
        for endpoint in UPDATER_ENDPOINTS {
            assert!(
                endpoint.starts_with("https://"),
                "endpoint must be https: {endpoint}"
            );
            let host = url_host(endpoint).expect("endpoint must parse");
            assert!(
                UPDATER_ALLOWLIST_HOSTS.contains(&host.as_str()),
                "endpoint host not allowlisted: {host}"
            );
        }
    }
}
