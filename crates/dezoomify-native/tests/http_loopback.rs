//! C1 acceptance: real-socket HTTP egress tests — redirects, size limits,
//! retries, and failures. Each test drives raw TCP listeners on loopback so
//! every byte crosses a real socket; no emulated transport.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use dezoomify_native::http::{fetch, FetchLimits};

fn limits() -> FetchLimits {
    FetchLimits {
        max_bytes: 1 << 20,
        timeout: std::time::Duration::from_secs(10),
        connect_timeout: std::time::Duration::from_secs(5),
        max_redirects: 5,
        retries: 1,
    }
}

fn response(status_line: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(status_line.as_bytes());
    out.extend_from_slice(b"\r\n");
    for (name, value) in headers {
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

/// Serves one canned response per accepted connection on a fresh loopback
/// port. Requests are drained before responding. Never re-binds.
fn serve(responses: Vec<Vec<u8>>) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let handle = thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(&response);
            let _ = stream.flush();
        }
    });
    (port, handle)
}

#[test]
fn follows_redirect_across_hosts() {
    let (final_port, final_server) = serve(vec![response(
        "HTTP/1.1 200 OK",
        &[("content-type", "text/plain")],
        b"final-bytes",
    )]);
    let (start_port, start_server) = serve(vec![response(
        "HTTP/1.1 302 Found",
        &[("location", &format!("http://127.0.0.1:{final_port}/final"))],
        b"",
    )]);
    let outcome = fetch(
        &format!("http://127.0.0.1:{start_port}/start"),
        &BTreeMap::new(),
        None,
        &limits(),
    )
    .expect("fetch follows redirect");
    assert_eq!(outcome.status, 200);
    assert_eq!(
        outcome.final_uri,
        format!("http://127.0.0.1:{final_port}/final")
    );
    assert_eq!(outcome.body, b"final-bytes");
    start_server.join().expect("start server");
    final_server.join().expect("final server");
}

#[test]
fn rejects_redirect_beyond_limit() {
    let (port, server) = serve(vec![response(
        "HTTP/1.1 302 Found",
        &[("location", "/next")],
        b"",
    )]);
    let mut tight = limits();
    tight.max_redirects = 0;
    let error = fetch(
        &format!("http://127.0.0.1:{port}/start"),
        &BTreeMap::new(),
        None,
        &tight,
    )
    .expect_err("redirect limit");
    assert_eq!(error.code, "transport.redirect-limit");
    server.join().expect("server");
}

#[test]
fn enforces_size_limit() {
    let body = vec![0xAB; 2048];
    let (port, server) = serve(vec![response(
        "HTTP/1.1 200 OK",
        &[("content-type", "application/octet-stream")],
        &body,
    )]);
    let mut tight = limits();
    tight.max_bytes = 1024;
    let error = fetch(
        &format!("http://127.0.0.1:{port}/big"),
        &BTreeMap::new(),
        None,
        &tight,
    )
    .expect_err("size limit");
    assert_eq!(error.code, "transport.size-limit");
    server.join().expect("server");
}

#[test]
fn retries_after_connection_reset() {
    let close = b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".to_vec();
    let (port, server) = serve(vec![
        Vec::new(),
        response(
            "HTTP/1.1 200 OK",
            &[("content-type", "text/plain")],
            b"ok-after-retry",
        ),
    ]);
    let _ = close;
    let outcome = fetch(
        &format!("http://127.0.0.1:{port}/flaky"),
        &BTreeMap::new(),
        None,
        &limits(),
    )
    .expect("retry succeeds");
    assert_eq!(outcome.body, b"ok-after-retry");
    server.join().expect("server");
}

#[test]
fn fails_after_retry_exhaustion() {
    let (port, server) = serve(vec![Vec::new(), Vec::new()]);
    let error = fetch(
        &format!("http://127.0.0.1:{port}/dead"),
        &BTreeMap::new(),
        None,
        &limits(),
    )
    .expect_err("both attempts reset");
    assert_eq!(error.code, "transport.network-error");
    server.join().expect("server");
}

#[test]
fn connection_refused_is_network_error() {
    // Bind then immediately drop the listener to claim a definitively
    // closed loopback port.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    let error = fetch(
        &format!("http://127.0.0.1:{port}/nothing"),
        &BTreeMap::new(),
        None,
        &limits(),
    )
    .expect_err("connection refused");
    assert_eq!(error.code, "transport.network-error");
}

#[test]
fn exposes_http_error_status() {
    let (port, server) = serve(vec![response(
        "HTTP/1.1 404 Not Found",
        &[("content-type", "text/plain")],
        b"missing",
    )]);
    let outcome = fetch(
        &format!("http://127.0.0.1:{port}/absent"),
        &BTreeMap::new(),
        None,
        &limits(),
    )
    .expect("outcome returned");
    assert_eq!(outcome.status, 404);
    assert!(!outcome.ok());
    server.join().expect("server");
}
