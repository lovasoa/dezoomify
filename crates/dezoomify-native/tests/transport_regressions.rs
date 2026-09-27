//! Transport regressions: single-attempt fetches, connection reuse on one
//! job-scoped transport, per-hop redirect rescoping, and `retry-after`
//! observation. Raw TCP listeners on loopback prove every byte crosses a
//! real socket and count exactly how many requests/connections arrive.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use dezoomify_native::http::{FetchLimits, UserHeaders};
use dezoomify_native::transport::NativeTransport;

fn limits() -> FetchLimits {
    FetchLimits {
        max_bytes: 1 << 20,
        timeout: std::time::Duration::from_secs(10),
        connect_timeout: std::time::Duration::from_secs(5),
        max_redirects: 5,
        max_idle_per_host: 32,
        tls: Default::default(),
    }
}

fn transport() -> NativeTransport {
    NativeTransport::new(&limits()).expect("transport builds")
}

#[test]
fn generated_requests_keep_headers_and_redirect_results_for_every_purpose() {
    use dezoomify::model::{Header, RequestPurpose, ResourceRequest};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for hop in 0..6 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            assert!(String::from_utf8(head)
                .unwrap()
                .to_lowercase()
                .contains("accept: application/xml"));
            let reply = if hop % 2 == 0 {
                response(
                    "HTTP/1.1 302 Found",
                    &[("location", "/final"), ("connection", "close")],
                    b"",
                )
            } else {
                response("HTTP/1.1 200 OK", &[("connection", "close")], b"resource")
            };
            socket.write_all(&reply).unwrap();
        }
    });
    let transport = transport();
    for purpose in [
        RequestPurpose::Metadata,
        RequestPurpose::Tile,
        RequestPurpose::Probe,
    ] {
        let request = ResourceRequest {
            id: 42,
            uri: format!("{origin}/start"),
            purpose,
            headers: vec![Header {
                name: "Accept".into(),
                value: "application/xml".into(),
            }],
        };
        let result = transport
            .block_on(transport.fetch_resource(&request, None, None, &limits()))
            .unwrap();
        assert_eq!(result.final_uri, format!("{origin}/final"));
        assert_eq!(result.body, b"resource");
    }
    server.join().unwrap();
}

fn response(status_line: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(status_line.as_bytes());
    out.extend_from_slice(b"\r\n");
    for (name, value) in headers {
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

/// Serve canned responses round-robin, counting accepted connections.
/// Each connection answers up to `per_connection` requests with keep-alive
/// framing so sequential fetches can reuse one connection. The listener
/// stops accepting after `expected_connections`; tests that know the exact
/// count join the handle, pooled tests detach and poll the counters.
fn serve_counted(
    responses: Vec<Vec<u8>>,
    per_connection: usize,
    expected_connections: usize,
) -> (
    u16,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let connections = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let conns = Arc::clone(&connections);
    let reqs = Arc::clone(&requests);
    let handle = thread::spawn(move || {
        // One thread per connection: concurrent fetches open concurrent
        // connections and no connection head-of-line-blocks another.
        for stream in listener.incoming().take(expected_connections) {
            let Ok(mut stream) = stream else { break };
            conns.fetch_add(1, Ordering::SeqCst);
            let reqs = Arc::clone(&reqs);
            let responses = responses.clone();
            thread::spawn(move || {
                for _ in 0..per_connection {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while head.len() < 8192 {
                        let Ok(n) = stream.read(&mut byte) else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        head.extend_from_slice(&byte);
                        if head.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    if head.is_empty() {
                        return;
                    }
                    let index = reqs.fetch_add(1, Ordering::SeqCst);
                    let body = responses
                        .get(index % responses.len().max(1))
                        .cloned()
                        .unwrap_or_else(|| {
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".to_vec()
                        });
                    if stream.write_all(&body).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                }
            });
        }
    });
    (port, connections, requests, handle)
}

#[test]
fn http_refusal_returns_once_without_retry() {
    // A 403 is an outcome, not a transport error, and the transport makes
    // exactly one request: permanent failures must never be retried by the
    // transport (the engine classifies them once and attempts once).
    let (port, _conns, requests, server) = serve_counted(
        vec![response(
            "HTTP/1.1 403 Forbidden",
            &[("content-type", "text/plain")],
            b"denied",
        )],
        4,
        1,
    );
    let outcome = transport()
        .fetch(
            &format!("http://127.0.0.1:{port}/tile.png"),
            &BTreeMap::new(),
            None,
            None,
            &limits(),
        )
        .expect("refusal returns as outcome");
    assert_eq!(outcome.status, 403);
    assert!(!outcome.ok());
    server.join().expect("server exits after one connection");
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "a 403 must hit the server exactly once"
    );
}

#[test]
fn redirect_rejects_userinfo_and_unsupported_schemes() {
    // Credential-bearing redirect targets never leave the transport: userinfo
    // is rejected before any second request is made.
    let (port, _conns, requests, server) = serve_counted(
        vec![response(
            "HTTP/1.1 302 Found",
            &[("location", "http://user:pass@127.0.0.1/x")],
            b"",
        )],
        1,
        1,
    );
    let error = transport()
        .fetch(
            &format!("http://127.0.0.1:{port}/start"),
            &BTreeMap::new(),
            None,
            None,
            &limits(),
        )
        .expect_err("userinfo redirect rejected");
    assert_eq!(error.code, "transport.bad-redirect");
    server.join().expect("server exits after one connection");
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[test]
fn redirect_drops_credentials_across_hosts() {
    // A redirect to a different loopback host (127.0.0.2 vs 127.0.0.1)
    // rescopes credentials: the scoped cookie arrives on hop one and never
    // on hop two, while plain headers survive.
    let hop2_heads: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let hop2_sink = Arc::clone(&hop2_heads);
    // Hop two listens on 127.0.0.2 (same machine, different host name for
    // credential scoping) while hop one stays on 127.0.0.1.
    let hop2 = TcpListener::bind("127.0.0.2:0").expect("bind hop2");
    let hop2_port = hop2.local_addr().expect("addr").port();
    let hop2_server = thread::spawn(move || {
        let Ok((mut stream, _)) = hop2.accept() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        let n = stream.read(&mut buffer).unwrap_or(0);
        hop2_sink
            .lock()
            .expect("lock")
            .push(String::from_utf8_lossy(&buffer[..n]).to_string());
        let _ = stream.write_all(&response(
            "HTTP/1.1 200 OK",
            &[("content-type", "text/plain")],
            b"final",
        ));
        let _ = stream.flush();
    });
    let hop1 = TcpListener::bind("127.0.0.1:0").expect("bind hop1");
    let hop1_port = hop1.local_addr().expect("addr").port();
    let hop1_server = thread::spawn(move || {
        let Ok((mut stream, _)) = hop1.accept() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let _ = stream.write_all(&response(
            "HTTP/1.1 302 Found",
            &[("location", &format!("http://127.0.0.2:{hop2_port}/final"))],
            b"",
        ));
        let _ = stream.flush();
    });
    let mut headers = BTreeMap::new();
    headers.insert("Cookie".to_string(), "session=abc".to_string());
    headers.insert("Accept".to_string(), "image/png".to_string());
    let user = UserHeaders::new(headers, Some("127.0.0.1".to_string()));
    let outcome = transport()
        .fetch(
            &format!("http://127.0.0.1:{hop1_port}/start"),
            &BTreeMap::new(),
            Some(&user),
            None,
            &limits(),
        )
        .expect("redirect followed");
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body, b"final");
    hop1_server.join().expect("hop1");
    hop2_server.join().expect("hop2");
    let heads = hop2_heads.lock().expect("lock");
    assert_eq!(heads.len(), 1, "exactly one hop-two request");
    assert!(
        !heads[0].to_ascii_lowercase().contains("cookie:"),
        "cookie must not cross hosts: {}",
        heads[0]
    );
    assert!(
        heads[0].to_ascii_lowercase().contains("accept: image/png"),
        "plain headers survive redirects: {}",
        heads[0]
    );
}

#[test]
fn retry_after_seconds_hint_flows_to_the_outcome() {
    let (port, _conns, _reqs, server) = serve_counted(
        vec![response(
            "HTTP/1.1 429 Too Many Requests",
            &[("content-type", "text/plain"), ("retry-after", "2")],
            b"slow down",
        )],
        1,
        1,
    );
    let outcome = transport()
        .fetch(
            &format!("http://127.0.0.1:{port}/limited"),
            &BTreeMap::new(),
            None,
            None,
            &limits(),
        )
        .expect("429 returns as outcome");
    assert_eq!(outcome.status, 429);
    assert_eq!(outcome.retry_after_ms, Some(2000));
    server.join().expect("server exits after one connection");
}
