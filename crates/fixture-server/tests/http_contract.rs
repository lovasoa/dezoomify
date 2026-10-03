//! HTTP fixture tests: file conventions, HEAD, templating, local handlers,
//! authentication, Arts signing, and deterministic
//! startup. Node owns ephemeral loopback ports; its readiness notification
//! and address file are emitted only after listening.

mod common;

use common::TestServer;
use dezoomify_fixture_server::replay_url;

#[tokio::test]
async fn layout_convention_serves_payloads_without_routes() {
    // Files at `payloads/{host}{path}` serve at `{host}{path}` with an inferred
    // type. No registration is required.
    let srv = TestServer::start().await;
    let url = replay_url(&srv.base, "https://fixtures.test/cli/pyramid.dzi");
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/xml",
        "the layout convention infers the fixture xml type"
    );
    let expected = std::fs::read(TestServer::scenarios_path(
        "native/cli-dzi/payloads/fixtures.test/cli/pyramid.dzi",
    ))
    .expect("payload");
    assert_eq!(
        res.bytes().await.expect("body").as_ref(),
        expected.as_slice()
    );
}

#[tokio::test]
async fn metadata_file_beats_tile_fallback() {
    // The synthetic IIIF tile handler yields to the actual metadata file.
    let srv = TestServer::start().await;
    let url = replay_url(
        &srv.base,
        "http://127.0.0.1/fixtures/iiif-private-id/info.json",
    );
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/json"
    );
    let expected = std::fs::read(TestServer::scenarios_path(
        "web/iiif-discovery/payloads/127.0.0.1/fixtures/iiif-private-id/info.json",
    ))
    .expect("payload");
    assert_eq!(
        res.bytes().await.expect("body").as_ref(),
        expected.as_slice()
    );
}

#[tokio::test]
async fn static_payload_exact_bytes_and_headers() {
    let srv = TestServer::start().await;
    let url = replay_url(
        &srv.base,
        "https://fixtures.test/zoomify/ImageProperties.xml",
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
async fn protected_routes_require_a_session_without_logging_its_value() {
    let srv = TestServer::start().await;
    let viewer = reqwest::get(format!("{}/target.html?scenario=cookie-session", srv.base))
        .await
        .expect("viewer");
    assert_eq!(viewer.status(), 200);
    assert_eq!(
        viewer.headers().get("set-cookie").unwrap(),
        "fixture_session=extension-e2e; Path=/; HttpOnly; SameSite=Lax"
    );

    let metadata = format!("{}/protected/artwork.dzi", srv.base);
    let denied = reqwest::get(&metadata)
        .await
        .expect("unauthenticated metadata");
    assert_eq!(denied.status(), 403);
    assert_eq!(
        denied.text().await.expect("denial body"),
        "fixture auth required: missing cookie fixture_session"
    );
    let allowed = reqwest::Client::new()
        .get(&metadata)
        .header("cookie", "fixture_session=extension-e2e")
        .header(
            "referer",
            format!("{}/target.html?scenario=cookie-session", srv.base),
        )
        .send()
        .await
        .expect("authenticated metadata");
    assert_eq!(allowed.status(), 200);

    let tile = format!("{}/protected/artwork_files/9/0_0.png", srv.base);
    let denied = reqwest::get(&tile).await.expect("unauthenticated tile");
    assert_eq!(denied.status(), 403);
    // A static backing file cannot bypass the handler's directory protection.
    let denied = reqwest::get(format!("{}/protected/tile-0_0.png", srv.base))
        .await
        .expect("unauthenticated backing file");
    assert_eq!(denied.status(), 403);
    let allowed = reqwest::Client::new()
        .get(tile)
        .header("cookie", "fixture_session=extension-e2e")
        .header(
            "referer",
            format!("{}/target.html?scenario=cookie-session", srv.base),
        )
        .send()
        .await
        .expect("authenticated tile");
    assert_eq!(allowed.status(), 200);

    let wrong_context = reqwest::Client::new()
        .get(&metadata)
        .header("cookie", "fixture_session=extension-e2e")
        .header("referer", "moz-extension://job/job.html")
        .send()
        .await
        .unwrap();
    assert_eq!(
        wrong_context.status(),
        403,
        "cookies alone do not satisfy the page context"
    );

    let log = srv.log_text();
    let events: Vec<serde_json::Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).expect("request event"))
        .collect();
    assert!(events
        .iter()
        .any(|event| event["path"] == "/protected/artwork.dzi" && event["status"] == 403));
    assert!(
        !log.contains("extension-e2e"),
        "cookie values stay out of fixture logs"
    );
}

#[tokio::test]
async fn templating_substitutes_origin() {
    let srv = TestServer::start().await;
    let url = replay_url(&srv.base, "https://fixtures.test/topviewer/data.json");
    let body = reqwest::get(&url)
        .await
        .expect("get")
        .text()
        .await
        .expect("text");
    assert!(!body.contains("{{origin}}"), "template left unsubstituted");
    assert!(body.contains(&srv.base), "origin not injected");
    assert!(
        !body.contains("{{localhost_origin}}"),
        "localhost origin template left unsubstituted"
    );
}

#[tokio::test]
async fn templating_substitutes_loopback_alias() {
    let srv = TestServer::start().await;
    let url = replay_url(&srv.base, "https://fixtures.test/cli/permission-tiles.yaml");
    let body = reqwest::get(&url)
        .await
        .expect("get")
        .text()
        .await
        .expect("text");
    let localhost = srv.base.replacen("127.0.0.1", "localhost", 1);
    assert!(
        !body.contains("{{localhost_origin}}"),
        "template left unsubstituted"
    );
    assert!(body.contains(&localhost), "localhost origin not injected");
}

#[tokio::test]
async fn head_returns_headers_without_body() {
    let srv = TestServer::start().await;
    let url = replay_url(
        &srv.base,
        "https://fixtures.test/zoomify/ImageProperties.xml",
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
async fn generic_probe_success_and_missing() {
    let srv = TestServer::start().await;
    let ok = replay_url(
        &srv.base,
        "http://127.0.0.1/fixtures/generic/padded.svg?x=0&y=0",
    );
    let res = reqwest::get(&ok).await.expect("get");
    assert_eq!(res.status(), 200);
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("svg"));
    let miss = replay_url(
        &srv.base,
        "http://127.0.0.1/fixtures/generic/padded.svg?x=9&y=9",
    );
    let res = reqwest::get(&miss).await.expect("get");
    assert_eq!(res.status(), 404);
    assert_eq!(res.text().await.unwrap(), "fixture error");
    // A handler's 404 finishes a direct request too; it must not fall through.
    let res = reqwest::get(format!("{}/fixtures/generic/padded.svg?x=9&y=9", srv.base))
        .await
        .expect("direct missing tile");
    assert_eq!(res.status(), 404);
    assert_eq!(res.text().await.unwrap(), "fixture error");
}

#[tokio::test]
async fn compressed_metadata_is_sent_without_text_substitution() {
    let srv = TestServer::start().await;
    let res = reqwest::get(replay_url(
        &srv.base,
        "https://fixtures.test/edge/gzip-cache/pyramid.dzi",
    ))
    .await
    .expect("compressed metadata");
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers().get("content-encoding").unwrap(), "gzip");
    // This client's gzip feature is disabled, so compare the exact wire bytes.
    let expected = std::fs::read(TestServer::scenarios_path(
        "native/edge-gzip-cache/payloads/fixtures.test/edge/gzip-cache/pyramid.dzi.gz",
    ))
    .expect("plain metadata");
    assert_eq!(
        res.bytes().await.expect("gzip body").as_ref(),
        expected.as_slice()
    );
}

#[tokio::test]
async fn assembly_tile_valid_and_invalid() {
    let srv = TestServer::start().await;
    let ok = replay_url(
        &srv.base,
        "http://127.0.0.1/fixtures/assembly/tile.svg?w=256&h=256&color=ff0000",
    );
    let res = reqwest::get(&ok).await.expect("get");
    assert_eq!(res.status(), 200);
    let bad = replay_url(
        &srv.base,
        "http://127.0.0.1/fixtures/assembly/tile.svg?w=0&h=256&color=red",
    );
    let res = reqwest::get(&bad).await.expect("get");
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn arts_wrong_signature_is_forbidden() {
    let srv = TestServer::start().await;
    let url = replay_url(&srv.base, "http://127.0.0.1/arts/path=x0-y0-z0-tWRONG");
    let res = reqwest::get(&url).await.expect("get");
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn arts_plain_tile_decrypts() {
    let srv = TestServer::start().await;
    let sig = arts_signature(0, 0, 0);
    let url = replay_url(
        &srv.base,
        &format!("http://127.0.0.1/arts/plain=x0-y0-z0-t{sig}"),
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
async fn startup_writes_address_after_listening() {
    let dir = std::env::temp_dir().join(format!("dz-addr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let addr_file = dir.join("server.addr");
    let mut child = std::process::Command::new("node")
        .arg(dezoomify_fixture_server::server_script())
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
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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
