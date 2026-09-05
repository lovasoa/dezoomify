//! End-to-end CLI test: the real binary discovers, downloads, assembles, and
//! writes a real output file over loopback sockets (fixture-server scenarios).

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use dezoomify_fixture_server::{router, AppState, RouteTable};

fn start_fixture_server() -> String {
    let scenarios_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios");
    let routes = RouteTable::load(&scenarios_dir).expect("load routes");
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _guard = rt.enter();
    let listener = rt
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind loopback");
    let bound = listener.local_addr().expect("addr");
    let state = AppState {
        routes: Arc::new(routes),
        scenarios_dir,
        static_dir: None,
        origin: format!("http://{bound}"),
        log: Arc::new(Mutex::new(Vec::new())),
        log_path: None,
    };
    tokio::spawn(async move {
        axum::serve(listener, router(state))
            .await
            .expect("fixture server");
    });
    std::mem::forget(rt);
    format!("http://{bound}")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dezoomify-cli-e2e-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn cli_downloads_and_saves_real_output() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e");
    let output = out_dir.join("pyramid.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg(&input)
        .arg(&output)
        .env("RUST_LOG", "error")
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "cli should succeed: stderr={:?} stdout={:?}",
        String::from_utf8_lossy(&run.stderr),
        String::from_utf8_lossy(&run.stdout),
    );
    assert!(output.exists(), "output written");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("saved"), "human progress present: {stderr}");
}

#[test]
fn cli_fails_honestly_on_missing_tiles() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/broken.dzi");
    let out_dir = temp_dir("e2e-failure");
    let output = out_dir.join("broken.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(!run.status.success(), "cli must fail on tile errors");
    assert!(!output.exists(), "no output on failure");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("tile.download-failed"),
        "honest code: {stderr}"
    );
}

#[test]
fn json_mode_emits_machine_events() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-json");
    let output = out_dir.join("pyramid.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stdout = String::from_utf8_lossy(&run.stdout);
    // Machine output must be line-delimited JSON events with honest shapes.
    let mut saw_started = false;
    let mut completed_hash: Option<String> = None;
    let mut last_seq: u64 = 0;
    for line in stdout.lines() {
        let value: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("every stdout line is JSON: {line} ({e})"));
        let seq = value
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .expect("event carries seq");
        assert!(
            seq > last_seq,
            "seq strictly increases ({seq} after {last_seq})"
        );
        last_seq = seq;
        let kind = value
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        if kind == "started" {
            saw_started = true;
        }
        if kind == "completed" {
            let hash = value
                .get("outputHash")
                .and_then(serde_json::Value::as_str)
                .expect("completed event carries outputHash")
                .to_string();
            completed_hash = Some(hash);
        }
    }
    assert!(saw_started, "started event present: {stdout}");
    // The digest must equal the pinned scenario expectation, not merely exist.
    let golden: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/scenarios/native/cli-dzi/expected/result.json"
        ))
        .expect("read scenario golden"),
    )
    .expect("parse scenario golden");
    let expected_hash = golden
        .get("outputHash")
        .and_then(serde_json::Value::as_str)
        .expect("golden outputHash");
    assert_eq!(
        completed_hash.as_deref(),
        Some(expected_hash),
        "cli --json outputHash must match the pinned scenario digest"
    );
    // And the bytes on disk must hash to the same digest.
    use std::io::Read as _;
    let mut file = std::fs::File::open(&output).expect("open output");
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).expect("read output");
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("sha256:{:x}", hasher.finalize())
    };
    assert_eq!(
        digest, expected_hash,
        "written file hashes to the pinned digest"
    );
}
