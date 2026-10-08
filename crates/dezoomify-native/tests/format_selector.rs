//! Named format selector: `JobOptions::format` selects the core registry.
//! `None`/`auto` auto-detects; a named format restricts discovery to that
//! format; unknown names fail typed.

use dezoomify::model::Error;

mod support;
use support::{start_fixture_server, temp_dir};

#[allow(clippy::result_large_err)] // Exercise the same error type as the Host API.
fn run_with_format(
    input: &str,
    output: &std::path::Path,
    format: Option<String>,
) -> Result<dezoomify_native::Publication, dezoomify::model::Error> {
    support::run_file(input, output, |options| options.format = format)
}

#[test]
fn auto_is_the_default() {
    assert_eq!(dezoomify_native::JobOptions::default().format, None);
}

#[test]
fn named_deepzoom_selects_the_single_program() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-ok");
    let output = out_dir.join("named.png");
    let outcome = run_with_format(&input, &output, Some("deepzoom".to_string()))
        .expect("named deepzoom succeeds");
    assert_eq!(outcome.source_format, "deepzoom");
    assert_eq!(outcome.tile_count, 4);
    assert!(outcome.output.is_complete());
    assert!(output.is_file());
}

#[test]
fn named_format_matches_case_insensitively() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-case");
    let output = out_dir.join("named.png");
    let outcome = run_with_format(&input, &output, Some("DeepZoom".to_string()))
        .expect("case-insensitive named format succeeds");
    assert_eq!(outcome.source_format, "deepzoom");
}

#[test]
fn explicit_auto_behaves_like_default() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("explicit-auto");
    let output = out_dir.join("auto.png");
    let outcome =
        run_with_format(&input, &output, Some("auto".to_string())).expect("explicit auto succeeds");
    assert_eq!(outcome.source_format, "deepzoom");
    assert_eq!(outcome.tile_count, 4);
}

#[test]
fn named_mismatch_fails_instead_of_auto_detecting() {
    // A DZI document does not match IIIF: the named selector must
    // not fall back to auto-detection.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-mismatch");
    let output = out_dir.join("mismatch.png");
    let error = run_with_format(&input, &output, Some("iiif".to_string()))
        .expect_err("iiif-only registry cannot parse DZI");
    assert_eq!(error.cause().kind(), "discovery-failed");
    assert!(!output.exists(), "failed jobs write no output");
}

#[test]
fn unknown_format_fails_typed_without_output() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("unknown-format");
    let output = out_dir.join("unknown.png");
    let error = run_with_format(&input, &output, Some("nope".to_string()))
        .expect_err("unknown format must fail");
    // Stable kind plus structured facts, never display-string matching.
    assert!(
        matches!(&error, Error::UnknownFormat { format } if format == "nope"),
        "unknown format: {error}"
    );
    assert!(!output.exists(), "unknown format writes no output");
}
