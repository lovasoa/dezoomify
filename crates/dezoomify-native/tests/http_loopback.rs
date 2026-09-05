//! C1 acceptance: real-socket HTTP egress tests (redirects, size limits,
//! retries, and failures. Each test drives raw TCP listeners on loopback so
//! every byte crosses a real socket; no emulated transport.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use dezoomify_native::http::{fetch, FetchLimits, UserHeaders};

fn limits() -> FetchLimits {
    FetchLimits {
        max_bytes: 1 << 20,
        timeout: std::time::Duration::from_secs(10),
        connect_timeout: std::time::Duration::from_secs(5),
        max_redirects: 5,
        retries: 1,
        tls: Default::default(),
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
        None,
        &tight,
    )
    .expect_err("redirect limit");
    assert_eq!(error.code, "transport.redirect-limit");
    server.join().expect("server");
}

#[test]
fn allows_exactly_max_redirects() {
    // Two hops with max_redirects = 2: exactly at the limit must succeed.
    let (port, server) = serve(vec![
        response("HTTP/1.1 302 Found", &[("location", "/one")], b""),
        response("HTTP/1.1 302 Found", &[("location", "/two")], b""),
        response(
            "HTTP/1.1 200 OK",
            &[("content-type", "text/plain")],
            b"landed",
        ),
    ]);
    let mut wide = limits();
    wide.max_redirects = 2;
    let outcome = fetch(
        &format!("http://127.0.0.1:{port}/start"),
        &BTreeMap::new(),
        None,
        None,
        &wide,
    )
    .expect("exactly N redirects must be followed");
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body, b"landed");
    assert!(outcome.final_uri.ends_with("/two"));
    server.join().expect("server");
}

#[test]
fn rejects_redirect_when_limit_is_exceeded_by_one() {
    // Two hops with max_redirects = 1: the second redirect must be refused,
    // so a regression allowing one redirect too many cannot pass silently.
    let (port, server) = serve(vec![
        response("HTTP/1.1 302 Found", &[("location", "/one")], b""),
        response("HTTP/1.1 302 Found", &[("location", "/two")], b""),
    ]);
    let mut tight = limits();
    tight.max_redirects = 1;
    let error = fetch(
        &format!("http://127.0.0.1:{port}/start"),
        &BTreeMap::new(),
        None,
        None,
        &tight,
    )
    .expect_err("limit+1 redirects must fail");
    assert_eq!(error.code, "transport.redirect-limit");
    server.join().expect("server");
}

#[test]
fn fails_after_retry_exhaustion() {
    let (port, server) = serve(vec![Vec::new(), Vec::new()]);
    let error = fetch(
        &format!("http://127.0.0.1:{port}/dead"),
        &BTreeMap::new(),
        None,
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
        None,
        &limits(),
    )
    .expect_err("connection refused");
    assert_eq!(error.code, "transport.network-error");
}

#[test]
fn credentials_never_leave_the_input_origin() {
    // One listener records the request heads it receives.
    let captured: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let sink = std::sync::Arc::clone(&captured);
    let server = thread::spawn(move || {
        for _ in 0..2 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buffer = [0u8; 4096];
            let n = stream.read(&mut buffer).unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..n]).to_string();
            let response = response("HTTP/1.1 200 OK", &[("content-type", "text/plain")], b"ok");
            let _ = stream.write_all(&response);
            sink.lock().expect("lock").push(head);
        }
    });
    let mut headers = std::collections::BTreeMap::new();
    headers.insert("Cookie".to_string(), "js_enabled=2".to_string());
    headers.insert("Accept".to_string(), "text/html".to_string());

    // Same-origin request: the scoped cookie is sent.
    let same = UserHeaders::new(headers.clone(), Some("127.0.0.1".to_string()));
    fetch(
        &format!("http://127.0.0.1:{port}/a"),
        &BTreeMap::new(),
        Some(&same),
        None,
        &limits(),
    )
    .expect("same-origin fetch");
    // Foreign-origin request: the scoped cookie is dropped, plain headers stay.
    let foreign = UserHeaders::new(headers, Some("other-origin.test".to_string()));
    fetch(
        &format!("http://127.0.0.1:{port}/b"),
        &BTreeMap::new(),
        Some(&foreign),
        None,
        &limits(),
    )
    .expect("foreign-origin fetch");
    server.join().expect("server");
    let heads = captured.lock().expect("lock");
    assert!(
        heads[0]
            .to_ascii_lowercase()
            .contains("cookie: js_enabled=2"),
        "same-origin request must carry the scoped cookie"
    );
    assert!(
        !heads[1].to_ascii_lowercase().contains("cookie:"),
        "foreign-origin request must never carry the scoped cookie"
    );
    assert!(
        heads[1].to_ascii_lowercase().contains("accept: text/html"),
        "non-credential user headers apply everywhere"
    );
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
        None,
        &limits(),
    )
    .expect("outcome returned");
    assert_eq!(outcome.status, 404);
    assert!(!outcome.ok());
    server.join().expect("server");
}
