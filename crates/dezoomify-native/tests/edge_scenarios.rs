//! Golden-driven edge scenario runs: every `native/edge-*` scenario is
//! driven end-to-end over the fixture server and asserted against its
//! `expected/result.json` contract (success geometry or typed failure
//! context). The goldens' `code` field holds the typed error's stable
//! `kind`: the same identifier the CLI human line prints and
//! `apps/cli/tests/pipeline.rs` publishes through the real binary.

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
    // Hermetic cache (never the user's default) and the `Fail` partial
    // policy: the published `tile.download-failed` contract discards the
    // partial and fails honestly.
    let options = JobOptions {
        input_url: input,
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
        // `code: "ok"` pins success (the shared result comparison treats
        // the code as optional), and the golden geometry matches the
        // published output (the EXIF-preserving note in `edge-exif` is
        // prose; pixel/EXIF fidelity lives in the native imaging tests).
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
    // `retryable` is the derived job-level verdict (any transient retained
    // constituent keeps retry available, never a stored flag); recovery
    // follows the documented action flow (docs/errors.md): an acquisition
    // failure leaves the keep/discard/retry choice, while an input/address
    // failure is edit-input.
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
    // `code` is the typed error's stable kind: the identifier the CLI human
    // line prints and `apps/cli/tests/pipeline.rs` publishes (also asserted
    // here directly). `underlying`/`note` are documentation prose.
    mismatches.extend(dezoomify_fixture_server::failure_golden_mismatches(
        &entry,
        error.cause().kind(),
    ));
}
