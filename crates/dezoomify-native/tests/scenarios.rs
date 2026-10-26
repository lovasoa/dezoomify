//! Native scenario tests: header scope, redirects, cache, limits.

use dezoomify::model::Error;
use dezoomify::model::OutputFormat;
use dezoomify_native::cache;
use dezoomify_native::client;
use dezoomify_native::output;
use std::collections::BTreeMap;
mod support;
use support::tile_request;

#[test]
fn public_headers_reject_cookie_and_authorization() {
    let mut extra = BTreeMap::new();
    extra.insert("Cookie".to_string(), "x=1".to_string());
    assert!(client::build_request("https://fixtures.test/x", &extra).is_err());
}

#[test]
fn cache_keys_distinguish_resources_and_never_persist_secrets() {
    // The key digests the full URI: query-addressed resources must never
    // collide (serving one tile's bytes for another is silent corruption).
    assert_ne!(
        cache::cache_key(&tile_request("https://h/tile?x=0&y=0")),
        cache::cache_key(&tile_request("https://h/tile?x=9&y=9"))
    );
    assert_ne!(
        cache::cache_key(&tile_request("https://h/tile")),
        cache::cache_key(&tile_request("https://h/tile?token=secret"))
    );
    let dir = std::env::temp_dir().join(format!("dz-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // A credential-bearing URL must never leak into the cache path or the
    // stored artifact: only the digest key and the payload itself.
    let first = tile_request("https://h/item?token=CANARY");
    let path = cache::store(&dir, "job1", &first, b"bytes").unwrap();
    assert_eq!(cache::load(&dir, "job1", &first).unwrap(), b"bytes");
    let path_text = path.to_string_lossy();
    assert!(
        !path_text.contains("CANARY") && !path_text.contains("token"),
        "cache path must never carry URL text: {path_text}"
    );
    let content = std::fs::read(&path).unwrap();
    assert_eq!(
        content, b"bytes",
        "stored artifact must be the payload only"
    );
    // Two distinct query-addressed URIs produce two distinct entries, each
    // loading back its own bytes.
    let second = tile_request("https://h/item?token=CANARY&x=1");
    let path_b = cache::store(&dir, "job1", &second, b"bytes-b").unwrap();
    assert_ne!(path, path_b);
    assert_eq!(cache::load(&dir, "job1", &second).unwrap(), b"bytes-b");
    assert_eq!(cache::load(&dir, "job1", &first).unwrap(), b"bytes");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn container_tile_cache_isolates_ranges_without_persisting_headers() {
    use dezoomify::model::{Header, RequestPurpose, ResourceRequest};
    let work = dezoomify_fixture_server::temp_dir("range-cache");
    let request = |range: &str| ResourceRequest {
        uri: "https://h/container.zif?token=CANARY".into(),
        purpose: RequestPurpose::Tile,
        headers: vec![
            Header {
                name: "Range".into(),
                value: range.into(),
            },
            Header {
                name: "X-Private".into(),
                value: "SECRET-HEADER".into(),
            },
        ],
    };
    let first = request("bytes=0-3");
    let second = request("bytes=4-7");
    let whole = tile_request(&first.uri);
    let path = cache::store(&work, "job", &first, b"tile1").unwrap();
    assert!(cache::load(&work, "job", &second).is_none());
    cache::store(&work, "job", &second, b"tile2").unwrap();
    cache::store(&work, "job", &whole, b"whole").unwrap();
    assert_eq!(cache::load(&work, "job", &first).unwrap(), b"tile1");
    assert_eq!(cache::load(&work, "job", &second).unwrap(), b"tile2");
    assert_eq!(cache::load(&work, "job", &whole).unwrap(), b"whole");
    let mut equivalent = first.clone();
    equivalent.headers[0].name = "rAnGe".into();
    equivalent.headers[1].value = "OTHER-SECRET".into();
    assert_eq!(cache::cache_key(&first), cache::cache_key(&equivalent));
    assert!(!path.to_string_lossy().contains("CANARY"));
    assert!(!path.to_string_lossy().contains("bytes"));
    assert_eq!(std::fs::read(path).unwrap(), b"tile1");
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn cache_namespaces_isolate_jobs_and_reject_traversal() {
    // The namespace derives from the input URL alone: repeated runs of one
    // job share entries, distinct jobs never do, and no URL text survives.
    let first = cache::job_namespace("https://h/painting");
    assert_eq!(first, cache::job_namespace("https://h/painting"));
    assert_ne!(first, cache::job_namespace("https://h/other"));
    assert!(
        !first.contains("painting") && !first.contains("https"),
        "namespace must carry no URL text: {first}"
    );
    let dir = std::env::temp_dir().join(format!("dz-ns-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let tile = tile_request("https://h/tile?x=0");
    cache::store(&dir, &first, &tile, b"bytes").unwrap();
    assert_eq!(cache::load(&dir, &first, &tile).unwrap(), b"bytes");
    // A missing entry is a miss, not an error.
    assert!(cache::load(&dir, &first, &tile_request("https://h/tile?x=1")).is_none());
    // Foreign namespaces never read or write outside the cache root.
    assert!(cache::store(&dir, "../escape", &tile, b"x").is_err());
    assert!(cache::store(&dir, "a/b", &tile, b"x").is_err());
    assert!(cache::load(&dir, "../escape", &tile).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_refuses_mismatch_and_requires_overwrite() {
    let dir = std::env::temp_dir().join(format!("dz-out-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("out.png");
    // Each single-file format only validates its own extensions.
    let jpg = dir.join("out.jpg");
    assert!(output::validate_destination(&jpg, &OutputFormat::Png, false).is_err());
    assert!(output::validate_destination(&jpg, &OutputFormat::Png, true).is_err());
    assert!(output::validate_destination(&jpg, &OutputFormat::Jpeg, false).is_ok());
    assert!(output::validate_destination(&path, &OutputFormat::Jpeg, true).is_err());
    let tif = dir.join("out.tif");
    assert!(output::validate_destination(&tif, &OutputFormat::Tiff, false).is_ok());
    assert!(output::validate_destination(&tif, &OutputFormat::Png, true).is_err());
    std::fs::write(&path, b"existing output").unwrap();
    assert!(output::validate_destination(&path, &OutputFormat::Png, false).is_err());
    assert!(output::validate_destination(&path, &OutputFormat::Png, true).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_format_follows_the_destination_extension() {
    use std::path::Path;
    for codec in dezoomify::model::OUTPUT_CODECS {
        for extension in codec.extensions {
            let name = if extension.is_empty() {
                "painting".to_string()
            } else {
                format!("painting.{extension}")
            };
            for name in [name.clone(), name.to_ascii_uppercase()] {
                assert_eq!(output::infer_from_path(Path::new(&name)), Ok(codec.format));
            }
        }
    }
    // Unknown extensions fail before any work starts, instead of writing a
    // mislabeled file. The error names every supported extension.
    let unknown = output::infer_from_path(Path::new("painting.not-an-image"));
    let error = unknown.expect_err("unknown output suffix stays unsupported");
    assert!(matches!(error, Error::UnsupportedExtension { .. }));
    for supported in dezoomify::model::output_extensions().split(", ") {
        assert!(
            error.to_string().contains(supported),
            "unsupported-extension error lists {supported}: {error}"
        );
    }
}

#[test]
fn output_destinations_validate_format_and_preserve_existing_content() {
    // An existing directory is always an iiif-dir destination.
    let dir = std::env::temp_dir().join(format!("dz-infer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(output::infer_from_path(&dir), Ok(OutputFormat::IiifDir));
    // An image extension never validates as a directory destination and a
    // directory never validates as a single file.
    assert!(
        output::validate_destination(&dir.join("x.png"), &OutputFormat::IiifDir, true).is_err()
    );
    assert!(output::validate_destination(&dir, &OutputFormat::Png, true).is_err());
    // A non-empty directory refuses without overwrite, like a file does.
    std::fs::write(dir.join("info.json"), b"{}").unwrap();
    assert!(output::validate_destination(&dir, &OutputFormat::IiifDir, false).is_err());
    assert!(output::validate_destination(&dir, &OutputFormat::IiifDir, true).is_err());
    // A `.zif` path validates as ZIF (never as single-image TIFF or PNG);
    // a `.iiif` path validates as a directory destination and never as a
    // single file.
    for (name, format, overwrite, valid) in [
        ("out.zif", OutputFormat::Zif, false, true),
        ("out.zif", OutputFormat::Tiff, true, false),
        ("out.zif", OutputFormat::Png, true, false),
        ("out.webp", OutputFormat::Webp, false, true),
        ("out.webp", OutputFormat::Jpeg, true, false),
        ("out.webp", OutputFormat::IiifDir, true, false),
        ("out.avif", OutputFormat::Avif, false, true),
        ("out.avif", OutputFormat::Jpeg, true, false),
        ("out.avif", OutputFormat::IiifDir, true, false),
    ] {
        assert_eq!(
            output::validate_destination(&dir.join(name), &format, overwrite).is_ok(),
            valid,
            "{name}: {format:?}"
        );
    }
    let iiif = dir.join("out.iiif");
    assert!(output::validate_destination(&iiif, &OutputFormat::IiifDir, false).is_ok());
    assert!(output::validate_destination(&iiif, &OutputFormat::Tiff, true).is_err());
    // Existing tile output is preserved even when overwrite is requested.
    std::fs::write(&iiif, b"stale").unwrap();
    assert!(output::validate_destination(&iiif, &OutputFormat::IiifDir, false).is_err());
    assert!(output::validate_destination(&iiif, &OutputFormat::IiifDir, true).is_err());
    assert_eq!(std::fs::read(&iiif).unwrap(), b"stale");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn existing_single_file_outputs_require_overwrite_without_changing_content() {
    let dir = dezoomify_fixture_server::temp_dir("existing-output");
    for codec in dezoomify::model::OUTPUT_CODECS
        .iter()
        .filter(|codec| !codec.format.is_directory())
    {
        let path = dir.join(format!("out.{}", codec.format.extension()));
        std::fs::write(&path, b"previous output").unwrap();
        assert!(output::validate_destination(&path, &codec.format, false).is_err());
        assert!(output::validate_destination(&path, &codec.format, true).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous output");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn transport_and_concurrency_defaults_match_documented_limits() {
    use dezoomify_native::http::FetchLimits;
    use dezoomify_native::JobOptions;
    let config = JobOptions::default();
    assert_eq!(config.max_concurrent, 16);
    assert_eq!(config.max_retries, 3);
    assert_eq!(config.pacing, None);
    let fetch = FetchLimits::default();
    assert_eq!(fetch.timeout, std::time::Duration::from_secs(30));
    assert_eq!(fetch.connect_timeout, std::time::Duration::from_secs(6));
    assert_eq!(fetch.max_idle_per_host, 32);
}
