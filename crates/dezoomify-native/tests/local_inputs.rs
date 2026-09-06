//! Local inputs end-to-end: a plain-path `tiles.yaml` plus local tile URIs
//! flow through validation, filesystem fetch, and assembly with scoped
//! credentials and redacted errors preserved.

use std::path::PathBuf;

use dezoomify_native::pipeline::PipelineConfig;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-local-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn scenario_payload(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli")
            .join(name),
    )
    .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
}

fn scenario_expected(name: &str) -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/scenarios/native")
                .join(name)
                .join("expected/result.json"),
        )
        .unwrap_or_else(|e| panic!("expected result for {name}: {e}")),
    )
    .expect("expected json")
}

fn write_tiles(work: &std::path::Path) {
    for tile in ["0_0", "1_0", "0_1", "1_1"] {
        let bytes = scenario_payload(&format!("tile-{tile}.png"));
        std::fs::write(work.join(format!("tile-{tile}.png")), &bytes).expect("write tile");
    }
}

fn yaml_with_template(url_template: &str) -> String {
    format!(
        "url_template: \"{url_template}\"\n\
         x_template: \"x * tile_size\"\n\
         y_template: \"y * tile_size\"\n\
         variables:\n\
         \x20 - {{ name: x, from: 0, to: 1 }}\n\
         \x20 - {{ name: y, from: 0, to: 1 }}\n\
         \x20 - {{ name: tile_size, value: 256 }}\n\
         width: 512\n\
         height: 512\n\
         title: \"Local tiles\"\n"
    )
}

#[test]
fn plain_path_input_with_file_uri_tiles_assembles() {
    let work = temp_dir("plain-input");
    write_tiles(&work);
    let dir = work.to_str().expect("utf8 dir").to_string();
    let yaml = yaml_with_template(&format!("file://{dir}/tile-{{{{x}}}}_{{{{y}}}}.png"));
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
    let output = work.join("local.png");
    let outcome = dezoomify_native::pipeline::run(
        manifest.to_str().expect("utf8 input"),
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_| {},
    )
    .unwrap_or_else(|e| {
        panic!(
            "plain-path local input succeeds: {} ({})",
            e.message, e.code
        )
    });
    assert_eq!(outcome.tile_count, 4);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    assert!(!outcome.partial);
    let expected = scenario_expected("cli-dzi");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
}

#[test]
fn file_uri_input_with_plain_path_tiles_assembles() {
    let work = temp_dir("file-input");
    write_tiles(&work);
    let dir = work.to_str().expect("utf8 dir").to_string();
    // Plain filesystem paths as tile URIs (no scheme): `fs::read` path.
    let yaml = yaml_with_template(&format!("{dir}/tile-{{{{x}}}}_{{{{y}}}}.png"));
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
    let file_uri = format!("file://{}", manifest.to_str().expect("utf8 input"));
    let output = work.join("local.png");
    let outcome = dezoomify_native::pipeline::run(
        &file_uri,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_| {},
    )
    .unwrap_or_else(|e| panic!("file:// local input succeeds: {} ({})", e.message, e.code));
    assert_eq!(outcome.tile_count, 4);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
}

#[test]
fn file_uri_with_remote_host_is_rejected_typed() {
    let work = temp_dir("remote-file-host");
    let output = work.join("out.png");
    let error = dezoomify_native::pipeline::run(
        "file://other.test/tile.png",
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_| {},
    )
    .expect_err("remote file host must be rejected");
    // `Job::new` rejects it as invalid input, mapped to a stable native code.
    assert_eq!(error.code, "discovery.failed");
    assert!(
        !error.message.contains("other.test"),
        "error must not leak the rejected host: {}",
        error.message
    );
    assert!(!output.exists());
}

#[test]
fn job_validation_accepts_local_but_rejects_remote_file_hosts() {
    use dezoomify_job::{Config, Job};
    let config = Config::default();
    assert!(Job::new("job:local-plain", "/tmp/tiles.yaml", config.clone()).is_ok());
    assert!(Job::new("job:local-rel", "tiles.yaml", config.clone()).is_ok());
    assert!(Job::new("job:local-file", "file:///tmp/tiles.yaml", config.clone()).is_ok());
    assert!(Job::new(
        "job:local-localhost",
        "file://localhost/tmp/tiles.yaml",
        config.clone()
    )
    .is_ok());
    assert!(Job::new("job:remote-file", "file://other.test/t.png", config).is_err());
}
