// Native Messaging host: framed handoff execution (lean, pure Rust).
//
// - One native-endian u32 length-prefixed JSON message from stdin at a time;
//   bounded framed responses to stdout (see `native_host::framing`).
// - Handshake reports identity, version, and capabilities with `handoff:true`.
// - `negotiate` -> `consent` (explicit UI confirmation) -> `credential`
//   (single bounded cookie message, origin-scoped) -> one job. Challenge +
//   one-use nonce bind one exchange to one job and block replay.
// - Cookies are memory-only, scoped to the consented origins/names, never
//   persisted, never echoed in responses, and best-effort overwritten after
//   transfer. Diagnostics on stderr carry names/scopes only (see
//   `native_host::redaction`).
// - Browser enforcement of the manifest allowed extension IDs authenticates
//   the channel sender; this binary adds no separate identity check and never
//   authenticates anyone from a self-asserted id, challenge, or nonce.

// 6.1 unwrap policy: malformed stdin, oversized frames, and bad envelopes map
// to `handoff.rejected`/`protocol.*` framed rejections instead of panicking
// (see `lib.rs`).
#![deny(clippy::unwrap_used)]

use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use dezoomify_desktop::native_host::framing;
use dezoomify_desktop::native_host::host::HostState;
use dezoomify_desktop::native_host::redaction;

pub const HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
pub const HOST_VERSION: &str = "3.0.3";
pub const HOST_PROTOCOL: &str = "1.0";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Fresh `bytes` random bytes as lowercase hex. Reads the OS entropy pool;
/// falls back to a time/pid mix only when the pool is unavailable (never
/// panics, never blocks on network).
fn fresh_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if read_urandom(&mut buf).is_ok() {
        return hex(&buf);
    }
    // Fallback: mix time, pid, and a counter (still unique per handoff in
    // practice; the one-use nonce table blocks replay regardless).
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = now_ms()
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(u64::from(std::process::id()).wrapping_mul(0xBF58_476D_1CE4_E5B9))
        .wrapping_add(count.wrapping_mul(0x94D0_49BB_1331_11EB));
    let mut x = seed;
    for byte in buf.iter_mut() {
        // SplitMix64-style mix for the fallback path only.
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        *byte = (z ^ (z >> 31)) as u8;
    }
    hex(&buf)
}

fn read_urandom(buf: &mut [u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::open("/dev/urandom")?;
    file.read_exact(buf)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// Legacy line helper kept for unit tests: routes one JSON line through a
/// fresh host and returns the response JSON (without framing).
/// Production stdio always uses length-prefixed framing; this helper never
/// carries secrets (test values only).
pub fn handle_message(line: &str) -> String {
    let mut state = HostState::production();
    let (bytes, _) = state.handle(line.trim().as_bytes(), now_ms(), &mut || {
        (fresh_hex(16), fresh_hex(16))
    });
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Fail-closed JSON error (codes/messages only, never values).
pub fn unavailable_json(reason: &str) -> String {
    let safe: String = reason.chars().take(64).collect();
    let escaped = safe.replace('\\', "\\\\").replace('"', "\\\"");
    format!("{{\"error\":{{\"code\":\"capability.unavailable\",\"message\":\"{escaped}\"}}}}")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("usage: dezoomify-native-host [--handshake]");
        println!("  no args: framed Native Messaging loop on stdio");
        println!("  --handshake: print one handshake-ack JSON line and exit");
        return;
    }
    if args.iter().any(|a| a == "--handshake") {
        let ack = HostState::handshake_ack();
        println!("{}", serde_json::to_string(&ack).unwrap_or_default());
        return;
    }
    run_framed_loop();
}

/// Framed Native Messaging loop: stdin -> bounded responses on stdout,
/// redacted diagnostics on stderr. Oversized prefixes drop the channel
/// without allocating the claimed bytes; truncated EOF is reported without
/// a response.
fn run_framed_loop() {
    let mut state = HostState::production();
    let mut stdin = std::io::stdin().lock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let stderr = std::io::stderr();
    let mut err = stderr.lock();
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stdin.read(&mut chunk) {
            Ok(0) => {
                if framing::is_clean_eof(&buffer) {
                    break;
                }
                let _ = writeln!(
                    err,
                    "{}",
                    redaction::sanitize_line("native host: truncated frame at EOF", &[])
                );
                break;
            }
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                loop {
                    match framing::try_parse_frame(&buffer) {
                        Ok(None) => break,
                        Ok(Some((payload, consumed))) => {
                            buffer.drain(..consumed);
                            // Bound the JSON parse to the framed maximum;
                            // framing already enforced it before allocation.
                            let (response, diagnostic) =
                                state.handle(&payload, now_ms(), &mut || {
                                    (fresh_hex(16), fresh_hex(16))
                                });
                            if let Some(line) = diagnostic {
                                let _ = writeln!(err, "{line}");
                            }
                            match framing::encode_frame(&response) {
                                Ok(framed) => {
                                    if out.write_all(&framed).is_err() {
                                        return;
                                    }
                                    let _ = out.flush();
                                }
                                Err(_) => {
                                    let _ = writeln!(
                                        err,
                                        "{}",
                                        redaction::sanitize_line(
                                            "native host: response oversize, dropped",
                                            &[]
                                        )
                                    );
                                    return;
                                }
                            }
                        }
                        Err(framing::FrameError::Oversized { claimed }) => {
                            let _ = writeln!(
                                err,
                                "native host: oversized message ({claimed} bytes), channel dropped"
                            );
                            return;
                        }
                        Err(framing::FrameError::BufferTooShort) => {
                            let _ = writeln!(
                                err,
                                "{}",
                                redaction::sanitize_line(
                                    "native host: frame buffer too short",
                                    &[]
                                )
                            );
                            return;
                        }
                    }
                }
            }
            Err(_) => break,
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
        assert!(
            ack.contains("\"handoff\":true"),
            "host executes handoff: {ack}"
        );
    }

    #[test]
    fn unknown_message_rejected_fail_closed() {
        for msg in [
            "{\"kind\":\"exfiltrate\",\"cookie\":\"CANARY\"}",
            "{\"kind\":\"job\",\"job\":\"job:1\"}",
            "not json",
        ] {
            let res = handle_message(msg);
            assert!(
                res.contains("capability.unavailable") || res.contains("handoff.rejected"),
                "msg: {msg} -> {res}"
            );
            assert!(!res.contains("CANARY"), "secret leaked: {res}");
        }
    }

    #[test]
    fn framed_round_trip_preserves_bytes() {
        let payload = br#"{"kind":"handshake","protocol":"1.0"}"#;
        let framed = framing::encode_frame(payload).unwrap();
        let (parsed, consumed) = framing::try_parse_frame(&framed).unwrap().unwrap();
        assert_eq!(parsed, payload);
        assert_eq!(consumed, framed.len());
        let res = handle_message("{\"kind\":\"handshake\",\"protocol\":\"1.0\"}");
        assert!(res.contains("handshake-ack"));
    }
}
