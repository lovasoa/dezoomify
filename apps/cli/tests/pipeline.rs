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
fn cli_max_width_flag_caps_output() {
    // `--max-width 300` on the 512px pyramid must download the largest
    // fitting level (256px, 1 tile) and hash to the cli-max-width golden.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-max-width");
    let output = out_dir.join("narrow.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--max-width")
        .arg("300")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "cli --max-width should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let golden: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/scenarios/native/cli-max-width/expected/result.json"
        ))
        .expect("read max-width golden"),
    )
    .expect("parse max-width golden");
    let expected_hash = golden
        .get("outputHash")
        .and_then(serde_json::Value::as_str)
        .expect("golden outputHash");
    assert_eq!(sha256_of_file(&output), expected_hash);
}

#[test]
fn cli_forwards_user_headers() {
    // `-H` headers must flow into the pipeline without breaking the fetch:
    // the output still hashes to the cli-dzi golden.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-headers");
    let output = out_dir.join("headers.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("-H")
        .arg("Referer: https://fixtures.test/viewer")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "cli -H should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
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
    assert_eq!(sha256_of_file(&output), expected_hash);
}

fn sha256_of_file(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).expect("open output");
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).expect("read output");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("sha256:{:x}", hasher.finalize())
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

#[test]
fn cli_bulk_saves_each_entry_with_summary() {
    let origin = start_fixture_server();
    let good = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-bulk");
    let list = out_dir.join("list.txt");
    std::fs::write(&list, format!("{good} first\n{good} second\n")).expect("bulk list");
    let base = out_dir.join("collection.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--bulk")
        .arg(&list)
        .arg("--outfile")
        .arg(&base)
        .arg("--overwrite")
        .output()
        .expect("run cli bulk");
    assert!(
        run.status.success(),
        "bulk should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let first = out_dir.join("collection_1.png");
    let second = out_dir.join("collection_2.png");
    assert!(first.exists(), "first bulk output written");
    assert!(second.exists(), "second bulk output written");
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
    assert_eq!(sha256_of_file(&first), expected_hash);
    assert_eq!(sha256_of_file(&second), expected_hash);
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("bulk: 2 succeeded, 0 failed, 2 total"),
        "bulk summary present: {stderr}"
    );
}

#[test]
fn cli_bulk_continues_after_failure() {
    let origin = start_fixture_server();
    let good = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let bad = format!("{origin}/fetch?url=https://fixtures.test/cli/broken.dzi");
    let out_dir = temp_dir("e2e-bulk-partial");
    let list = out_dir.join("list.txt");
    std::fs::write(&list, format!("{good}\n{bad}\n")).expect("bulk list");
    let base = out_dir.join("collection.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--bulk")
        .arg(&list)
        .arg("--outfile")
        .arg(&base)
        .arg("--overwrite")
        .output()
        .expect("run cli bulk");
    assert!(!run.status.success(), "bulk with a failure must exit 1");
    assert!(
        out_dir.join("collection_1.png").exists(),
        "good entry saved"
    );
    assert!(
        !out_dir.join("collection_2.png").exists(),
        "failed entry writes nothing"
    );
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("bulk: 1 succeeded, 1 failed, 2 total"),
        "bulk summary counts the failure: {stderr}"
    );
    assert!(
        stderr.contains("tile.download-failed") || stderr.contains("failed"),
        "per-image failure present: {stderr}"
    );
}

#[test]
fn cli_bulk_json_emits_item_lines() {
    let origin = start_fixture_server();
    let good = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-bulk-json");
    let list = out_dir.join("list.txt");
    std::fs::write(&list, format!("{good}\n")).expect("bulk list");
    let base = out_dir.join("collection.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
        .arg("--bulk")
        .arg(&list)
        .arg("--outfile")
        .arg(&base)
        .arg("--overwrite")
        .output()
        .expect("run cli bulk");
    assert!(run.status.success());
    let stdout = String::from_utf8_lossy(&run.stdout);
    let mut saw_item = false;
    let mut saw_summary = false;
    for line in stdout.lines() {
        let value: serde_json::Value =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("bulk stdout JSON: {line} ({e})"));
        match value.get("kind").and_then(serde_json::Value::as_str) {
            Some("bulk-item") => {
                assert_eq!(
                    value.get("status").and_then(serde_json::Value::as_str),
                    Some("ok")
                );
                saw_item = true;
            }
            Some("bulk-completed") => {
                assert_eq!(
                    value.get("succeeded").and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                saw_summary = true;
            }
            other => panic!("unexpected bulk kind {other:?} in {line}"),
        }
    }
    assert!(saw_item, "bulk-item present: {stdout}");
    assert!(saw_summary, "bulk-completed present: {stdout}");
}

#[test]
fn cli_full_flags_produce_golden_output() {
    // Every wired flag must flow through without breaking the fetch: the
    // output still hashes to the cli-dzi golden. Values are chosen to
    // preserve the largest level (wide caps, out-of-range zoom-level falls
    // back to last, explicit defaults for timing/pooling/compression).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-full-flags");
    let output = out_dir.join("full.png");
    let cache = out_dir.join("tiles");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--header")
        .arg("Referer: https://fixtures.test/viewer")
        .arg("--retries")
        .arg("3")
        .arg("--retry-delay")
        .arg("500ms")
        .arg("--compression")
        .arg("5")
        .arg("--max-idle-per-host")
        .arg("8")
        .arg("--timeout")
        .arg("10s")
        .arg("--connect-timeout")
        .arg("3s")
        .arg("--logging")
        .arg("info")
        .arg("--dezoomer")
        .arg("auto")
        .arg("--parallelism")
        .arg("8")
        .arg("--max-width")
        .arg("10000")
        .arg("--max-height")
        .arg("10000")
        .arg("--zoom-level")
        .arg("100")
        .arg("--largest")
        .arg("--tile-cache")
        .arg(&cache)
        .arg("--image-index")
        .arg("0")
        .arg("--min-interval")
        .arg("1ms")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "full flags should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let stderr = String::from_utf8_lossy(&run.stderr);
    for stale in [
        "needs native support",
        "quality 92",
        "60s timeout",
        "15s connect",
        "first catalog",
        "per-tile throttling needs",
        "width-only",
        "automatic level",
        "6 concurrent",
        "engine defaults",
        "ignoring the height",
    ] {
        assert!(
            !stderr.contains(stale),
            "wired flags must not warn with stale gap text {stale:?}: {stderr}"
        );
    }
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
    assert_eq!(sha256_of_file(&output), expected_hash);
    assert!(cache.exists(), "tile cache folder created");
}

#[test]
fn cli_selection_gaps_are_real_no_warnings() {
    // `--dezoomer <named>`, `--logging <non-info>`, and `--retries 0` are
    // real: validated/passed through with zero warnings. The fetch still
    // succeeds and hashes to the cli-dzi golden.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-no-fallback-warnings");
    let output = out_dir.join("real.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--dezoomer")
        .arg("iiif")
        .arg("--logging")
        .arg("debug")
        .arg("--retries")
        .arg("0")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "real flags should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        !stderr.contains("warning:"),
        "zero warnings for owned items: {stderr}"
    );
    assert!(
        !stderr.contains("auto-detecting instead"),
        "dezoomer no longer falls back with a warning: {stderr}"
    );
    assert!(
        !stderr.contains("no refetch"),
        "retries 0 no longer emulates with a warning: {stderr}"
    );
    assert!(
        !stderr.contains("verbosity is fixed"),
        "logging no longer warns fixed verbosity: {stderr}"
    );
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
    assert_eq!(sha256_of_file(&output), expected_hash);
}

#[test]
fn cli_logging_levels_control_human_verbosity() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    // error suppresses success lines; info shows them; debug adds diagnostics;
    // trace adds full payloads. Machine JSON stays untouched (see next test).
    let out_error = temp_dir("e2e-log-error");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--logging")
        .arg("error")
        .arg("--overwrite")
        .arg(&input)
        .arg(out_error.join("out.png"))
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        !stderr.contains("saved"),
        "--logging error suppresses success lines: {stderr}"
    );
    assert!(!stderr.contains("warning:"), "no warnings: {stderr}");

    let out_info = temp_dir("e2e-log-info");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--logging")
        .arg("info")
        .arg("--overwrite")
        .arg(&input)
        .arg(out_info.join("out.png"))
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("saved"), "info shows success: {stderr}");
    assert!(
        !stderr.contains("debug "),
        "info has no debug diagnostics: {stderr}"
    );

    let out_debug = temp_dir("e2e-log-debug");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--logging")
        .arg("debug")
        .arg("--overwrite")
        .arg(&input)
        .arg(out_debug.join("out.png"))
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("saved"), "debug shows success: {stderr}");
    assert!(
        stderr.contains("debug "),
        "debug adds diagnostics: {stderr}"
    );

    let out_trace = temp_dir("e2e-log-trace");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--logging")
        .arg("trace")
        .arg("--overwrite")
        .arg(&input)
        .arg(out_trace.join("out.png"))
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("saved"), "trace shows success: {stderr}");
    assert!(stderr.contains("debug "), "trace keeps debug: {stderr}");
    assert!(stderr.contains("trace "), "trace adds payloads: {stderr}");
}

#[test]
fn cli_logging_does_not_touch_json_contract() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-log-json");
    let output = out_dir.join("out.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
        .arg("--logging")
        .arg("debug")
        .arg("--overwrite")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(run.status.success());
    let stdout = String::from_utf8_lossy(&run.stdout);
    let mut saw_completed = false;
    for line in stdout.lines() {
        let value: serde_json::Value =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("stdout JSON: {line} ({e})"));
        assert!(
            !value.to_string().contains("debug "),
            "machine JSON never carries human diagnostics: {line}"
        );
        if value.get("kind").and_then(serde_json::Value::as_str) == Some("completed") {
            saw_completed = true;
        }
    }
    assert!(saw_completed, "completed present: {stdout}");
}

#[test]
fn cli_invalid_logging_fails_with_typed_error() {
    let out_dir = temp_dir("e2e-log-invalid");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--logging")
        .arg("verbose")
        .arg("https://fixtures.test/cli/pyramid.dzi")
        .arg(out_dir.join("out.png"))
        .output()
        .expect("run cli");
    assert_eq!(run.status.code(), Some(2), "invalid logging must exit 2");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("invalid --logging value"),
        "typed error: {stderr}"
    );
    assert!(
        String::from_utf8_lossy(&run.stdout).is_empty(),
        "arg error must not pollute stdout"
    );
}

#[test]
fn cli_unknown_dezoomer_fails_with_typed_error() {
    let out_dir = temp_dir("e2e-unknown-dezoomer");
    let output = out_dir.join("out.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--dezoomer")
        .arg("nope")
        .arg("https://fixtures.test/cli/pyramid.dzi")
        .arg(&output)
        .output()
        .expect("run cli");
    assert_eq!(run.status.code(), Some(2), "unknown dezoomer must exit 2");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("unknown dezoomer 'nope'"),
        "typed error: {stderr}"
    );
    assert!(
        String::from_utf8_lossy(&run.stdout).is_empty(),
        "arg error must not pollute stdout"
    );
}

#[test]
fn cli_auto_names_output_when_omitted() {
    // Single runs without an output auto-name to `dezoomified.png` in the
    // working directory; the bytes still hash to the cli-dzi golden.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-auto-name");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg(&input)
        .current_dir(&out_dir)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "auto-naming should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let output = out_dir.join("dezoomified.png");
    assert!(output.exists(), "auto-named output written");
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
    assert_eq!(sha256_of_file(&output), expected_hash);
}

#[test]
fn cli_auto_naming_avoids_collision() {
    // An existing `dezoomified.png` forces a `_0001` suffix, never overwrite.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-auto-collision");
    std::fs::write(out_dir.join("dezoomified.png"), b"existing").expect("seed collision");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg(&input)
        .current_dir(&out_dir)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "collision run should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let output = out_dir.join("dezoomified_0001.png");
    assert!(output.exists(), "collision suffix written");
    assert_eq!(
        std::fs::read(out_dir.join("dezoomified.png")).expect("seed intact"),
        b"existing"
    );
}
