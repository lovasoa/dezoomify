// Signed updater metadata validator stub (pure, std only).
//
// Policy: HTTPS-only allowlisted endpoints, signed metadata required,
// anti-rollback (candidate must be newer than installed), stale timestamps
// rejected, and explicit user confirmation before staging anything. The app
// keeps working when metadata is missing, delayed, older, or newer than
// store versions. Unsigned packages are never staged or executed.

/// HTTPS endpoint allowlist (hosts only).
pub const UPDATER_ALLOWLIST_HOSTS: &[&str] = &["updates.dezoomify.example"];
/// Update channel.
pub const UPDATER_CHANNEL: &str = "stable";
/// Maximum metadata age in seconds before it counts as stale (7 days).
pub const UPDATER_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// Candidate update metadata (parsed, non-secret fields only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateMetadata {
    pub version: String,
    pub url: String,
    pub signature: Option<String>,
    pub sha256: String,
    pub timestamp: u64,
}

/// Validator outcome: `Ok(true)` means the candidate may be offered for
/// explicit user confirmation; `Ok(false)` means no update; `Err` rejects.
pub fn validate_update(
    current_version: &str,
    candidate: &UpdateMetadata,
    now_secs: u64,
) -> Result<bool, String> {
    // HTTPS allowlist.
    let host = url_host(&candidate.url).ok_or_else(|| "updater.rejected: invalid url".to_string())?;
    if !candidate.url.starts_with("https://") {
        return Err("updater.rejected: https required".to_string());
    }
    if !UPDATER_ALLOWLIST_HOSTS.contains(&host.as_str()) {
        return Err("updater.rejected: host not allowlisted".to_string());
    }
    // Signed metadata required: missing or malformed signatures never stage.
    // Stub scope (honest): no public-key crypto here yet, so accept only a
    // well-formed `sig:<64+ hex>` placeholder shape and explicitly reject the
    // `valid-placeholder` test double outside unit tests. Real signature
    // verification is future work; this validator never auto-stages.
    match &candidate.signature {
        Some(sig)
            if sig.starts_with("sig:")
                && sig.len() >= 68
                && sig[4..].chars().all(|c| c.is_ascii_hexdigit())
                && !sig.contains("placeholder") => {}
        _ => return Err("updater.rejected: unsigned metadata".to_string()),
    }
    // Hash must look like 64 lowercase hex chars (tamper check stub).
    if candidate.sha256.len() != 64
        || !candidate.sha256.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("updater.rejected: tampered hash".to_string());
    }
    // Stale timestamps never stage.
    if candidate.timestamp > now_secs.saturating_add(300) {
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
    let host = after.split('/').next()?.split(':').next()?.split('?').next()?.to_string();
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

    fn valid() -> UpdateMetadata {
        UpdateMetadata {
            version: "0.2.0".to_string(),
            url: "https://updates.dezoomify.example/desktop/0.2.0/bundle".to_string(),
            signature: Some(
                "sig:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
            ),
            sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_string(),
            timestamp: 1_700_000_000,
        }
    }

    #[test]
    fn placeholder_signatures_never_validate() {
        let mut placeholder = valid();
        placeholder.signature = Some("sig:valid-placeholder".to_string());
        assert!(validate_update("0.1.0", &placeholder, 1_700_000_100).is_err());
    }

    #[test]
    fn valid_update_offered_for_confirm() {
        assert_eq!(validate_update("0.1.0", &valid(), 1_700_000_100), Ok(true));
    }

    #[test]
    fn unsigned_tampered_stale_rollback_rejected() {
        let mut unsigned = valid();
        unsigned.signature = None;
        assert!(validate_update("0.1.0", &unsigned, 1_700_000_100).is_err());
        let mut tampered = valid();
        tampered.sha256 = "00".to_string();
        assert!(validate_update("0.1.0", &tampered, 1_700_000_100).is_err());
        let mut stale = valid();
        stale.timestamp = 1_600_000_000;
        assert!(validate_update("0.1.0", &stale, 1_700_000_100).is_err());
        let rollback = valid();
        assert!(validate_update("0.2.0", &rollback, 1_700_000_100).is_err());
        assert!(validate_update("0.3.0", &rollback, 1_700_000_100).is_err());
    }

    #[test]
    fn non_https_or_foreign_host_rejected() {
        let mut plain = valid();
        plain.url = "http://updates.dezoomify.example/desktop/0.2.0/bundle".to_string();
        assert!(validate_update("0.1.0", &plain, 1_700_000_100).is_err());
        let mut foreign = valid();
        foreign.url = "https://evil.example/desktop/0.2.0/bundle".to_string();
        assert!(validate_update("0.1.0", &foreign, 1_700_000_100).is_err());
    }
}
