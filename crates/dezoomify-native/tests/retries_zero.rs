//! Retries `0` is real: first failure fails with no refetch.
//! Counts loopback tile requests to prove no second request is sent.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dezoomify_native::pipeline::PipelineConfig;

fn http_response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(format!("HTTP/1.1 {status}\r\n").as_bytes());
    out.extend_from_slice(format!("content-type: {content_type}\r\n").as_bytes());
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

fn scenario_payload(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli")
            .join(name),
    )
    .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
}

const DZI_512: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn serve_counted(
    shared: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let shared = Arc::clone(&shared);
            let counts = Arc::clone(&counts);
            std::thread::spawn(move || {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while head.len() < 8192 {
                    let Ok(n) = stream.read(&mut byte) else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    head.extend_from_slice(&byte);
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let path = String::from_utf8_lossy(&head)
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                counts
                    .lock()
                    .expect("lock")
                    .entry(path.clone())
                    .and_modify(|n| *n += 1)
                    .or_insert(1);
                let body = shared
                    .lock()
                    .expect("lock")
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| http_response("404 Not Found", "text/plain", b"not found"));
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-retries-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn setup_three_of_four() -> (String, Arc<Mutex<HashMap<String, usize>>>) {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // `/pyr_files/9/1_1.png` stays absent (404).
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    (base, counts)
}

#[test]
fn retries_zero_sends_no_second_request() {
    let (base, counts) = setup_three_of_four();
    let input = format!("{base}/pyr.dzi");
    let out_dir = temp_dir("zero");
    let output = out_dir.join("zero.png");
    let config = PipelineConfig {
        max_retries: 0,
        ..Default::default()
    };
    let error = dezoomify_native::pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_| {},
    )
    .expect_err("missing tile fails");
    assert_eq!(error.code, "tile.download-failed");
    assert!(!output.exists());
    let counts = counts.lock().expect("lock");
    // Each of the four tiles is requested exactly once; the missing tile
    // is never refetched.
    for tile in ["0_0", "1_0", "0_1", "1_1"] {
        let path = format!("/pyr_files/9/{tile}.png");
        assert_eq!(
            counts.get(&path).copied().unwrap_or(0),
            1,
            "tile {tile} requested exactly once with retries=0: {counts:?}"
        );
    }
}

#[test]
fn retries_one_refetches_the_missing_tile() {
    let (base, counts) = setup_three_of_four();
    let input = format!("{base}/pyr.dzi");
    let out_dir = temp_dir("one");
    let output = out_dir.join("one.png");
    let config = PipelineConfig {
        max_retries: 1,
        ..Default::default()
    };
    let error = dezoomify_native::pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_| {},
    )
    .expect_err("missing tile still fails after one retry");
    assert_eq!(error.code, "tile.download-failed");
    let counts = counts.lock().expect("lock");
    // Good tiles are requested once; the missing tile is retried once.
    for tile in ["0_0", "1_0", "0_1"] {
        let path = format!("/pyr_files/9/{tile}.png");
        assert_eq!(
            counts.get(&path).copied().unwrap_or(0),
            1,
            "good tile {tile} requested once: {counts:?}"
        );
    }
    assert_eq!(
        counts.get("/pyr_files/9/1_1.png").copied().unwrap_or(0),
        2,
        "missing tile retried once with retries=1: {counts:?}"
    );
}
