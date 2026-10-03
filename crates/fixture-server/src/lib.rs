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

/// Loopback replay URL for one recorded resource, including its query parameters.
#[must_use]
pub fn replay_url(origin: &str, target: &str) -> String {
    let mut replay = url::Url::parse(origin)
        .expect("fixture origin")
        .join("/fetch")
        .expect("fixture endpoint");
    replay.query_pairs_mut().append_pair("url", target);
    replay.into()
}

/// One product fixture and its expected pixel precision.
pub struct FormatInput {
    pub input: String,
    pub tolerance: u8,
}

/// Product inputs discovered from ordinary fixture folders, without registration.
pub fn format_inputs() -> Vec<FormatInput> {
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
            if variant.path().join("viewer.html").is_file() {
                let input = std::fs::read_to_string(variant.path().join("input.txt"))
                    .unwrap_or_else(|_| "viewer.html".to_owned());
                inputs.push(FormatInput {
                    tolerance: if variant
                        .file_name()
                        .to_string_lossy()
                        .starts_with("approximate-")
                    {
                        2
                    } else {
                        0
                    },
                    input: format!(
                        "/fixtures/{}/{}/{}",
                        format.file_name().to_string_lossy(),
                        variant.file_name().to_string_lossy(),
                        input.trim()
                    ),
                });
            }
        }
    }
    inputs.sort_by(|a, b| a.input.cmp(&b.input));
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
