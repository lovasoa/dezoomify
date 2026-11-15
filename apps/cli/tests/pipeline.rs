//! Real binary tests: shared format fixtures plus CLI-only behavior.
use dezoomify_fixture_server::{format_inputs, start, temp_dir};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn cli(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .args(args)
        .current_dir(dir)
        .output()
        .expect("CLI process")
}

fn succeeds(run: &Output) {
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
}

fn events(run: &Output) -> Vec<serde_json::Value> {
    String::from_utf8_lossy(&run.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON event"))
        .collect()
}

fn source(name: &str) -> String {
    format!("{}/fetch?url=https://fixtures.test/cli/{name}", start())
}

fn dimensions(path: &Path, size: u32) {
    assert_eq!(
        image::open(path)
            .expect("saved image")
            .to_rgb8()
            .dimensions(),
        (size, size)
    );
}

fn pixels(path: &Path, tolerance: u8) {
    let image = image::open(path).expect("saved image").to_rgba8();
    assert_eq!(image.dimensions(), (512, 512));
    let colors: [[u8; 3]; 4] = [[196, 48, 48], [48, 168, 64], [48, 72, 200], [232, 220, 96]];
    for (x, y, pixel) in image.enumerate_pixels() {
        let expected = colors[(x / 256 + 2 * (y / 256)) as usize];
        assert_eq!(pixel.0[3], 255, "transparent pixel ({x},{y})");
        assert!(
            pixel
                .0
                .iter()
                .zip(expected)
                .all(|(a, b)| a.abs_diff(b) <= tolerance),
            "pixel ({x},{y}): {pixel:?} != {expected:?}"
        );
    }
}

#[test]
fn every_shared_format_saves_the_same_pixels() {
    let dir = temp_dir("cli-formats");
    let inputs = format_inputs();
    assert!(!inputs.is_empty());
    for fixture in inputs {
        let input = fixture.input;
        let url = format!("{}{input}", start());
        let mut args = vec!["--json", "--retries", "0", "--overwrite", &url, "out.png"];
        let index = fixture.choice.map(|index| index.to_string());
        if let Some(index) = &index {
            args.extend(["--image-index", index]);
        }
        let run = cli(&dir, &args);
        assert!(
            run.status.success(),
            "{input}: {}",
            String::from_utf8_lossy(&run.stderr)
        );
        let observed = events(&run);
        assert_eq!(observed.first().unwrap()["kind"], "started");
        assert_eq!(observed.last().unwrap()["kind"], "completed");
        for pair in observed.windows(2) {
            assert!(pair[0]["seq"].as_u64() < pair[1]["seq"].as_u64());
        }
        pixels(&dir.join("out.png"), fixture.tolerance);
    }
}

#[test]
fn flags_and_logging_reach_the_runtime() {
    let url = source("pyramid.dzi");
    let dir = temp_dir("cli-flags");
    let cache = dir.join("cache");
    let cache = cache.to_str().unwrap();
    let flags: &[&[&str]] = &[
        &["--json"],
        &["--max-width", "300"],
        &["--format", "deepzoom", "--retries", "0"],
        &[
            "--json",
            "--header",
            "Referer: https://fixtures.test/viewer",
            "--retries",
            "3",
            "--retry-delay",
            "500ms",
            "--compression",
            "5",
            "--max-idle-per-host",
            "8",
            "--timeout",
            "10s",
            "--connect-timeout",
            "3s",
            "--format",
            "auto",
            "--parallelism",
            "8",
            "--max-width",
            "10000",
            "--max-height",
            "10000",
            "--zoom-level",
            "100",
            "--largest",
            "--tile-cache",
            cache,
            "--image-index",
            "0",
            "--min-interval",
            "1ms",
            "--start-rps",
            "64.5",
            "--max-rps",
            "128",
        ],
    ];
    for (index, flags) in flags.iter().enumerate() {
        let mut args = flags.to_vec();
        args.extend(["--overwrite", &url, "out.png"]);
        let run = cli(&dir, &args);
        succeeds(&run);
        assert!(!String::from_utf8_lossy(&run.stderr).contains("warning:"));
        dimensions(&dir.join("out.png"), if index == 1 { 256 } else { 512 });
    }
    assert!(PathBuf::from(cache).exists());
}

#[test]
fn logging_levels_control_human_messages_and_keep_json_events() {
    let url = source("pyramid.dzi");
    let dir = temp_dir("cli-logging");
    for level in ["error", "info", "debug", "trace"] {
        let log_cache = dir.join(level);
        let run = cli(
            &dir,
            &[
                "--logging",
                level,
                "--tile-cache",
                log_cache.to_str().unwrap(),
                "--overwrite",
                &url,
                "out.png",
            ],
        );
        succeeds(&run);
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert_eq!(stderr.contains("saved"), level != "error");
        assert_eq!(
            stderr.contains("\"purpose\":\"metadata\""),
            matches!(level, "debug" | "trace")
        );
        assert_eq!(stderr.contains("\"purpose\":\"tile\""), level == "trace");
        let run = cli(
            &dir,
            &["--json", "--logging", level, "--overwrite", &url, "out.png"],
        );
        succeeds(&run);
        assert_eq!(events(&run).last().unwrap()["kind"], "completed");
    }
}

#[test]
fn argument_errors_fail_without_stdout_or_output() {
    let dir = temp_dir("cli-args");
    for (args, message) in [
        (["--logging", "verbose"], "invalid --logging value"),
        (["--format", "nope"], "unknown format"),
        (["--nope", ""], "unknown flag --nope"),
        (
            ["--definitely-unknown", ""],
            "unknown flag --definitely-unknown",
        ),
        (["-Z", ""], "unknown flag -Z"),
    ] {
        let run = cli(&dir, &[args[0], args[1], &source("pyramid.dzi"), "out.png"]);
        assert_eq!(run.status.code(), Some(2));
        assert!(run.stdout.is_empty());
        assert!(!dir.join("out.png").exists());
        assert!(String::from_utf8_lossy(&run.stderr).contains(message));
    }
}

#[test]
fn tile_failures_preserve_context_without_publication() {
    let dir = temp_dir("cli-failures");
    for input in ["broken.dzi", "corrupt.dzi"] {
        let url = source(input);
        let run = cli(&dir, &["--json", &url, "out.png"]);
        assert!(!run.status.success());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "failed jobs leave no files"
        );
        let terminal = events(&run).pop().unwrap();
        assert_eq!(terminal["kind"], "failed");
        assert_eq!(terminal["error"]["kind"], "tile-failed");
        assert_eq!(terminal["error"]["attempts"], 1);
        assert_eq!(terminal["error"]["cause"]["kind"], "resource");
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert!(stderr.contains("failed after 1 attempt"));
        assert!(stderr.contains("_files/"));
    }
}

#[test]
fn automatic_names_preserve_existing_files() {
    let dir = temp_dir("cli-names");
    let url = source("pyramid.dzi");
    succeeds(&cli(&dir, &[&url]));
    let first = std::fs::read(dir.join("dezoomify.png")).unwrap();
    succeeds(&cli(&dir, &[&url]));
    assert_eq!(std::fs::read(dir.join("dezoomify.png")).unwrap(), first);
    dimensions(&dir.join("dezoomify_0001.png"), 512);
}

#[test]
fn bulk_continues_after_failure_in_human_and_json_modes() {
    let dir = temp_dir("cli-bulk");
    for json in [false, true] {
        for failed in [false, true] {
            std::fs::write(
                dir.join("list.txt"),
                format!(
                    "{} first\n{} second\n",
                    source("pyramid.dzi"),
                    source(if failed { "broken.dzi" } else { "pyramid.dzi" })
                ),
            )
            .unwrap();
            let mut args = vec![
                "--bulk",
                "list.txt",
                "--outfile",
                "collection.png",
                "--overwrite",
            ];
            if json {
                args.push("--json");
            }
            let _ = std::fs::remove_file(dir.join("collection_2.png"));
            let run = cli(&dir, &args);
            assert_eq!(run.status.success(), !failed);
            dimensions(&dir.join("collection_1.png"), 512);
            assert_eq!(dir.join("collection_2.png").exists(), !failed);
            bulk_summary(&run, json, failed);
        }
    }
}

fn bulk_summary(run: &Output, json: bool, failed: bool) {
    if json {
        let observed = events(run);
        assert_eq!(
            observed.iter().filter(|e| e["kind"] == "bulk-item").count(),
            2
        );
        let summary = observed.last().unwrap();
        assert_eq!(summary["kind"], "bulk-completed");
        assert_eq!(summary["succeeded"], if failed { 1 } else { 2 });
        assert_eq!(summary["failed"], u64::from(failed));
    } else {
        assert!(String::from_utf8_lossy(&run.stderr).contains(if failed {
            "1 succeeded, 1 failed, 2 total"
        } else {
            "2 succeeded, 0 failed, 2 total"
        }));
    }
}

#[test]
fn pdf_bulk_saves_one_document_and_reports_partial_completion() {
    let dir = temp_dir("cli-pdf-bulk");
    for failed_at in [None, Some(0), Some(1)] {
        std::fs::write(
            dir.join("list.txt"),
            (0..3)
                .map(|index| {
                    format!(
                        "{} image-{index}\n",
                        source(if failed_at == Some(index) {
                            "broken.dzi"
                        } else {
                            "pyramid.dzi"
                        })
                    )
                })
                .collect::<String>(),
        )
        .unwrap();
        let output = dir.join("collection.pdf");
        let _ = std::fs::remove_file(&output);
        let run = cli(
            &dir,
            &[
                "--bulk",
                "list.txt",
                "--outfile",
                "collection.pdf",
                "--json",
            ],
        );
        assert_eq!(run.status.success(), failed_at.is_none());
        let expected = failed_at.unwrap_or(3);
        assert_eq!(output.exists(), expected > 0);
        assert!(!dir.join("collection_1.pdf").exists());
        pdf_bulk_summary(&run, expected, failed_at.is_some());
    }
}

fn pdf_bulk_summary(run: &Output, expected: usize, failed: bool) {
    let events = events(run);
    let summary = events.last().unwrap();
    assert_eq!(summary["succeeded"], expected);
    assert_eq!(summary["failed"], usize::from(failed));
    let pages: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "bulk-item" && event["status"] == "ok")
        .map(|event| event["page"].as_u64().unwrap())
        .collect();
    assert_eq!(pages, (1..=expected as u64).collect::<Vec<_>>());
    if expected > 0 {
        assert_eq!(summary["pages"], expected);
    }
    if failed {
        assert!(summary["error"].is_object());
    }
}

#[test]
fn pdf_bulk_preserves_an_existing_document() {
    let dir = temp_dir("cli-pdf-bulk-existing");
    std::fs::write(dir.join("list.txt"), source("pyramid.dzi")).unwrap();
    std::fs::write(dir.join("collection.pdf"), b"keep this file").unwrap();
    let run = cli(&dir, &["--bulk", "list.txt", "--outfile", "collection.pdf"]);
    assert!(!run.status.success());
    assert_eq!(
        std::fs::read(dir.join("collection.pdf")).unwrap(),
        b"keep this file"
    );
}

#[test]
#[cfg(unix)]
fn interrupting_a_pdf_bulk_download_closes_completed_pages() {
    use std::{
        sync::{mpsc, Mutex},
        time::Duration,
    };
    let dir = temp_dir("cli-pdf-interrupt");
    let (arrived, observed) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let blocked = Mutex::new(blocked);
    let server = dezoomify_fixture_server::NodeServer::raw("127.0.0.1", move |_| {
        let _ = arrived.send(());
        let _ = blocked.lock().unwrap().recv();
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec()
            .into()
    });
    struct Release(mpsc::Sender<()>);
    impl Drop for Release {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    let _release = Release(release);
    std::fs::write(
        dir.join("list.txt"),
        format!("{}\n{}/held.dzi\n", source("pyramid.dzi"), server.origin),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .args([
            "--bulk",
            "list.txt",
            "--outfile",
            "collection.pdf",
            "--json",
        ])
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id().to_string();
    let (finished, result) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = finished.send(child.wait_with_output().unwrap());
    });
    observed
        .recv_timeout(Duration::from_secs(10))
        .expect("second image reached the held response");
    assert!(Command::new("kill")
        .args(["-INT", &pid])
        .status()
        .unwrap()
        .success());
    let run = match result.recv_timeout(Duration::from_secs(10)) {
        Ok(run) => run,
        Err(error) => {
            let _ = Command::new("kill").args(["-KILL", &pid]).status();
            worker.join().unwrap();
            panic!("interrupt did not settle the download: {error}");
        }
    };
    worker.join().unwrap();
    assert!(!run.status.success());
    assert!(dir.join("collection.pdf").is_file());
    let events = events(&run);
    let summary = events.last().unwrap();
    assert_eq!(summary["pages"], 1);
    let error: dezoomify::model::Error = serde_json::from_value(summary["error"].clone()).unwrap();
    assert!(matches!(error.cause(), dezoomify::model::Error::Cancelled));
}
