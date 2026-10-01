//! Golden-driven edge scenario runs: every `native/edge-*` scenario is
//! driven end-to-end over the fixture server and asserted against its
//! `expected/result.json` contract (success geometry or typed failure
//! context). The goldens' `code` field holds the typed error's stable
//! `kind`: the same identifier the CLI human line prints and
//! `apps/cli/tests/pipeline.rs` publishes through the real binary.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dezoomify::model::Error;
use dezoomify_native::diagnostics::Diagnostics;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};
mod support;
use support::{start_fixture_server, temp_dir};

struct Scenario {
    input: String,
    operation: String,
    expected: serde_json::Value,
}

fn load_scenario(id: &str, origin: &str) -> Scenario {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/scenarios/native")
        .join(id);
    let scenario: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("scenario.json")).expect("scenario"),
    )
    .expect("scenario json");
    let expected: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("expected/result.json")).expect("expected result"),
    )
    .expect("expected json");
    let input = scenario["input"]["url"]
        .as_str()
        .expect("scenario input url")
        .replace("http://{{origin}}", origin);
    Scenario {
        input,
        operation: scenario["operation"].as_str().expect("operation").into(),
        expected,
    }
}

/// The job step the golden records, derived from the typed failure:
/// metadata work (including discovery aggregates) is discovery; tile work
/// and tile-failure aggregates are acquisition.
fn phase_of(error: &Error) -> &'static str {
    match error {
        Error::Resource {
            resource_kind: dezoomify::model::ResourceKind::Metadata,
            ..
        } => "discovery",
        Error::Resource {
            resource_kind:
                dezoomify::model::ResourceKind::Tile | dezoomify::model::ResourceKind::Probe,
            ..
        } => "acquisition",
        Error::Resource { source, .. } => phase_of(source),
        Error::PartialDiscarded { failures } | Error::NoUsableTiles { failures } => {
            failures.first().map_or("acquisition", phase_of)
        }
        Error::NoImageFound { .. }
        | Error::MalformedMetadata { .. }
        | Error::DiscoveryFailed { .. }
        | Error::EmptyResource
        | Error::ResourceLimit { .. }
        | Error::DeferredLimit { .. } => "discovery",
        _ => "output",
    }
}

const SUCCESS_SCENARIOS: &[&str] = &["edge-exif", "edge-redirect-chain", "edge-resume-offline"];

const FAILURE_SCENARIOS: &[&str] = &[
    "edge-cache-304",
    "edge-gzip-cache",
    "edge-malformed-json",
    "edge-malformed-xml",
    "edge-range-truncate",
    "edge-redirect-loop",
    "edge-throttle-429",
    "edge-zero-tile",
];

#[test]
fn edge_success_scenarios_match_their_result_goldens() {
    let origin = start_fixture_server();
    for id in SUCCESS_SCENARIOS {
        let scenario = load_scenario(id, &origin);
        assert_eq!(scenario.operation, "download", "{id}");
        let out_dir = temp_dir(id);
        let output = out_dir.join("out.png");
        // Hermetic cache: the job never touches the user's default cache.
        let options = JobOptions {
            cache_dir: Some(out_dir.join("cache")),
            ..Default::default()
        };
        let outcome = support::run_with_options(
            &scenario.input,
            output.to_str().expect("utf8 output"),
            false,
            &options,
            &mut |_| {},
        )
        .unwrap_or_else(|error| panic!("{id} succeeds: {error} ({})", error.cause().kind()));
        let expected = &scenario.expected;
        // `code: "ok"` pins success, and the golden geometry matches the
        // published output (the EXIF-preserving note in `edge-exif` is
        // prose; pixel/EXIF fidelity lives in the native imaging tests).
        assert_eq!(expected["code"].as_str(), Some("ok"), "{id}");
        assert_eq!(
            (
                outcome.output.canvas.as_ref().unwrap().width,
                outcome.output.canvas.as_ref().unwrap().height
            ),
            (
                expected["imageSize"]["x"].as_u64().unwrap() as u32,
                expected["imageSize"]["y"].as_u64().unwrap() as u32
            ),
            "{id} image size"
        );
        assert_eq!(
            outcome.tile_count as u64,
            expected["tileCount"].as_u64().unwrap(),
            "{id} tile count"
        );
        assert_eq!(
            outcome.output.format.as_str(),
            expected["outputFormat"].as_str().unwrap(),
            "{id} output format"
        );
    }
}

#[test]
fn edge_failure_scenarios_match_their_result_goldens() {
    let origin = start_fixture_server();
    let mut mismatches = Vec::new();
    for id in FAILURE_SCENARIOS {
        match_failure_scenario(id, &origin, &mut mismatches);
    }
    assert!(
        mismatches.is_empty(),
        "edge golden mismatches:\n{}",
        mismatches.join("\n")
    );
}

fn match_failure_scenario(id: &str, origin: &str, mismatches: &mut Vec<String>) {
    let scenario = load_scenario(id, origin);
    let mut fail = |field: &str, detail: String| {
        mismatches.push(format!("{id} {field}: {detail}"));
    };
    if scenario.operation != "download-failure" {
        fail(
            "operation",
            format!("{} != download-failure", scenario.operation),
        );
    }
    let out_dir = temp_dir(id);
    let output = out_dir.join("out.png");
    // The published `tile.download-failed` contract is the `Fail`
    // partial policy: the job discards the partial and fails honestly.
    let options = JobOptions {
        input_url: scenario.input.clone(),
        output: OutputTarget::File(output.clone()),
        overwrite: false,
        cache_dir: Some(out_dir.join("cache")),
        keep_partial: false,
        ..Default::default()
    };
    // Capture the typed per-request diagnostics: the goldens' `transport`
    // and `resourceKind` describe the resource class the job failed on
    // (docs/errors.md error shape), which the request records carry as
    // `transport`/`purpose` alongside the failure `code` and `http` status.
    let records = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = Arc::clone(&records);
    let diagnostics = Diagnostics::new("edge-scenarios-test", "0");
    diagnostics.set_sink(move |record| {
        sink.lock()
            .expect("records")
            .push(serde_json::to_value(record).expect("record json"));
    });
    let host = NativeHost::with_diagnostics(options, diagnostics).expect("host options");
    let error = match support::run_host(&host) {
        Err(error) => error,
        Ok(_) => {
            fail(
                "outcome",
                "golden pins a failure but the run succeeded".to_string(),
            );
            return;
        }
    };
    let expected = &scenario.expected;
    if output.exists() {
        fail("outcome", "failed run wrote an output".into());
    }
    if expected["outcome"].as_str() != Some("failed") {
        fail("outcome", format!("golden outcome {}", expected["outcome"]));
    }
    if phase_of(&error) != expected["phase"].as_str().unwrap_or_default() {
        fail(
            "phase",
            format!("{} != golden {}", phase_of(&error), expected["phase"]),
        );
    }
    // `code` is the typed error's stable kind: the identifier the CLI human
    // line prints and `apps/cli/tests/pipeline.rs` publishes (also asserted
    // here directly). `underlying`/`note` are documentation prose.
    if error.cause().kind() != expected["code"].as_str().unwrap_or_default() {
        fail(
            "code",
            format!("{} != golden {}", error.cause().kind(), expected["code"]),
        );
    }
    let requests: Vec<serde_json::Value> = records
        .lock()
        .expect("records")
        .iter()
        .filter(|record| record["event"] == "request")
        .map(|record| record["fields"].clone())
        .collect();
    if !requests.iter().any(|record| {
        record["purpose"].as_str() == expected["resourceKind"].as_str()
            && record["transport"].as_str() == expected["transport"].as_str()
    }) {
        fail(
            "transport/resourceKind",
            format!(
                "no request record for {} over {}; records: {requests:?}",
                expected["resourceKind"], expected["transport"]
            ),
        );
    }
    // `retryable` is the derived job-level verdict: a pure function of the
    // retained failure set (any transient constituent keeps retry
    // available), never a stored flag.
    let retryable = error.retryable();
    if retryable != expected["retryable"].as_bool().unwrap_or_default() {
        fail(
            "retryable",
            format!("{retryable} != golden {}", expected["retryable"]),
        );
    }
    // Recovery follows the documented action flow (docs/errors.md): an
    // acquisition failure leaves the keep/discard/retry choice, while an
    // input/address failure is edit-input.
    let recovery = if phase_of(&error) == "acquisition" {
        "retry"
    } else {
        "edit-input"
    };
    if recovery != expected["recovery"].as_str().unwrap_or_default() {
        fail(
            "recovery",
            format!("{recovery} != golden {}", expected["recovery"]),
        );
    }
}
