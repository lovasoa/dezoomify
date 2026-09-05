// Handshake-only Native Messaging host (lean shell, std only).
//
// Phase-11 scope: report identity, version, and capabilities, then reject
// every job and credential message with `capability.unavailable`. Phase 12
// adds handoff execution. Browser enforcement of the manifest allowed
// extension ids authenticates the sender; this binary adds no separate
// identity check.

use std::io::{Read, Write};

pub const HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
pub const HOST_VERSION: &str = "0.1.0";
pub const HOST_PROTOCOL: &str = "1.0";

/// Canonical handshake acknowledgement (JSON line, no secrets).
pub fn handshake_json() -> String {
    format!(
        "{{\"kind\":\"handshake-ack\",\"name\":\"{HOST_NAME}\",\"version\":\"{HOST_VERSION}\",\"protocol\":\"{HOST_PROTOCOL}\",\"capabilities\":{{\"encoders\":[\"png\",\"jpeg\",\"tiff\"],\"handoff\":false}}}}"
    )
}

/// Fail-closed rejection for job and credential messages.
pub fn unavailable_json(reason: &str) -> String {
    let safe: String = reason.chars().take(64).collect();
    let escaped: String = safe.replace('\\', "\\\\").replace('"', "\\\"");
    format!("{{\"error\":{{\"code\":\"capability.unavailable\",\"message\":\"{escaped}\"}}}}")
}

/// Route one input line to handshake or fail-closed rejection.
/// Returns the response line (without trailing newline).
pub fn handle_message(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return unavailable_json("empty message");
    }
    if trimmed.contains("\"handshake\"") {
        return handshake_json();
    }
    if trimmed.contains("credential") || trimmed.contains("cookie") || trimmed.contains("authorization") {
        return unavailable_json("credential messages unavailable in this phase");
    }
    if trimmed.contains("\"job\"") || trimmed.contains("handoff") {
        return unavailable_json("job messages unavailable in this phase");
    }
    unavailable_json("unknown message kind")
}

fn main() {
    // Length-prefixed Native Messaging framing is owned by phase 12. This
    // lean host speaks line-delimited JSON on stdio so install and handshake
    // checks stay deterministic without browser dependencies.
    let mut input = String::new();
    let read = std::io::stdin().read_to_string(&mut input);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    match read {
        Ok(_) => {
            let mut wrote_any = false;
            for line in input.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = writeln!(out, "{}", handle_message(line));
                wrote_any = true;
            }
            if !wrote_any {
                let _ = writeln!(out, "{}", handshake_json());
            }
        }
        Err(_) => {
            let _ = writeln!(out, "{}", handshake_json());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_reports_identity() {
        let ack = handle_message("{\"kind\":\"handshake\",\"protocol\":\"1.0\"}");
        assert!(ack.contains(HOST_NAME));
        assert!(ack.contains(HOST_VERSION));
        assert!(ack.contains(HOST_PROTOCOL));
    }

    #[test]
    fn job_and_credential_rejected_fail_closed() {
        for msg in [
            "{\"kind\":\"job\",\"job\":\"job:1\"}",
            "{\"kind\":\"credential\",\"cookie\":\"a=b\"}",
            "{\"kind\":\"handoff\",\"source\":\"https://example.com\"}",
        ] {
            let res = handle_message(msg);
            assert!(res.contains("capability.unavailable"), "msg: {msg} -> {res}");
        }
    }
}
