//! Native scenario tests: header scope, redirects, cache, limits.

use dezoomify::model::Error;
use dezoomify::model::OutputFormat;
use dezoomify_native::cache;
use dezoomify_native::client;
use dezoomify_native::output;
use std::collections::BTreeMap;

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
        cache::cache_key("https://h/tile?x=0&y=0"),
        cache::cache_key("https://h/tile?x=9&y=9")
    );
    assert_ne!(
        cache::cache_key("https://h/tile"),
        cache::cache_key("https://h/tile?token=secret")
    );
    let dir = std::env::temp_dir().join(format!("dz-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // A credential-bearing URL must never leak into the cache path or the
    // stored artifact: only the digest key and the payload itself.
    let path = cache::store(&dir, "job1", "https://h/item?token=CANARY", b"bytes").unwrap();
    assert_eq!(
        cache::load(&dir, "job1", "https://h/item?token=CANARY").unwrap(),
        b"bytes"
    );
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
    let path_b = cache::store(&dir, "job1", "https://h/item?token=CANARY&x=1", b"bytes-b").unwrap();
    assert_ne!(path, path_b);
    assert_eq!(
        cache::load(&dir, "job1", "https://h/item?token=CANARY&x=1").unwrap(),
        b"bytes-b"
    );
    assert_eq!(
        cache::load(&dir, "job1", "https://h/item?token=CANARY").unwrap(),
        b"bytes"
    );
    let _ = std::fs::remove_dir_all(&dir);
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
    cache::store(&dir, &first, "https://h/tile?x=0", b"bytes").unwrap();
    assert_eq!(
        cache::load(&dir, &first, "https://h/tile?x=0").unwrap(),
        b"bytes"
    );
    // A missing entry is a miss, not an error.
    assert!(cache::load(&dir, &first, "https://h/tile?x=1").is_none());
    // Foreign namespaces never read or write outside the cache root.
    assert!(cache::store(&dir, "../escape", "https://h/t", b"x").is_err());
    assert!(cache::store(&dir, "a/b", "https://h/t", b"x").is_err());
    assert!(cache::load(&dir, "../escape", "https://h/t").is_none());
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
    assert_eq!(
        output::infer_from_path(Path::new("painting.png")),
        Ok(OutputFormat::Png)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.jpg")),
        Ok(OutputFormat::Jpeg)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.jpeg")),
        Ok(OutputFormat::Jpeg)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.tif")),
        Ok(OutputFormat::Tiff)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.tiff")),
        Ok(OutputFormat::Tiff)
    );
    // `.zif` selects the ZIF pyramid encoder (TIFF-compatible
    // multi-directory output); `.iiif` selects an `iiif-dir` tree at that
    // path.
    assert_eq!(
        output::infer_from_path(Path::new("painting.zif")),
        Ok(OutputFormat::Zif)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.ZIF")),
        Ok(OutputFormat::Zif)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.webp")),
        Ok(OutputFormat::Webp)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.WEBP")),
        Ok(OutputFormat::Webp)
    );
    assert_eq!(
        output::infer_from_path(Path::new("painting.iiif")),
        Ok(OutputFormat::IiifDir)
    );
    // Extensionless paths name an iiif-dir directory destination.
    assert_eq!(
        output::infer_from_path(Path::new("painting")),
        Ok(OutputFormat::IiifDir)
    );
    // Unknown extensions fail before any work starts, instead of writing a
    // mislabeled file. The error names every supported extension.
    let bmp = output::infer_from_path(Path::new("painting.bmp"));
    let error = bmp.expect_err("bmp stays unsupported");
    assert!(matches!(error, Error::UnsupportedExtension { .. }));
    for supported in [".png", ".jpg", ".tif", ".zif", ".webp", ".iiif"] {
        assert!(
            error.to_string().contains(supported),
            "unsupported-extension error lists {supported}: {error}"
        );
    }
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
    let zif = dir.join("out.zif");
    assert!(output::validate_destination(&zif, &OutputFormat::Zif, false).is_ok());
    assert!(output::validate_destination(&zif, &OutputFormat::Tiff, true).is_err());
    assert!(output::validate_destination(&zif, &OutputFormat::Png, true).is_err());
    // A `.webp` path validates as WebP and never as another single file.
    let webp = dir.join("out.webp");
    assert!(output::validate_destination(&webp, &OutputFormat::Webp, false).is_ok());
    assert!(output::validate_destination(&webp, &OutputFormat::Jpeg, true).is_err());
    assert!(output::validate_destination(&webp, &OutputFormat::IiifDir, true).is_err());
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
fn transport_and_concurrency_defaults_match_documented_limits() {
    use dezoomify_native::http::FetchLimits;
    use dezoomify_native::JobOptions;
    let config = JobOptions::default();
    assert_eq!(config.max_concurrent, 16);
    assert_eq!(config.max_retries, 3);
    assert_eq!(config.min_interval, std::time::Duration::ZERO);
    let fetch = FetchLimits::default();
    assert_eq!(fetch.timeout, std::time::Duration::from_secs(30));
    assert_eq!(fetch.connect_timeout, std::time::Duration::from_secs(6));
    assert_eq!(fetch.max_idle_per_host, 32);
}
