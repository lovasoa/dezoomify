//! HTTP contract tests: exact method/status/headers/body, HEAD semantics,
//! templating, generators, Arts signing, traversal rejection, and deterministic
//! startup. Ephemeral loopback ports only; in-process servers need no
//! readiness sleep (the bound address implies listening); the one spawned
//! subprocess test polls its address file with a bounded budget.

mod common;

use common::TestServer;

#[tokio::test]
async fn static_payload_exact_bytes_and_headers() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=https://fixtures.test/zoomify/ImageProperties.xml",
        srv.base
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
    let body = res.bytes().await.expect("body");
    let expected = std::fs::read(common::TestServer::scenarios_path(
        "web/core-discovery/payloads/fixtures.test/zoomify/ImageProperties.xml",
    ))
    .expect("payload");
    assert_eq!(body.as_ref(), expected.as_slice());
}

#[tokio::test]
async fn templating_substitutes_origin() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=https://fixtures.test/topviewer/data.json",
        srv.base
    );
    let body = reqwest::get(&url)
        .await
        .expect("get")
        .text()
        .await
        .expect("text");
    assert!(!body.contains("{{origin}}"), "template left unsubstituted");
    assert!(body.contains(&srv.base), "origin not injected");
}

#[tokio::test]
async fn unknown_resource_is_stable_fixture_missing() {
    let srv = TestServer::start().await;
    let url = format!("{}/fetch?url=https://nope.test/missing.xml", srv.base);
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 404);
    let v: serde_json::Value = res.json().await.expect("json");
    assert_eq!(v["error"], "fixture-missing");
}

#[tokio::test]
async fn head_returns_headers_without_body() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=https://fixtures.test/zoomify/ImageProperties.xml",
        srv.base
    );
    let res = reqwest::Client::new()
        .head(&url)
        .send()
        .await
        .expect("head");
    assert_eq!(res.status(), 200);
    assert!(res.bytes().await.expect("body").is_empty());
}

#[tokio::test]
async fn unsupported_method_is_rejected() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=https://fixtures.test/zoomify/ImageProperties.xml",
        srv.base
    );
    let res = reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .expect("post");
    assert_eq!(res.status(), 405);
}

#[tokio::test]
async fn generic_probe_success_and_missing() {
    let srv = TestServer::start().await;
    let ok = format!(
        "{}/fetch?url=http://127.0.0.1/fixtures/generic/padded.svg?x=0%26y=0",
        srv.base
    );
    // Note: query params must be URL-encoded through /fetch.
    let res = reqwest::get(&ok).await.expect("get");
    assert_eq!(res.status(), 200);
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("svg"));
    let miss = format!(
        "{}/fetch?url=http://127.0.0.1/fixtures/generic/padded.svg?x=9%26y=9",
        srv.base
    );
    let res = reqwest::get(&miss).await.expect("get");
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn assembly_tile_valid_and_invalid() {
    let srv = TestServer::start().await;
    let ok = format!(
        "{}/fetch?url=http://127.0.0.1/fixtures/assembly/tile.svg?w=256%26h=256%26color=ff0000",
        srv.base
    );
    let res = reqwest::get(&ok).await.expect("get");
    assert_eq!(res.status(), 200);
    let bad = format!(
        "{}/fetch?url=http://127.0.0.1/fixtures/assembly/tile.svg?w=0%26h=256%26color=red",
        srv.base
    );
    let res = reqwest::get(&bad).await.expect("get");
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn arts_wrong_signature_is_forbidden() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/fetch?url=http://127.0.0.1/arts/path=x0-y0-z0-tWRONG",
        srv.base
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn arts_plain_tile_decrypts() {
    let srv = TestServer::start().await;
    let sig = arts_signature(0, 0, 0);
    let url = format!(
        "{}/fetch?url=http://127.0.0.1/arts/plain=x0-y0-z0-t{sig}",
        srv.base
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.expect("body").as_ref(), b"plain-tile");
}

fn hex_key() -> [u8; 8] {
    [0x7b, 0x2b, 0x4e, 0x23, 0xde, 0x2c, 0xc5, 0xc5]
}

fn arts_signature(x: u32, y: u32, z: u32) -> String {
    use hmac::{Hmac, KeyInit, Mac};
    use sha1::Sha1;
    let signed = format!("arts/plain=x{x}-y{y}-z{z}-tsample-token");
    let mut mac = Hmac::<Sha1>::new_from_slice(&hex_key()).expect("hmac");
    mac.update(signed.as_bytes());
    let digest = mac.finalize().into_bytes();
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789__";
    let mut out = String::new();
    for chunk in digest.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

#[tokio::test]
async fn proxy_branch_serves_fixtures() {
    let srv = TestServer::start().await;
    let url = format!(
        "{}/proxy?url=https://fixtures.test/zoomify/ImageProperties.xml",
        srv.base
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 200);
    let missing = format!("{}/proxy", srv.base);
    let res = reqwest::get(&missing).await.expect("get");
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn startup_writes_address_after_listening() {
    let dir = std::env::temp_dir().join(format!("dz-addr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let addr_file = dir.join("server.addr");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-fixture-server"))
        .args([
            "--port",
            "0",
            "--write-address",
            addr_file.to_str().expect("utf8"),
            "--scenarios-dir",
            common::TestServer::scenarios_path("")
                .to_str()
                .expect("utf8"),
        ])
        .spawn()
        .expect("spawn");
    let mut bound = String::new();
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(&addr_file) {
            if !text.trim().is_empty() {
                bound = text;
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        !bound.is_empty(),
        "address file was never written within the poll budget; the server \
         likely failed to start"
    );
    assert!(bound.starts_with("127.0.0.1:"), "loopback address file");
    // Address file implies readiness: connect immediately with no extra sleep.
    let res = reqwest::get(format!(
        "http://{}/fetch?url=https://nope.test/x",
        bound.trim()
    ))
    .await
    .expect("connect");
    assert_eq!(res.status(), 404);
    child.kill().expect("kill");
    child.wait().expect("wait");
    std::fs::remove_dir_all(&dir).ok();
}
