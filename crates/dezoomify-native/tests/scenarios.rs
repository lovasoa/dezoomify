//! Native scenario tests: header scope, redirects, cache, limits.

use dezoomify_native::auth::{AuthorizationScope, EphemeralAuthorization};
use dezoomify_native::cache;
use dezoomify_native::client;
use dezoomify_native::download::{Scheduler, SchedulerConfig};
use dezoomify_native::output::{self, OutputFormat};
use std::collections::{BTreeMap, HashMap};

#[test]
fn auth_reaches_only_matching_requests() {
    let scope = AuthorizationScope {
        scheme: "https".into(),
        host: "fixtures.test".into(),
        port: None,
        path_prefix: "/private/".into(),
        job_id: None,
    };
    let auth = EphemeralAuthorization::new(
        scope,
        HashMap::from([("session".to_string(), "CANARY".to_string())]),
    )
    .unwrap();
    let matching = client::build_request(
        "https://fixtures.test/private/item",
        &BTreeMap::new(),
        Some(&auth),
    )
    .unwrap();
    assert!(matching.headers.contains_key("cookie"));
    let sibling = client::build_request(
        "https://other.test/private/item",
        &BTreeMap::new(),
        Some(&auth),
    )
    .unwrap();
    assert!(!sibling.headers.contains_key("cookie"));
    let redirect =
        client::rebuild_for_redirect(&matching, "https://evil.test/private/item", Some(&auth))
            .unwrap();
    assert!(!redirect.headers.contains_key("cookie"));
}

#[test]
fn public_headers_reject_cookie_and_authorization() {
    let mut extra = BTreeMap::new();
    extra.insert("Cookie".to_string(), "x=1".to_string());
    assert!(client::build_request("https://fixtures.test/x", &extra, None).is_err());
}

#[test]
fn scheduler_bounds_concurrency_and_tiles() {
    let mut scheduler = Scheduler::new(SchedulerConfig {
        max_concurrent: 2,
        max_tiles: 3,
        max_retries: 1,
    });
    assert!(scheduler.push("a".into()).is_ok());
    assert!(scheduler.push("b".into()).is_ok());
    assert!(scheduler.push("c".into()).is_ok());
    assert!(scheduler.push("d".into()).is_err());
    let batch = scheduler.next_batch();
    assert_eq!(batch.len(), 2);
    assert_eq!(scheduler.peak_in_flight(), 2);
}

#[test]
fn scheduler_retries_failures_then_gives_up() {
    let mut scheduler = Scheduler::new(SchedulerConfig {
        max_concurrent: 2,
        max_tiles: 3,
        max_retries: 1,
    });
    scheduler.push("a".into()).unwrap();
    let batch = scheduler.next_batch();
    assert_eq!(batch, vec!["a".to_string()]);
    // First failure is retryable (attempts 1 <= max_retries 1).
    assert!(scheduler.fail("a").unwrap());
    assert_eq!(scheduler.next_batch(), vec!["a".to_string()]);
    // Second failure exhausts the retry budget.
    assert!(!scheduler.fail("a").unwrap());
    // No retry is scheduled after exhaustion.
    assert_eq!(scheduler.next_batch(), Vec::<String>::new());
    assert_eq!(scheduler.done_count(), 0);
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
fn output_refuses_mismatch_without_overwrite_and_replaces_stale_temp() {
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
    // A stale temp file left by an interrupted write must not leak into the
    // next write: the atomic write replaces both the temp and the output.
    let stale_tmp = path.with_extension("tmp");
    std::fs::write(&stale_tmp, b"stale-garbage").unwrap();
    output::write_atomic(&path, b"png-bytes").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"png-bytes");
    assert!(!stale_tmp.exists(), "temp file must be gone after rename");
    assert!(output::validate_destination(&path, &OutputFormat::Png, false).is_err());
    assert!(output::validate_destination(&path, &OutputFormat::Png, true).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_format_follows_the_destination_extension() {
    use std::path::Path;
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.png")),
        Ok(output::OutputFormat::Png)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.jpg")),
        Ok(output::OutputFormat::Jpeg)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.jpeg")),
        Ok(output::OutputFormat::Jpeg)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.tif")),
        Ok(output::OutputFormat::Tiff)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.tiff")),
        Ok(output::OutputFormat::Tiff)
    );
    // `.zif` selects the TIFF encoder (single-image re-encode); `.iiif`
    // selects an `iiif-dir` tree at that path. Both triggers mirror the
    // reference extensions while `iiif-dir` keeps working too.
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.zif")),
        Ok(output::OutputFormat::Tiff)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.ZIF")),
        Ok(output::OutputFormat::Tiff)
    );
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting.iiif")),
        Ok(output::OutputFormat::IiifDir)
    );
    // Extensionless paths name an iiif-dir directory destination.
    assert_eq!(
        output::OutputFormat::infer_from_path(Path::new("painting")),
        Ok(output::OutputFormat::IiifDir)
    );
    // Unknown extensions fail before any work starts, instead of writing a
    // mislabeled file.
    assert!(output::OutputFormat::infer_from_path(Path::new("painting.bmp")).is_err());
    assert!(output::OutputFormat::infer_from_path(Path::new("painting.webp")).is_err());
    // An existing directory is always an iiif-dir destination.
    let dir = std::env::temp_dir().join(format!("dz-infer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(
        output::OutputFormat::infer_from_path(&dir),
        Ok(output::OutputFormat::IiifDir)
    );
    // An image extension never validates as a directory destination and a
    // directory never validates as a single file.
    assert!(
        output::validate_destination(&dir.join("x.png"), &output::OutputFormat::IiifDir, true)
            .is_err()
    );
    assert!(output::validate_destination(&dir, &output::OutputFormat::Png, true).is_err());
    // A non-empty directory refuses without overwrite, like a file does.
    std::fs::write(dir.join("info.json"), b"{}").unwrap();
    assert!(output::validate_destination(&dir, &output::OutputFormat::IiifDir, false).is_err());
    assert!(output::validate_destination(&dir, &output::OutputFormat::IiifDir, true).is_ok());
    // A `.zif` path validates as TIFF; a `.iiif` path validates as a
    // directory destination and never as a single file.
    let zif = dir.join("out.zif");
    assert!(output::validate_destination(&zif, &output::OutputFormat::Tiff, false).is_ok());
    assert!(output::validate_destination(&zif, &output::OutputFormat::Png, true).is_err());
    let iiif = dir.join("out.iiif");
    assert!(output::validate_destination(&iiif, &output::OutputFormat::IiifDir, false).is_ok());
    assert!(output::validate_destination(&iiif, &output::OutputFormat::Tiff, true).is_err());
    // A stale file at a `.iiif` path refuses without overwrite but is
    // replaced with overwrite (reference removes the file first).
    std::fs::write(&iiif, b"stale").unwrap();
    assert!(output::validate_destination(&iiif, &output::OutputFormat::IiifDir, false).is_err());
    assert!(output::validate_destination(&iiif, &output::OutputFormat::IiifDir, true).is_ok());
    output::write_iiif_dir(&iiif, b"{}", &Vec::new()).unwrap();
    assert!(iiif.is_dir());
    assert!(iiif.join("info.json").is_file());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn jpeg_and_tiff_encode_and_decode_round_trip() {
    use dezoomify_native::pipeline::{encode_jpeg, encode_tiff, JPEG_QUALITY};
    let mut image = image::RgbaImage::new(16, 16);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x * 16) as u8, (y * 16) as u8, 128, 255]);
    }
    let jpeg = encode_jpeg(&image, JPEG_QUALITY, None).expect("jpeg encodes");
    assert!(
        jpeg.starts_with(&[0xFF, 0xD8, 0xFF]),
        "jpeg output carries the SOI marker"
    );
    let decoded = image::load_from_memory(&jpeg)
        .expect("jpeg decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (16, 16));
    let tiff = encode_tiff(&image, None).expect("tiff encodes");
    let decoded = image::load_from_memory(&tiff)
        .expect("tiff decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (16, 16));
    assert_eq!(decoded.get_pixel(3, 5), image.get_pixel(3, 5));
}

#[test]
fn transport_and_concurrency_defaults_match_reference_tuning() {
    use dezoomify_native::http::FetchLimits;
    use dezoomify_native::pipeline::PipelineConfig;
    let config = PipelineConfig::default();
    assert_eq!(config.max_concurrent, 16);
    assert_eq!(config.max_retries, 3);
    assert_eq!(config.retry_delay, std::time::Duration::from_secs(2));
    assert_eq!(config.min_interval, std::time::Duration::ZERO);
    let fetch = FetchLimits::default();
    assert_eq!(fetch.timeout, std::time::Duration::from_secs(30));
    assert_eq!(fetch.connect_timeout, std::time::Duration::from_secs(6));
    assert_eq!(fetch.max_idle_per_host, 32);
}

#[test]
fn jpeg_rejects_canvases_beyond_its_side_limit() {
    use dezoomify_native::pipeline::encode_jpeg;
    // A 1x1 stand-in cannot allocate gigapixels; assert the guard directly
    // through the dimension check on a wide image instead.
    let wide = image::RgbaImage::new(65_536, 1);
    let error = encode_jpeg(&wide, 92, None).expect_err("jpeg side limit applies");
    assert_eq!(error.code, "output.encode-failed");
}
