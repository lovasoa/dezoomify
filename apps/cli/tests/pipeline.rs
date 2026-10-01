//! End-to-end CLI test: the real binary discovers, downloads, assembles, and
//! writes a real output file over loopback sockets (fixture-server scenarios).

use std::path::Path;
use std::process::Command;

use dezoomify_fixture_server::{scenario_input, start as start_fixture_server, temp_dir};

/// Map the CLI's completion event and written bytes into the shared golden
/// comparison; PNG probes stay here, golden comparison stays in the corpus.
fn assert_result_golden(entry: &serde_json::Value, stdout: &str, output: &Path) {
    let scenario = entry["id"].as_str().expect("scenario id");
    let expected = &entry["expected"];
    let completed = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .rfind(|event| {
            matches!(
                event["kind"].as_str(),
                Some("completed") | Some("partial-completed")
            )
        })
        .unwrap_or_else(|| panic!("{scenario}: completed event present in stdout: {stdout}"));
    // The produced file is really a PNG at the golden size.
    let bytes = std::fs::read(output).expect("output file written");
    assert!(
        bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "{scenario} output is a PNG"
    );
    let pixels = |range: std::ops::Range<usize>| {
        u32::from_be_bytes(bytes[range].try_into().expect("4 bytes")) as u64
    };
    assert_eq!(
        pixels(16..20),
        expected["imageSize"]["x"].as_u64().expect("golden width"),
        "{scenario} PNG width"
    );
    assert_eq!(
        pixels(20..24),
        expected["imageSize"]["y"].as_u64().expect("golden height"),
        "{scenario} PNG height"
    );
    if let Some(partial) = expected.get("partial") {
        assert_eq!(&completed["partial"], partial, "{scenario} partial flag");
        assert_eq!(
            completed["kind"].as_str(),
            Some("partial-completed"),
            "{scenario} partial completion event"
        );
    }
    if expected.get("code") == Some(&serde_json::json!("ok")) {
        assert_eq!(
            completed["kind"].as_str(),
            Some("completed"),
            "{scenario} complete completion event"
        );
    }
    dezoomify_fixture_server::assert_result_golden(
        entry,
        dezoomify_fixture_server::GoldenResult {
            image_size: (
                completed["width"].as_u64().expect("event width"),
                completed["height"].as_u64().expect("event height"),
            ),
            tile_count: completed["tileCount"].as_u64().expect("event tile count"),
            output_format: "png".to_string(),
            partial: completed["partial"].as_bool().unwrap_or(false),
        },
    );
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
    // `--no-partial` discards on tile failure: no output, exit 1.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/broken.dzi");
    let out_dir = temp_dir("e2e-failure");
    let output = out_dir.join("broken.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--no-partial")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(!run.status.success(), "cli must fail on tile errors");
    assert!(!output.exists(), "no output on failure");
    let stderr = String::from_utf8_lossy(&run.stderr);
    let golden = dezoomify_fixture_server::scenario("native/cli-tile-failure");
    let code = golden["expected"]["code"].as_str().expect("golden code");
    assert!(stderr.contains(code), "honest code {code:?}: {stderr}");
}

#[test]
fn cli_max_width_flag_caps_output() {
    // `--max-width 300` selects the 256x256 level (`native/cli-max-width`).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-max-width");
    let output = out_dir.join("narrow.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
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
    assert_result_golden(
        &dezoomify_fixture_server::scenario("native/cli-max-width"),
        &String::from_utf8_lossy(&run.stdout),
        &output,
    );
}

#[test]
fn cli_forwards_user_headers() {
    // `-H` headers flow through without breaking the fetch (`native/cli-dzi`).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-headers");
    let output = out_dir.join("headers.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
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
    assert_result_golden(
        &dezoomify_fixture_server::scenario("native/cli-dzi"),
        &String::from_utf8_lossy(&run.stdout),
        &output,
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
    }
    assert!(saw_started, "started event present: {stdout}");
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

    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("bulk: 2 succeeded, 0 failed, 2 total"),
        "bulk summary present: {stderr}"
    );
}

#[test]
fn cli_bulk_continues_after_failure() {
    // `--no-partial` bulk: good entry saves, broken entry writes nothing.
    let origin = start_fixture_server();
    let good = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let bad = format!("{origin}/fetch?url=https://fixtures.test/cli/broken.dzi");
    let out_dir = temp_dir("e2e-bulk-partial");
    let list = out_dir.join("list.txt");
    std::fs::write(&list, format!("{good}\n{bad}\n")).expect("bulk list");
    let base = out_dir.join("collection.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--no-partial")
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
    // Every wired flag flows through without breaking the fetch (`native/cli-dzi`);
    // values preserve the largest level (wide caps, out-of-range zoom falls back).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-full-flags");
    let output = out_dir.join("full.png");
    let cache = out_dir.join("tiles");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
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
        .arg("--format")
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
        .arg("--keep-partial")
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
        "native defaults",
        "ignoring the height",
    ] {
        assert!(
            !stderr.contains(stale),
            "wired flags must not warn with stale gap text {stale:?}: {stderr}"
        );
    }

    assert!(cache.exists(), "tile cache folder created");
    assert_result_golden(
        &dezoomify_fixture_server::scenario("native/cli-dzi"),
        &String::from_utf8_lossy(&run.stdout),
        &output,
    );
}

#[test]
fn cli_selection_gaps_are_real_no_warnings() {
    // `--format`, `--logging`, `--retries 0` validate and pass through
    // with zero warnings (`native/cli-dzi`).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-no-fallback-warnings");
    let output = out_dir.join("real.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
        .arg("--format")
        .arg("deepzoom")
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
        "format no longer falls back with a warning: {stderr}"
    );
    assert!(
        !stderr.contains("no refetch"),
        "retries 0 no longer emulates with a warning: {stderr}"
    );
    assert!(
        !stderr.contains("verbosity is fixed"),
        "logging no longer warns fixed verbosity: {stderr}"
    );
    assert_result_golden(
        &dezoomify_fixture_server::scenario("native/cli-dzi"),
        &String::from_utf8_lossy(&run.stdout),
        &output,
    );
}

#[test]
fn cli_logging_levels_control_human_verbosity() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    // error hides success lines; info shows; debug adds diagnostics; trace adds tiles.
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
        !stderr.contains("\"purpose\":\"metadata\""),
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
        stderr.contains("\"purpose\":\"metadata\""),
        "debug adds diagnostics: {stderr}"
    );

    let out_trace = temp_dir("e2e-log-trace");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--tile-cache")
        .arg(out_trace.join("cache"))
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
    assert!(
        stderr.contains("\"purpose\":\"metadata\""),
        "trace keeps discovery: {stderr}"
    );
    assert!(
        stderr.contains("\"purpose\":\"tile\""),
        "trace adds tile requests: {stderr}"
    );
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
fn cli_unknown_format_fails_with_typed_error() {
    let out_dir = temp_dir("e2e-unknown-format");
    let output = out_dir.join("out.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--format")
        .arg("nope")
        .arg("https://fixtures.test/cli/pyramid.dzi")
        .arg(&output)
        .output()
        .expect("run cli");
    assert_eq!(run.status.code(), Some(2), "unknown format must exit 2");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("unknown format 'nope'"),
        "typed error: {stderr}"
    );
    assert!(
        String::from_utf8_lossy(&run.stdout).is_empty(),
        "arg error must not pollute stdout"
    );
}

#[test]
fn cli_auto_names_output_when_omitted() {
    // Single runs without an output auto-name to `dezoomify.png` (`native/cli-dzi`).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-auto-name");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--json")
        .arg(&input)
        .current_dir(&out_dir)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "auto-naming should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    let output = out_dir.join("dezoomify.png");
    assert!(output.exists(), "auto-named output written");
    assert_result_golden(
        &dezoomify_fixture_server::scenario("native/cli-dzi"),
        &String::from_utf8_lossy(&run.stdout),
        &output,
    );
}

#[test]
fn cli_auto_naming_avoids_collision() {
    // An existing `dezoomify.png` forces a `_0001` suffix, never overwrite.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-auto-collision");
    std::fs::write(out_dir.join("dezoomify.png"), b"existing").expect("seed collision");
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
    let output = out_dir.join("dezoomify_0001.png");
    assert!(output.exists(), "collision suffix written");
    assert_eq!(
        std::fs::read(out_dir.join("dezoomify.png")).expect("seed intact"),
        b"existing"
    );
}

#[test]
fn cli_keep_partial_default_keeps_output() {
    // Default `Keep`: corrupt tiles keep a real PNG partial (blank-region
    // pixels live in native `partial_keep_policy_encodes_acquired_tiles`).
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/corrupt.dzi");
    let out_dir = temp_dir("e2e-keep-default");
    let output = out_dir.join("partial.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        run.status.success(),
        "keep-partial default should succeed: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    // Kept partials publish to a `.partial` sibling, never the complete path.
    let partial = out_dir.join("partial.partial.png");
    assert!(
        !output.exists(),
        "the requested complete-save path stays untouched on a partial"
    );
    let bytes = std::fs::read(&partial).expect("partial output kept by default");
    assert!(
        bytes.len() > 100,
        "kept partial carries a real PNG body, got {} bytes",
        bytes.len()
    );
}

#[test]
fn cli_no_partial_discards_output() {
    // `--no-partial` selects `Fail`: `tile.download-failed`, no output.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/corrupt.dzi");
    let out_dir = temp_dir("e2e-no-partial");
    let output = out_dir.join("partial.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--no-partial")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        !run.status.success(),
        "no-partial must fail on corrupt tiles"
    );
    assert!(!output.exists(), "no output when discarding partial");
    assert!(
        !out_dir.join("partial.partial.png").exists(),
        "no .partial sibling when discarding partial"
    );
    let stderr = String::from_utf8_lossy(&run.stderr);
    let golden = dezoomify_fixture_server::scenario("native/cli-corrupt-tile");
    let code = golden["expected"]["code"].as_str().expect("golden code");
    assert!(stderr.contains(code), "honest code {code:?}: {stderr}");
}

#[test]
fn cli_named_format_mismatch_fails_instead_of_detecting() {
    // A wrong `--format` restricts discovery and fails typed, never auto-detects.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("e2e-format-mismatch");
    let output = out_dir.join("mismatch.png");
    let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--format")
        .arg("iiif")
        .arg(&input)
        .arg(&output)
        .output()
        .expect("run cli");
    assert!(
        !run.status.success(),
        "mismatched format must fail: stderr={:?}",
        String::from_utf8_lossy(&run.stderr),
    );
    assert!(!output.exists(), "failed jobs write no output");
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(
        stderr.contains("malformed-metadata"),
        "typed discovery failure: {stderr}"
    );
}

/// Drive each `native/edge-*` failure golden through the real binary and
/// check the typed error's stable `kind` identifier.
#[test]
fn edge_failures_publish_their_golden_codes() {
    let origin = start_fixture_server();
    for id in [
        "edge-cache-304",
        "edge-gzip-cache",
        "edge-malformed-json",
        "edge-malformed-xml",
        "edge-range-truncate",
        "edge-redirect-loop",
        "edge-throttle-429",
        "edge-zero-tile",
    ] {
        let (entry, input) = scenario_input(&format!("native/{id}"), &origin);
        let expected = &entry["expected"];
        assert_eq!(
            expected["outcome"].as_str(),
            Some("failed"),
            "{id} golden pins a failure"
        );
        let out_dir = temp_dir(id);
        let output = out_dir.join("out.png");
        // The `tile.download-failed` contract is the `Fail` partial policy.
        let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
            .arg("--no-partial")
            .arg(&input)
            .arg(&output)
            .output()
            .expect("run cli");
        assert!(!run.status.success(), "{id} must fail");
        assert!(!output.exists(), "{id} writes no output on failure");
        let stderr = String::from_utf8_lossy(&run.stderr);
        let code = expected["code"].as_str().expect("golden code");
        assert!(stderr.contains(code), "{id} publishes {code:?}: {stderr}");
    }
}

/// The `native/edge-*` success goldens pin the geometry and disposition
/// the CLI reports (native pixel fidelity lives in the imaging tests).
#[test]
fn edge_successes_match_their_result_goldens() {
    let origin = start_fixture_server();
    for id in ["edge-exif", "edge-redirect-chain", "edge-resume-offline"] {
        let (entry, input) = scenario_input(&format!("native/{id}"), &origin);
        let out_dir = temp_dir(id);
        let output = out_dir.join("out.png");
        let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
            .arg("--json")
            .arg("--tile-cache")
            .arg(out_dir.join("cache"))
            .arg("--overwrite")
            .arg(&input)
            .arg(&output)
            .output()
            .expect("run cli");
        assert!(
            run.status.success(),
            "{id} must succeed: {:?}",
            String::from_utf8_lossy(&run.stderr)
        );
        assert_result_golden(&entry, &String::from_utf8_lossy(&run.stdout), &output);
    }
}
