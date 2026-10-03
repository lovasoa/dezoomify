//! Fixture isolation: local files, exact diagnostics, and no network fallback.

mod common;

use common::TestServer;

#[tokio::test]
async fn application_assets_are_served_unchanged() {
    let (srv, dir) = TestServer::start_with_static_dir().await;
    let res = reqwest::get(format!("{}/", srv.base)).await.expect("index");
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains("static-index"));
    let res = reqwest::get(format!("{}/app.wasm", srv.base))
        .await
        .expect("asset");
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/wasm"
    );
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"\0asm\xff{{origin}}");
    #[cfg(unix)]
    {
        let res = reqwest::get(format!("{}/escape.txt", srv.base))
            .await
            .expect("escaping symlink");
        assert_eq!(res.status(), 500);
        assert!(res.text().await.unwrap().contains("outside"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unmapped_urls_never_reach_the_network() {
    let srv = TestServer::start().await;
    for host in ["example.com", "8.8.8.8", "169.254.169.254"] {
        let url = format!("http://{host}/");
        let res = reqwest::Client::new()
            .get(format!("{}/fetch", srv.base))
            .query(&[("url", &url)])
            .send()
            .await
            .expect("missing recording");
        assert_eq!(res.status(), 404);
        assert_eq!(res.text().await.unwrap(), format!("No fixture for {url}"));
    }
}

#[tokio::test]
async fn missing_urls_are_preserved_without_reflecting_headers() {
    let srv = TestServer::start().await;
    let target = "https://fixtures.test/private/item?apiKey=CANARY-KEY-123&token=CANARY-TOKEN-456&view={{origin}}";
    let res = reqwest::Client::new()
        .get(format!("{}/fetch", srv.base))
        .query(&[("url", target)])
        .header("cookie", "session=secret-canary")
        .header("authorization", "Bearer secret-canary")
        .send()
        .await
        .expect("missing recording");
    assert_eq!(res.status(), 404);
    assert!(res.headers().get("set-cookie").is_none());
    let body = res.text().await.unwrap();
    assert_eq!(body, format!("No fixture for {target}"));
    assert!(!body.contains("secret-canary"));
    let log = srv.log_text();
    assert!(log.contains(target));
    assert!(!log.contains("secret-canary"));
}

#[tokio::test]
async fn malformed_replay_requests_explain_the_test_error() {
    let srv = TestServer::start().await;
    let res = reqwest::get(format!("{}/fetch", srv.base))
        .await
        .expect("test request");
    assert_eq!(res.status(), 500);
    assert!(res.text().await.unwrap().contains("Invalid URL"));
    let log = srv.log_text();
    assert!(log.contains("/fetch"));
    assert!(log.contains("Invalid URL"));
}
