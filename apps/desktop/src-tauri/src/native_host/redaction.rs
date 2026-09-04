//! Redacted diagnostics for the native host (Phase 12).
//!
//! The host writes bounded framed responses to stdout and reserves stderr
//! for redacted diagnostics. Cookie values, bearer tokens, and other secrets
//! must never reach stdout envelopes, stderr, logs, or crash output.
//! Handling is memory-only with best-effort overwrite of owned buffers;
//! no universal zeroization is claimed (allocator/OS/transport copies cannot
//! be guaranteed wiped). No `std::net` here: pure string/byte helpers.

/// Placeholder that replaces every secret value.
pub const REDACTED: &str = "***";

/// Overwrite an owned buffer best-effort (zero-fill). Only affects this
/// allocation; does not wipe other copies.
pub fn best_effort_overwrite(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        *b = 0;
    }
}

/// Sanitize one stderr/log line by replacing every `secret` occurrence.
///
/// Empty secrets are ignored so callers can pass optional values safely.
pub fn sanitize_line(line: &str, secrets: &[&str]) -> String {
    let mut out = line.to_string();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        out = out.replace(secret, REDACTED);
    }
    out
}

/// True when `text` still contains any non-empty secret (leak check).
pub fn contains_secret(text: &str, secrets: &[&str]) -> bool {
    secrets.iter().any(|s| !s.is_empty() && text.contains(s))
}

/// Redact `Cookie:` / `Set-Cookie:` header values, keeping names only.
/// e.g. `Cookie: a=1; b=2` -> `Cookie: a=***; b=***`.
pub fn redact_cookie_header(header_value: &str) -> String {
    header_value
        .split(';')
        .map(|part| {
            let part = part.trim();
            match part.split_once('=') {
                Some((name, _)) => format!("{}={}", name.trim(), REDACTED),
                None => REDACTED.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Format a scoped cookie-use diagnostic with names only (never values).
/// `names` are cookie names, `origin` is the exact scope, `job` is the job id.
pub fn scoped_cookie_diagnostic(names: &[&str], origin: &str, job: &str) -> String {
    let list = names.join(",");
    format!("cookies scope origin={} job={} names=[{}]", origin, job, list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_values() {
        let line = "fetch https://a.example with session=abc123 done";
        let clean = sanitize_line(line, &["abc123"]);
        assert!(!clean.contains("abc123"));
        assert!(clean.contains(REDACTED));
    }

    #[test]
    fn cookie_header_keeps_names_only() {
        let redacted = redact_cookie_header("session=abc; theme=light");
        assert!(redacted.contains("session=***"));
        assert!(!redacted.contains("abc"));
    }

    #[test]
    fn diagnostic_never_embeds_values() {
        let d = scoped_cookie_diagnostic(&["session"], "https://a.example", "job-1");
        assert!(d.contains("session"));
        assert!(!d.contains("abc123"));
    }

    #[test]
    fn overwrite_zeroes_owned_buffer() {
        let mut buf = vec![1u8, 2, 3];
        best_effort_overwrite(&mut buf);
        assert_eq!(buf, vec![0u8, 0, 0]);
    }
}
