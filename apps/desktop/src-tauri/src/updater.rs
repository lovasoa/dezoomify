// Signed updater metadata validator (pure Rust; ed25519-dalek, no system
// libraries). Decision (todo 5.8): automatic in-app updates are DISABLED
// for this free project. There is no update host and no updater key; users
// check GitHub Releases manually. The validator below is retained as a
// disabled, fail-closed policy layer so a future self-hosted updater would
// have to flip `UPDATER_ENABLED` plus ship a host, endpoints, and key
// together; until then every candidate is rejected with `updater.disabled`.
//
// Release integrity instead comes from free mechanisms only: GPG-detached
// `SHA256SUMS` plus per-artifact `.sig` files (public key at
// `release/gpg-public-key.asc`), verified by `cargo xtask release verify`
// and again at publish time. Desktop installers ship unsigned (no paid
// Apple/Azure signing); only the Linux `.deb` is buildable (see
// `release/targets.toml` and docs/releases.md).

use ed25519_dalek::{Signature, VerifyingKey, PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH};

/// Automatic updates are disabled: no update host is deployed and no
/// updater key exists. `false` means `validate_update` rejects every
/// candidate with `updater.disabled` before any crypto runs.
pub const UPDATER_ENABLED: bool = false;
/// HTTPS endpoint allowlist (hosts only). Empty while updates are disabled;
/// mirrors `tauri.conf.json` (`plugins.updater.endpoints`), `release/config.toml`
/// (`[updater]`), and the capability `updater.allowlist` entries (all empty/disabled).
pub const UPDATER_ALLOWLIST_HOSTS: &[&str] = &[];
/// Update channel name retained for the capability document shape only.
/// No endpoint serves this channel while `UPDATER_ENABLED` is false.
pub const UPDATER_CHANNEL: &str = "stable";
/// Maximum metadata age in seconds before it counts as stale (7 days).
pub const UPDATER_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
/// Future clock-skew tolerance in seconds (timestamps beyond now + skew).
pub const UPDATER_FUTURE_SKEW_SECS: u64 = 300;
/// Full endpoint templates. Empty while updates are disabled; mirrors
/// `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.endpoints`)
/// and `release/config.toml` (`[updater]`).
pub const UPDATER_ENDPOINTS: &[&str] = &[];
/// Updater public key for `tauri-plugin-updater`. Empty while updates are
/// disabled; empty never validates (fail closed). Test keys live in
/// `#[cfg(test)]` only, never here.
pub const UPDATER_PUBKEY: &str = "";

/// Stable message for the disabled updater path.
pub fn updater_disabled_message() -> &'static str {
    "updater.disabled: automatic updates are unavailable; check GitHub Releases for new versions"
}

/// Whether automatic update checks are enabled (always false, todo 5.8).
pub fn is_updater_enabled() -> bool {
    UPDATER_ENABLED
}

/// Fail-closed gate for the disabled updater.
pub fn check_updater_enabled() -> Result<(), String> {
    if UPDATER_ENABLED {
        Ok(())
    } else {
        Err(updater_disabled_message().to_string())
    }
}

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

/// Production entry point: always rejects with `updater.disabled` while
/// `UPDATER_ENABLED` is false (todo 5.8 decision: no auto-update host or
/// key; check GitHub Releases manually). The crypto policy below is
/// retained in `validate_candidate` for unit coverage so a future
/// self-hosted updater cannot ship an untested validator.
///
/// # Errors
///
/// `updater.disabled: ...` while updates are disabled.
pub fn validate_update(
    _current_version: &str,
    _candidate: &UpdateMetadata,
    _now_secs: u64,
    _public_key: &VerifyingKey,
) -> Result<bool, String> {
    check_updater_enabled()?;
    // Unreachable while disabled; kept so re-enabling must pass the
    // allowlist plus key wiring together, never one without the other.
    Err(updater_disabled_message().to_string())
}

/// Retained signed-metadata policy (strict ed25519 over the canonical
/// `dezoomify-updater-v1` message, HTTPS allowlist, stale/future bounds,
/// anti-rollback, explicit-confirm shape). Unit-tested only; production
/// calls `validate_update`, which is disabled. The caller supplies the
/// allowlist so tests never depend on the production (empty) list.
///
/// Validator outcome: `Ok(true)` means the candidate may be offered for
/// explicit user confirmation; `Err` rejects with stable
/// `updater.rejected: ...` strings.
pub fn validate_candidate(
    current_version: &str,
    candidate: &UpdateMetadata,
    now_secs: u64,
    public_key: &VerifyingKey,
    allowlist_hosts: &[&str],
) -> Result<bool, String> {
    // HTTPS allowlist.
    let host =
        url_host(&candidate.url).ok_or_else(|| "updater.rejected: invalid url".to_string())?;
    if !candidate.url.starts_with("https://") {
        return Err("updater.rejected: https required".to_string());
    }
    if !allowlist_hosts.contains(&host.as_str()) {
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

    /// Test-only allowlist host. Production ships an empty allowlist while
    /// updates are disabled; tests exercise the retained crypto policy
    /// against this synthetic host via `validate_candidate`.
    const TEST_ALLOWLIST: &[&str] = &["updater.test"];

    fn test_keypair() -> (SigningKey, VerifyingKey) {
        // Deterministic test key: production ships no updater key.
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
            url: "https://updater.test/desktop/0.2.0/bundle".to_string(),
            signature: None,
            sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
            timestamp: 1_700_000_000,
        }
    }

    fn check(
        current: &str,
        candidate: &UpdateMetadata,
        now: u64,
        key: &VerifyingKey,
    ) -> Result<bool, String> {
        validate_candidate(current, candidate, now, key, TEST_ALLOWLIST)
    }

    #[test]
    fn updater_is_explicitly_disabled() {
        // Todo 5.8 decision: no auto-update host, endpoints, or key.
        assert!(!is_updater_enabled());
        assert_eq!(is_updater_enabled(), UPDATER_ENABLED);
        assert!(UPDATER_ALLOWLIST_HOSTS.is_empty());
        assert!(UPDATER_ENDPOINTS.is_empty());
        assert_eq!(UPDATER_PUBKEY, "");
        assert!(check_updater_enabled().is_err());
        let err = check_updater_enabled().unwrap_err();
        assert!(err.contains("updater.disabled"), "unexpected error: {err}");
    }

    #[test]
    fn production_validate_update_always_reports_disabled() {
        // Even a correctly signed candidate is rejected at the disabled
        // gate before any crypto runs; the app keeps working.
        let (signing, verifying) = test_keypair();
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        let err = validate_update("0.1.0", &candidate, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("updater.disabled"), "unexpected error: {err}");
        let missing = valid();
        let err = validate_update("0.1.0", &missing, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("updater.disabled"), "unexpected error: {err}");
    }

    #[test]
    fn valid_signed_update_offered_for_confirm() {
        let (signing, verifying) = test_keypair();
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        assert_eq!(
            check("0.1.0", &candidate, 1_700_000_100, &verifying),
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
        assert!(check("0.1.0", &candidate, 1_700_000_100, &verifying).is_err());
        let mut hash_flipped = valid();
        hash_flipped.sha256 =
            "8f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string();
        assert!(check("0.1.0", &hash_flipped, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn garbled_and_missing_signatures_never_validate() {
        let (_, verifying) = test_keypair();
        let mut bogus = valid();
        bogus.signature = Some("sig:valid-placeholder".to_string());
        assert!(check("0.1.0", &bogus, 1_700_000_100, &verifying).is_err());
        let mut garbled = valid();
        garbled.signature = Some(
            "sig:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
        );
        assert!(check("0.1.0", &garbled, 1_700_000_100, &verifying).is_err());
        let mut missing = valid();
        missing.signature = None;
        assert!(check("0.1.0", &missing, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn wrong_key_fails_verification() {
        let (signing, _) = test_keypair();
        let other_seed = [9u8; 32];
        let other = VerifyingKey::from(&SigningKey::from_bytes(&other_seed));
        let mut candidate = valid();
        candidate.signature = Some(sign(&signing, &candidate));
        assert!(check("0.1.0", &candidate, 1_700_000_100, &other).is_err());
    }

    #[test]
    fn unsigned_tampered_stale_rollback_rejected() {
        let (signing, verifying) = test_keypair();
        let mut unsigned = valid();
        unsigned.signature = Some(sign(&signing, &unsigned));
        unsigned.signature = None;
        assert!(check("0.1.0", &unsigned, 1_700_000_100, &verifying).is_err());
        let mut tampered = valid();
        tampered.signature = Some(sign(&signing, &tampered));
        tampered.sha256 = "00".to_string();
        assert!(check("0.1.0", &tampered, 1_700_000_100, &verifying).is_err());
        let mut stale = valid();
        stale.signature = Some(sign(&signing, &stale));
        stale.timestamp = 1_600_000_000;
        assert!(check("0.1.0", &stale, 1_700_000_100, &verifying).is_err());
        let rollback = valid();
        assert!(check("0.2.0", &rollback, 1_700_000_100, &verifying).is_err());
        assert!(check("0.3.0", &rollback, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn non_https_or_foreign_host_rejected() {
        let (signing, verifying) = test_keypair();
        let mut plain = valid();
        plain.signature = Some(sign(&signing, &plain));
        let mut http = plain.clone();
        http.url = "http://updater.test/desktop/0.2.0/bundle".to_string();
        // Signature covers the url, so this is also a verification failure;
        // policy rejects the scheme before crypto.
        assert!(check("0.1.0", &http, 1_700_000_100, &verifying).is_err());
        let mut foreign = valid();
        foreign.url = "https://evil.example/desktop/0.2.0/bundle".to_string();
        foreign.signature = Some(sign(&signing, &foreign));
        assert!(check("0.1.0", &foreign, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn http_scheme_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut http = valid();
        http.url = "http://updater.test/desktop/0.2.0/bundle".to_string();
        http.signature = Some(sign(&signing, &http));
        let err = check("0.1.0", &http, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("https required"), "unexpected error: {err}");
    }

    #[test]
    fn malformed_hash_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut bad_hash = valid();
        bad_hash.sha256 = "00".to_string();
        bad_hash.signature = Some(sign(&signing, &bad_hash));
        let err = check("0.1.0", &bad_hash, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("tampered hash"), "unexpected error: {err}");
    }

    #[test]
    fn stale_metadata_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let now = 1_700_000_100u64;
        let mut stale = valid();
        stale.timestamp = now - UPDATER_MAX_AGE_SECS - 1;
        stale.signature = Some(sign(&signing, &stale));
        let err = check("0.1.0", &stale, now, &verifying).unwrap_err();
        assert!(err.contains("stale metadata"), "unexpected error: {err}");
    }

    #[test]
    fn future_timestamp_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let now = 1_700_000_100u64;
        let mut future = valid();
        future.timestamp = now + UPDATER_FUTURE_SKEW_SECS + 1;
        future.signature = Some(sign(&signing, &future));
        let err = check("0.1.0", &future, now, &verifying).unwrap_err();
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
        assert_eq!(check("0.1.0", &fresh_edge, now, &verifying), Ok(true));
        let mut skew_edge = valid();
        skew_edge.timestamp = now + UPDATER_FUTURE_SKEW_SECS;
        skew_edge.signature = Some(sign(&signing, &skew_edge));
        assert_eq!(check("0.1.0", &skew_edge, now, &verifying), Ok(true));
    }

    #[test]
    fn rollback_and_same_version_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut rollback = valid();
        rollback.version = "0.0.9".to_string();
        rollback.signature = Some(sign(&signing, &rollback));
        let err = check("0.1.0", &rollback, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("rollback"), "unexpected error: {err}");
        let mut same = valid();
        same.version = "0.1.0".to_string();
        same.signature = Some(sign(&signing, &same));
        let err = check("0.1.0", &same, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("rollback"), "unexpected error: {err}");
    }

    #[test]
    fn malformed_version_and_url_rejected_even_when_signed() {
        let (signing, verifying) = test_keypair();
        let mut bad_version = valid();
        bad_version.version = "not-a-version".to_string();
        bad_version.signature = Some(sign(&signing, &bad_version));
        let err = check("0.1.0", &bad_version, 1_700_000_100, &verifying).unwrap_err();
        assert!(err.contains("malformed version"), "unexpected error: {err}");
        let mut bad_url = valid();
        bad_url.url = "not a url".to_string();
        bad_url.signature = Some(sign(&signing, &bad_url));
        assert!(check("0.1.0", &bad_url, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn malformed_public_key_never_validates() {
        assert!(parse_public_key("").is_err());
        assert!(parse_public_key("zzzz").is_err());
        assert!(parse_public_key(UPDATER_PUBKEY).is_err());
    }

    #[test]
    fn production_pubkey_empty_never_validates() {
        // Updates are disabled: the shipped key stays empty (fail closed).
        assert_eq!(UPDATER_PUBKEY, "");
    }

    #[test]
    fn missing_delayed_older_metadata_never_stages_app_keeps_working() {
        let (signing, verifying) = test_keypair();
        // Missing signature: no staging, caller sees Err and continues.
        let missing = valid();
        assert!(check("0.1.0", &missing, 1_700_000_100, &verifying).is_err());
        // Delayed (stale) metadata: no staging, app keeps running.
        let mut delayed = valid();
        delayed.timestamp = 1_600_000_000;
        delayed.signature = Some(sign(&signing, &delayed));
        assert!(check("0.1.0", &delayed, 1_700_000_100, &verifying).is_err());
        // Older candidate than installed: no staging, app keeps running.
        let mut older = valid();
        older.version = "0.0.1".to_string();
        older.signature = Some(sign(&signing, &older));
        assert!(check("0.1.0", &older, 1_700_000_100, &verifying).is_err());
        // Newer-but-unsigned candidate: still never stages.
        let mut newer_unsigned = valid();
        newer_unsigned.version = "9.9.9".to_string();
        newer_unsigned.signature = None;
        assert!(check("0.1.0", &newer_unsigned, 1_700_000_100, &verifying).is_err());
    }

    #[test]
    fn disabled_updater_ships_no_endpoints() {
        // Todo 5.8: no auto-update host. Empty endpoints plus an empty
        // allowlist is the disabled shape; the channel string is retained
        // for the capability document only.
        assert!(UPDATER_ENDPOINTS.is_empty());
        assert!(UPDATER_ALLOWLIST_HOSTS.is_empty());
        assert_eq!(UPDATER_CHANNEL, "stable");
    }
}
