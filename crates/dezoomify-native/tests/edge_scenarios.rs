//! Golden-driven edge scenario runs: every `native/edge-*` scenario runs
//! end-to-end over the fixture server and asserts its `expected/result.json`
//! contract. The goldens' `code` field is the typed error's stable `kind`.

use std::sync::{Arc, Mutex};

use dezoomify::model::Error;
use dezoomify_native::diagnostics::Diagnostics;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};
mod support;
use support::{start_fixture_server, temp_dir};

/// Every `native/edge-*` corpus entry, one line each.
const EDGE_SCENARIOS: &[&str] = &[
    "edge-exif",
    "edge-redirect-chain",
    "edge-resume-offline",
    "edge-cache-304",
    "edge-gzip-cache",
    "edge-malformed-json",
    "edge-malformed-xml",
    "edge-range-truncate",
    "edge-redirect-loop",
    "edge-throttle-429",
    "edge-zero-tile",
];

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
        Error::PartialDiscarded { .. } | Error::NoUsableTiles { .. } => "acquisition",
        Error::NoImageFound { .. }
        | Error::MalformedMetadata { .. }
        | Error::DiscoveryFailed { .. }
        | Error::EmptyResource
        | Error::ResourceLimit { .. }
        | Error::DeferredLimit { .. } => "discovery",
        _ => "output",
    }
}

#[test]
fn edge_scenarios_match_their_result_goldens() {
    let origin = start_fixture_server();
    let mut mismatches = Vec::new();
    for id in EDGE_SCENARIOS {
        run_edge_scenario(id, &origin, &mut mismatches);
    }
    assert!(
        mismatches.is_empty(),
        "edge golden mismatches:\n{}",
        mismatches.join("\n")
    );
}

/// One scenario per call: run over the fixture server and compare the typed
/// outcome with the golden's contract fields.
fn run_edge_scenario(id: &str, origin: &str, mismatches: &mut Vec<String>) {
    let (entry, input) = dezoomify_fixture_server::scenario_input(&format!("native/{id}"), origin);
    let expected = &entry["expected"];
    let failed = expected["outcome"].as_str() == Some("failed");
    let wanted_operation = if failed {
        "download-failure"
    } else {
        "download"
    };
    if entry["operation"].as_str() != Some(wanted_operation) {
        mismatches.push(format!(
            "{id} operation: {} != {wanted_operation}",
            entry["operation"]
        ));
    }
    let out_dir = temp_dir(id);
    let output = out_dir.join("out.png");
    // Hermetic cache; `Fail` partial policy discards on tile failure.
    let options = JobOptions {
        input_url: input,
        output: OutputTarget::File(output.clone()),
        overwrite: false,
        cache_dir: Some(out_dir.join("cache")),
        keep_partial: false,
        ..Default::default()
    };
    // Per-request records carry `transport`/`purpose`, which the goldens'
    // `transport`/`resourceKind` name (docs/errors.md error shape).
    let records = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = Arc::clone(&records);
    let diagnostics = Diagnostics::new("edge-scenarios-test", "0");
    diagnostics.set_sink(move |record| {
        sink.lock()
            .expect("records")
            .push(serde_json::to_value(record).expect("record json"));
    });
    let host = NativeHost::with_diagnostics(options, diagnostics).expect("host options");
    let result = support::run_host(&host);
    if !failed {
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                mismatches.push(format!(
                    "{id} outcome: golden pins success but the run failed: {error}"
                ));
                return;
            }
        };
        // Golden geometry matches the published output (pixel/EXIF
        // fidelity lives in the native imaging tests).
        mismatches.extend(dezoomify_fixture_server::result_golden_mismatches(
            &entry,
            &support::golden_result(&outcome),
        ));
        return;
    }
    let error = match result {
        Err(error) => error,
        Ok(_) => {
            mismatches.push(format!(
                "{id} outcome: golden pins a failure but the run succeeded"
            ));
            return;
        }
    };
    if output.exists() {
        mismatches.push(format!("{id} outcome: failed run wrote an output"));
    }
    // `retryable` is the derived job-level verdict; `recovery` follows
    // the documented action flow (docs/errors.md).
    mismatches.extend(dezoomify_fixture_server::golden_mismatches(
        id,
        &[
            (
                "phase",
                phase_of(&error).to_string(),
                expected["phase"].as_str().unwrap_or_default().to_string(),
            ),
            (
                "retryable",
                error.retryable().to_string(),
                expected["retryable"].to_string(),
            ),
            (
                "recovery",
                if phase_of(&error) == "acquisition" {
                    "retry"
                } else {
                    "edit-input"
                }
                .to_string(),
                expected["recovery"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
        ],
    ));
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
        mismatches.push(format!(
            "{id} transport/resourceKind: no request record for {} over {}; records: {requests:?}",
            expected["resourceKind"], expected["transport"]
        ));
    }
    mismatches.extend(dezoomify_fixture_server::failure_golden_mismatches(
        &entry,
        error.cause().kind(),
    ));
}
