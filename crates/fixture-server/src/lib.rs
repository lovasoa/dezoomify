//! Corpus readers and process adapters for Node test servers.
mod node;
pub use node::{server_script, NodeServer, RawRequest, RawResponse};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Scenario corpus access: this test-tool crate owns testdata/scenarios.
// ---------------------------------------------------------------------------

/// The shared scenario corpus under `testdata/scenarios`.
#[must_use]
pub fn scenarios_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios")
}

/// Product inputs discovered from ordinary fixture folders, without registration.
pub fn format_inputs() -> Vec<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut inputs = Vec::new();
    for format in std::fs::read_dir(root).expect("fixtures").flatten() {
        if !format.path().is_dir() {
            continue;
        }
        for variant in std::fs::read_dir(format.path())
            .expect("variants")
            .flatten()
        {
            if let Ok(input) = std::fs::read_to_string(variant.path().join("input.txt")) {
                inputs.push(format!(
                    "/fixtures/{}/{}/{}",
                    format.file_name().to_string_lossy(),
                    variant.file_name().to_string_lossy(),
                    input.trim()
                ));
            }
        }
    }
    inputs.sort();
    inputs
}

/// A fresh temp directory for one scenario run, cleared of leftovers.
#[must_use]
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dezoomify-tests-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// One Node-owned fixture server per Rust test process.
#[must_use]
pub fn start() -> String {
    static SERVER: std::sync::OnceLock<NodeServer> = std::sync::OnceLock::new();
    SERVER
        .get_or_init(|| NodeServer::fixture(&[]))
        .origin
        .clone()
}

/// One scenario's corpus entry: its documented `scenario.json` with the
/// `expected/result.json` golden attached under `expected`.
#[must_use]
pub fn scenario(id: &str) -> serde_json::Value {
    let dir = scenarios_dir().join(id);
    let mut entry: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("scenario.json")).expect("scenario"),
    )
    .expect("scenario json");
    entry["expected"] = serde_json::from_str(
        &std::fs::read_to_string(dir.join("expected/result.json")).expect("expected result"),
    )
    .expect("expected json");
    entry
}

/// One scenario's corpus entry as [`scenario`] loads it, with its input URL
/// handed back ready to run: the `http://{{origin}}` fixture placeholder is
/// substituted with the live loopback origin. The one loader adapter for the
/// native, edge, and CLI drivers.
#[must_use]
pub fn scenario_input(id: &str, origin: &str) -> (serde_json::Value, String) {
    let entry = scenario(id);
    let input = entry["input"]["url"]
        .as_str()
        .expect("scenario input url")
        .replace("http://{{origin}}", origin);
    (entry, input)
}

/// One completed job as its golden records it. Each driver adapts its own
/// observation (native publication, CLI event JSON) into this shape once.
#[derive(Clone, Debug)]
pub struct GoldenResult {
    /// Assembled image size `(width, height)`.
    pub image_size: (u64, u64),
    /// Tiles the job acquired.
    pub tile_count: u64,
    /// Output format name as the model spells it (`png`, `jpeg`, ...).
    pub output_format: String,
    /// Whether the published output is partial.
    pub partial: bool,
}

/// The one golden comparator: `(label, observed, golden)` triples, adapted
/// once per driver, yield one readable mismatch line per divergence. Empty
/// when every field matches.
#[must_use]
pub fn golden_mismatches(id: &str, fields: &[(&str, String, String)]) -> Vec<String> {
    fields
        .iter()
        .filter(|(_, observed, golden)| observed != golden)
        .map(|(name, observed, golden)| format!("{id} {name}: {observed} != golden {golden}"))
        .collect()
}

/// Success-golden mismatches: image size, tile count, output format, and
/// (when the golden pins one) the partial disposition and the `ok` code.
/// Empty when the run matches its golden. `recovery` in success goldens
/// documents the mechanism in prose and is never a typed fact.
#[must_use]
pub fn result_golden_mismatches(entry: &serde_json::Value, result: &GoldenResult) -> Vec<String> {
    let id = entry["id"].as_str().unwrap_or("<scenario>");
    let golden = &entry["expected"];
    let width = golden["imageSize"]["x"].as_u64().expect("golden width");
    let height = golden["imageSize"]["y"].as_u64().expect("golden height");
    let mut mismatches = golden_mismatches(
        id,
        &[
            (
                "image size",
                format!("{:?}", result.image_size),
                format!("({width}, {height})"),
            ),
            (
                "tile count",
                result.tile_count.to_string(),
                golden["tileCount"]
                    .as_u64()
                    .expect("golden tile count")
                    .to_string(),
            ),
            (
                "output format",
                result.output_format.clone(),
                golden["outputFormat"]
                    .as_str()
                    .expect("golden format")
                    .to_string(),
            ),
        ],
    );
    if let Some(partial) = golden.get("partial") {
        if partial.as_bool() != Some(result.partial) {
            mismatches.push(format!(
                "{id} partial disposition: {} != golden {partial}",
                result.partial
            ));
        }
    }
    if let Some(code) = golden.get("code") {
        if code != "ok" {
            mismatches.push(format!("{id} success outcome: golden code {code} != ok"));
        }
    }
    mismatches
}

/// Failure-golden mismatches: the run failed and the golden's `code`
/// records the typed error's stable kind (the same identifier the CLI
/// human line prints). `underlying`/`note`/`recovery` are documentation
/// prose, never typed facts.
#[must_use]
pub fn failure_golden_mismatches(entry: &serde_json::Value, kind: &str) -> Vec<String> {
    let id = entry["id"].as_str().unwrap_or("<scenario>");
    let golden = &entry["expected"];
    golden_mismatches(
        id,
        &[
            (
                "outcome",
                "failed".to_string(),
                golden["outcome"].as_str().unwrap_or_default().to_string(),
            ),
            (
                "code",
                kind.to_string(),
                golden["code"].as_str().unwrap_or_default().to_string(),
            ),
        ],
    )
}

/// Assert [`result_golden_mismatches`] is empty. Drivers that report a
/// batch of scenarios at once call the mismatch form and collect.
pub fn assert_result_golden(entry: &serde_json::Value, result: GoldenResult) {
    let mismatches = result_golden_mismatches(entry, &result);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// Assert [`failure_golden_mismatches`] is empty.
pub fn assert_failure_golden(entry: &serde_json::Value, kind: &str) {
    let mismatches = failure_golden_mismatches(entry, kind);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
