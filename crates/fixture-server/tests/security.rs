//! Security regression tests: traversal, method, credential, and egress
//! behavior. No public network is contacted; any egress attempt fails the
//! Network-isolation test by construction (no passthrough exists).

mod common;

use common::TestServer;

#[tokio::test]
async fn manifest_exists() {
    let manifest = std::fs::read_to_string(common::TestServer::scenarios_path("manifest.json"))
        .expect("manifest");
    assert!(manifest.contains("\"version\": 1") || manifest.contains("\"version\":1"));
}

#[tokio::test]
async fn traversal_in_original_url_is_rejected() {
    let srv = TestServer::start().await;
    for target in [
        "http://127.0.0.1/../secret",
        "http://127.0.0.1/a/../../b",
        "http://user:pass@127.0.0.1/fixtures/x",
    ] {
        let url = format!("{}/fetch?url={target}", srv.base);
        let res = reqwest::get(&url).await.expect("get");
        assert_eq!(res.status(), 400, "target {target}");
    }
}

#[tokio::test]
async fn static_traversal_is_forbidden() {
    let (srv, dir) = TestServer::start_with_static_dir().await;
    // Legitimate static files are served: the guard is active, not just
    // blanket-404ing a missing static root.
    let res = reqwest::get(format!("{}/secret.txt", srv.base))
        .await
        .expect("get");
    assert_eq!(res.status(), 200, "plain static file must be served");
    assert_eq!(res.bytes().await.expect("body").as_ref(), b"static-canary");
    let res = reqwest::get(format!("{}/sub/page.html", srv.base))
        .await
        .expect("get");
    assert_eq!(res.status(), 200, "nested static file must be served");
    let res = reqwest::get(format!("{}/", srv.base)).await.expect("get");
    assert_eq!(res.status(), 200, "static root must serve index.html");
    assert!(String::from_utf8_lossy(&res.bytes().await.expect("body")).contains("static-index"));

    // Hostile raw-socket requests: dot segments must never escape the static
    // root, in literal or percent-encoded form. Raw sockets avoid the HTTP
    // client resolving dot segments before the request leaves.
    for path in [
        "/sub/../secret.txt",
        "/sub/%2e%2e/secret.txt",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/sub/..%2f..%2fsecret.txt",
        "/..%2f..%2fetc%2fpasswd",
    ] {
        let (status, body) = srv.raw_get(path).await;
        assert_eq!(status, 403, "dot-segment escape {path} must be forbidden");
        assert!(
            !body.contains("static-canary"),
            "dot-segment escape {path} leaked a file outside the static root"
        );
    }
    // A symlink escaping the root is rejected by the canonical-prefix guard.
    #[cfg(unix)]
    {
        let (status, body) = srv.raw_get("/escape.txt").await;
        assert_eq!(status, 403, "symlink escape must be forbidden");
        assert!(!body.contains("static-canary"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn credentials_are_never_reflected() {
    let srv = TestServer::start().await;
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}/fetch?url=https://nope.test/missing", srv.base))
        .header("cookie", "session=secret-canary")
        .header("authorization", "Bearer secret-canary")
        .send()
        .await
        .expect("get");
    assert_eq!(res.status(), 404);
    assert!(res.headers().get("set-cookie").is_none());
    let body = res.text().await.expect("body");
    assert!(!body.contains("secret-canary"));
}

#[tokio::test]
async fn arts_failure_reveals_no_bytes() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=http://127.0.0.1/arts/path=x0-y0-z0-tWRONG",
        srv.base
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 403);
    assert_eq!(res.bytes().await.expect("body").as_ref(), b"fixture error");
}

#[tokio::test]
async fn rejects_unmapped_network() {
    // Deterministic mode has no passthrough: public hosts get fixture-missing,
    // never proxied bytes. A real egress would return 200 with foreign content.
    let srv = TestServer::start().await;
    for host in ["example.com", "8.8.8.8", "169.254.169.254"] {
        let url = format!("{}/fetch?url=http://{host}/", srv.base);
        let res = reqwest::get(&url).await.expect("get");
        assert_eq!(res.status(), 404, "host {host}");
        let v: serde_json::Value = res.json().await.expect("json");
        assert_eq!(v["error"], "fixture-missing");
    }
}

#[tokio::test]
async fn userinfo_never_reaches_logs_or_bodies() {
    let srv = TestServer::start().await;
    let target = "http://canary-user:canary-pass-9@fixtures.test/private/item?view=1";
    let url = format!("{}/fetch?url={target}", srv.base);
    let res = reqwest::get(&url).await.expect("get");
    let body = res.text().await.expect("body");
    assert!(!body.contains("canary-user"), "body leaks userinfo");
    assert!(!body.contains("canary-pass-9"), "body leaks password");
    let log = srv.log_text();
    assert!(!log.contains("canary-user"), "log leaks userinfo");
    assert!(!log.contains("canary-pass-9"), "log leaks password");
}

#[tokio::test]
async fn sensitive_query_values_are_redacted_in_logs_and_bodies() {
    let srv = TestServer::start().await;
    let target =
        "https://fixtures.test/private/item?apiKey=CANARY-KEY-123&token=CANARY-TOKEN-456&view=1";
    let url = format!("{}/fetch?url={target}", srv.base);
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 404);
    let body = res.text().await.expect("body");
    assert!(!body.contains("CANARY-KEY-123"), "body leaks apiKey");
    assert!(!body.contains("CANARY-TOKEN-456"), "body leaks token");
    assert!(body.contains("REDACTED"), "body lacks redaction marker");
    let log = srv.log_text();
    assert!(!log.contains("CANARY-KEY-123"), "log leaks apiKey");
    assert!(!log.contains("CANARY-TOKEN-456"), "log leaks token");
}
