//! Transport regressions: single-attempt fetches, connection reuse on one
//! job-scoped transport, per-hop redirect rescoping, and `retry-after`
//! observation. Node-owned loopback sockets prove every byte crosses a
//! real socket and count exactly how many requests/connections arrive.

use dezoomify_fixture_server::{NodeServer, RawResponse};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use dezoomify::model::Error;
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
    let requests = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&requests);
    let server = NodeServer::raw("127.0.0.1", move |request| {
        assert!(request
            .head
            .to_lowercase()
            .contains("accept: application/xml"));
        let hop = count.fetch_add(1, Ordering::SeqCst);
        if hop.is_multiple_of(2) {
            response(
                "HTTP/1.1 302 Found",
                &[("location", "/final"), ("connection", "close")],
                b"",
            )
            .into()
        } else {
            response("HTTP/1.1 200 OK", &[("connection", "close")], b"resource").into()
        }
    });
    let origin = server.origin.clone();
    let transport = transport();
    for purpose in [
        RequestPurpose::Metadata,
        RequestPurpose::Tile,
        RequestPurpose::Probe,
    ] {
        let request = ResourceRequest {
            uri: format!("{origin}/start"),
            purpose,
            headers: vec![Header {
                name: "Accept".into(),
                value: "application/xml".into(),
            }],
        };
        let result = transport
            .block_on(transport.fetch_resource(&request, None, &limits()))
            .unwrap();
        assert_eq!(result.final_uri, format!("{origin}/final"));
        assert_eq!(result.body, b"resource");
    }
    server.join().unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 6);
}

#[test]
fn duplicate_ranges_are_rejected_before_header_normalization() {
    use dezoomify::model::{Header, RequestPurpose, ResourceRequest};
    let transport = transport();
    // Either URI would fail with a network error if acquisition were attempted.
    for uri in [
        "http://127.0.0.1:9/container.zif",
        "/missing-dezoomify-range-fixture/container.zif",
    ] {
        for name in ["Range", "rAnGe"] {
            let request = ResourceRequest {
                uri: uri.into(),
                purpose: RequestPurpose::Metadata,
                headers: vec![
                    Header {
                        name: "Range".into(),
                        value: "bytes=0-3".into(),
                    },
                    Header {
                        name: name.into(),
                        value: "bytes=4-7".into(),
                    },
                ],
            };
            assert!(matches!(
                transport.block_on(transport.fetch_resource(&request, None, &limits())),
                Err(Error::BadUrl(_))
            ));
        }
        let headers = BTreeMap::from([
            ("Range".into(), "bytes=0-3".into()),
            ("rAnGe".into(), "bytes=4-7".into()),
        ]);
        assert!(matches!(
            transport.fetch(uri, &headers, None, &limits()),
            Err(Error::BadUrl(_))
        ));
    }
}

#[test]
fn finite_ranges_require_exact_partial_responses_after_redirects() {
    let server = NodeServer::raw("127.0.0.1", |request| {
        assert!(request.head.to_lowercase().contains("range: bytes=4-7"));
        if request.path == "/chunked-short" || request.path == "/chunked-long" {
            let chunk = if request.path == "/chunked-short" {
                "3\r\n456"
            } else {
                "5\r\n45678"
            };
            return format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-7/10\r\nTransfer-Encoding: chunked\r\n\r\n{chunk}\r\n0\r\n\r\n").into_bytes().into();
        }
        let (status, headers, body): (&str, &[(&str, &str)], &[u8]) = match request.path.as_str() {
            "/redirect" => ("HTTP/1.1 302 Found", &[("location", "/valid")], b""),
            "/valid" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 4-7/10")],
                b"4567",
            ),
            "/ignored" => ("HTTP/1.1 200 OK", &[], b"0123456789"),
            "/missing" => ("HTTP/1.1 206 Partial Content", &[], b"4567"),
            "/wrong" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 0-3/10")],
                b"0123",
            ),
            "/duplicate" => (
                "HTTP/1.1 206 Partial Content",
                &[
                    ("content-range", "bytes 4-7/10"),
                    ("content-range", "bytes 0-3/10"),
                ],
                b"4567",
            ),
            "/unknown-total" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 4-7/*")],
                b"4567",
            ),
            "/bad-total" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 4-7/7")],
                b"4567",
            ),
            "/short" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 4-7/10")],
                b"456",
            ),
            "/long" => (
                "HTTP/1.1 206 Partial Content",
                &[("content-range", "bytes 4-7/10")],
                b"45678",
            ),
            "/refused" => ("HTTP/1.1 416 Range Not Satisfiable", &[], b"range refused"),
            _ => panic!("unexpected request"),
        };
        response(status, headers, body).into()
    });
    let transport = transport();
    let headers = BTreeMap::from([("Range".into(), "bytes=4-7".into())]);
    let valid = transport
        .fetch(
            &format!("{}/redirect", server.origin),
            &headers,
            None,
            &limits(),
        )
        .unwrap();
    assert_eq!(valid.status, 206);
    assert_eq!(valid.body, b"4567");
    for path in [
        "ignored",
        "missing",
        "wrong",
        "unknown-total",
        "bad-total",
        "short",
        "long",
        "chunked-short",
        "chunked-long",
        "duplicate",
    ] {
        let error = transport
            .fetch(
                &format!("{}/{path}", server.origin),
                &headers,
                None,
                &limits(),
            )
            .unwrap_err();
        assert!(matches!(error, Error::BadUrl(_)), "{path}: {error}");
    }
    let refusal = transport
        .fetch(
            &format!("{}/refused", server.origin),
            &headers,
            None,
            &limits(),
        )
        .unwrap();
    assert_eq!(refusal.status, 416);
    let user = UserHeaders::new(BTreeMap::from([("Range".into(), "bytes=0-1".into())]), None);
    assert!(matches!(
        transport.fetch(
            &format!("{}/valid", server.origin),
            &headers,
            Some(&user),
            &limits()
        ),
        Err(Error::BadUrl(_))
    ));
    server.join().unwrap();
}

#[test]
fn local_ranges_seek_without_reading_the_whole_container() {
    let work = dezoomify_fixture_server::temp_dir("local-ranges");
    let path = work.join("container.bin");
    std::fs::write(&path, b"0123456789").unwrap();
    let transport = transport();
    let mut small = limits();
    small.max_bytes = 4;
    for uri in [
        path.to_str().unwrap().to_owned(),
        format!("file://{}", path.display()),
    ] {
        let headers = BTreeMap::from([("Range".into(), "bytes=4-7".into())]);
        let outcome = transport.fetch(&uri, &headers, None, &small).unwrap();
        assert_eq!(outcome.status, 206);
        assert_eq!(outcome.body, b"4567");
        for value in [
            "bytes=8-11",
            "bytes=-3",
            "bytes=3-",
            "bytes=4-3",
            "bytes=0-1,4-5",
            "bytes=+0-1",
            "bytes=0-18446744073709551615",
        ] {
            let headers = BTreeMap::from([("Range".into(), value.into())]);
            assert!(
                matches!(
                    transport.fetch(&uri, &headers, None, &small),
                    Err(Error::BadUrl(_))
                ),
                "{value}"
            );
        }
        assert!(matches!(
            transport.fetch(&uri, &BTreeMap::new(), None, &small),
            Err(Error::SizeLimit { .. })
        ));
    }
    std::fs::remove_dir_all(work).unwrap();
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

/// Node serves canned bytes while Rust observes request and connection counts.
fn serve_counted(
    responses: Vec<Vec<u8>>,
    per_connection: usize,
    expected_connections: usize,
) -> (u16, Arc<AtomicUsize>, Arc<AtomicUsize>, NodeServer) {
    let connections = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(AtomicUsize::new(0));
    let conns = Arc::clone(&connections);
    let reqs = Arc::clone(&requests);
    let per_conn = std::sync::Mutex::new(std::collections::HashMap::<usize, usize>::new());
    let server = NodeServer::raw("127.0.0.1", move |request| {
        assert!(
            request.connection <= expected_connections,
            "unexpected connection"
        );
        conns.fetch_max(request.connection, Ordering::SeqCst);
        let mut counts = per_conn.lock().unwrap();
        let count = counts.entry(request.connection).or_default();
        *count += 1;
        let close = *count >= per_connection;
        drop(counts);
        let index = reqs.fetch_add(1, Ordering::SeqCst);
        RawResponse {
            bytes: responses[index % responses.len()].clone(),
            close,
        }
    });
    (server.port(), connections, requests, server)
}

#[test]
fn sequential_fetches_reuse_the_job_transport_connection() {
    let (port, connections, requests, server) =
        serve_counted(vec![response("HTTP/1.1 200 OK", &[], b"tile")], 2, 1);
    let transport = transport();
    for _ in 0..2 {
        let outcome = transport
            .fetch(
                &format!("http://127.0.0.1:{port}/tile"),
                &BTreeMap::new(),
                None,
                &limits(),
            )
            .expect("fetch");
        assert_eq!(outcome.body, b"tile");
    }
    server.join().expect("Node server");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[test]
fn http_refusal_returns_once_without_retry() {
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
            &limits(),
        )
        .expect_err("userinfo redirect rejected");
    assert!(matches!(error, Error::BadRedirect { .. }));
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
    // Different loopback hosts retain the original credential-scoping test.
    let hop2_server = NodeServer::raw("127.0.0.2", move |request| {
        hop2_sink.lock().expect("lock").push(request.head);
        response(
            "HTTP/1.1 200 OK",
            &[("content-type", "text/plain")],
            b"final",
        )
        .into()
    });
    let hop2_port = hop2_server.port();
    let hop1_server = NodeServer::raw("127.0.0.1", move |_| {
        response(
            "HTTP/1.1 302 Found",
            &[("location", &format!("http://127.0.0.2:{hop2_port}/final"))],
            b"",
        )
        .into()
    });
    let hop1_port = hop1_server.port();
    let mut headers = BTreeMap::new();
    headers.insert("Cookie".to_string(), "session=abc".to_string());
    headers.insert("Accept".to_string(), "image/png".to_string());
    let user = UserHeaders::new(headers, Some("127.0.0.1".to_string()));
    let outcome = transport()
        .fetch(
            &format!("http://127.0.0.1:{hop1_port}/start"),
            &BTreeMap::new(),
            Some(&user),
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
            &limits(),
        )
        .expect("429 returns as outcome");
    assert_eq!(outcome.status, 429);
    assert_eq!(outcome.retry_after_ms, Some(2000));
    server.join().expect("server exits after one connection");
}
