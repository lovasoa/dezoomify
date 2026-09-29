//! Validation for the desktop IPC entry points.

/// True for `job:<suffix>` ids within the 128-byte bound.
pub fn is_valid_job_id(job: &str) -> bool {
    if !job.starts_with("job:") {
        return false;
    }
    let suffix = &job["job:".len()..];
    if suffix.is_empty() || job.len() > 128 {
        return false;
    }
    suffix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// True for http(s) input urls up to 2048 bytes without userinfo.
pub fn is_valid_input_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 {
        return false;
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    // Reject userinfo credentials embedded in the authority section.
    if let Some(after_scheme) = url.split("://").nth(1) {
        let authority = after_scheme.split('/').next().unwrap_or("");
        let authority = authority.split('?').next().unwrap_or(authority);
        if authority.contains('@') {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_validation_rejects_untrusted_authorities_and_invalid_ids() {
        assert!(is_valid_input_url("https://example.com/image"));
        for value in [
            "",
            "file:///etc/passwd",
            "https://user:password@example.com/",
        ] {
            assert!(!is_valid_input_url(value));
        }
        assert!(is_valid_job_id("job:desktop-1"));
        for value in ["", "job:", "job:a/b", "a"] {
            assert!(!is_valid_job_id(value));
        }
    }
}
