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

fn pixels(path: &Path) {
    let image = image::open(path).expect("saved image").to_rgb8();
    assert_eq!(image.dimensions(), (512, 512));
    let colors: [[u8; 3]; 4] = [[196, 48, 48], [48, 168, 64], [48, 72, 200], [232, 220, 96]];
    for (x, y, pixel) in image.enumerate_pixels() {
        let expected = colors[(x / 256 + 2 * (y / 256)) as usize];
        assert!(
            pixel
                .0
                .iter()
                .zip(expected)
                .all(|(a, b)| a.abs_diff(b) <= 2),
            "pixel ({x},{y}): {pixel:?} != {expected:?}"
        );
    }
}

#[test]
fn every_shared_format_saves_the_same_pixels() {
    let dir = temp_dir("cli-formats");
    let inputs = format_inputs();
    assert!(!inputs.is_empty());
    for input in inputs {
        let url = format!("{}{input}", start());
        let run = cli(
            &dir,
            &[
                "--json",
                "--no-partial",
                "--retries",
                "0",
                "--overwrite",
                &url,
                "out.png",
            ],
        );
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
        pixels(&dir.join("out.png"));
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
            "--keep-partial",
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
    ] {
        let run = cli(&dir, &[args[0], args[1], &source("pyramid.dzi"), "out.png"]);
        assert_eq!(run.status.code(), Some(2));
        assert!(run.stdout.is_empty());
        assert!(!dir.join("out.png").exists());
        assert!(String::from_utf8_lossy(&run.stderr).contains(message));
    }
}

#[test]
fn failures_and_partial_policy_control_publication() {
    let dir = temp_dir("cli-failures");
    for (input, flags, partial) in [
        ("broken.dzi", vec!["--no-partial"], false),
        ("corrupt.dzi", vec!["--no-partial"], false),
        ("corrupt.dzi", vec![], true),
        ("pyramid.dzi", vec!["--format", "iiif"], false),
    ] {
        let partial_path = dir.join("out.partial.png");
        let _ = std::fs::remove_file(&partial_path);
        let url = source(input);
        let mut args = flags;
        args.extend([&url, "out.png"]);
        let run = cli(&dir, &args);
        assert_eq!(run.status.success(), partial);
        assert!(!dir.join("out.png").exists());
        assert_eq!(partial_path.exists(), partial);
        if partial {
            dimensions(&partial_path, 512);
        } else {
            assert!(
                String::from_utf8_lossy(&run.stderr).contains(if input == "pyramid.dzi" {
                    "malformed-metadata"
                } else {
                    "partial-discarded"
                })
            );
        }
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
                "--no-partial",
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
            if json {
                let observed = events(&run);
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
    }
}
