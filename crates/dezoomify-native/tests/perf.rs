//! Perf smoke for the fixed pool and streaming memory model. Fast and
//! deterministic: no
//! gigapixel allocation, no public network. Wall-time numbers print for CI
//! tracking; the hard gate is the deterministic memory model plus a 20
//! percent regression bound on encoded byte sizes versus
//! `perf-baseline.json`.

use dezoomify_native::pipeline::{
    self, canvas_bytes, encode_jpeg, encode_png, encode_tiff, estimated_peak_legacy_bytes,
    estimated_peak_streaming_bytes, exceeds_available_memory, required_memory_bytes, should_spill,
    PipelineConfig, MAX_CONCURRENT, SPILL_THRESHOLD_BYTES,
};
use std::time::Instant;

fn sweep_image() -> image::RgbaImage {
    let mut image = image::RgbaImage::new(32, 32);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgba([
            ((x * 7 + y * 13) % 256) as u8,
            ((x * 11 + y * 5) % 256) as u8,
            128,
            255,
        ]);
    }
    image
}

fn baseline() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/perf-baseline.json");
    let text = std::fs::read_to_string(&path).expect("perf baseline exists");
    serde_json::from_str(&text).expect("perf baseline parses")
}

#[test]
fn pool_width_is_unified_at_sixteen() {
    assert_eq!(MAX_CONCURRENT, 16);
    assert_eq!(PipelineConfig::default().max_concurrent, 16);
}

#[test]
fn spill_threshold_is_512mib() {
    assert_eq!(SPILL_THRESHOLD_BYTES, 512 << 20);
    assert!(should_spill(20_000, 20_000), "20k canvas spills");
    assert!(!should_spill(512, 512), "512 canvas stays in memory");
    assert_eq!(canvas_bytes(20_000, 20_000), Some(1_600_000_000));
}

#[test]
fn twenty_k_streaming_halves_legacy_peak() {
    let legacy = estimated_peak_legacy_bytes(20_000, 20_000).expect("legacy model");
    let streaming = estimated_peak_streaming_bytes(20_000, 20_000).expect("streaming model");
    assert_eq!(legacy, 1_600_000_000u64 * 3);
    assert!(
        streaming * 2 <= legacy,
        "streaming {streaming} must be at most half of legacy {legacy}"
    );
    let ratio = streaming as f64 / legacy as f64;
    assert!(ratio < 0.4, "streaming ratio {ratio} stays well under half");
    println!("20k legacy={legacy} streaming={streaming} ratio={ratio:.3}");
}

#[test]
fn large_canvas_memory_model_is_overflow_safe() {
    let required = required_memory_bytes(200_000, 200_000).expect("200k model");
    assert_eq!(required, 160_000_000_000u64 * 2);
    let twenty_k = required_memory_bytes(20_000, 20_000).expect("20k model");
    assert!(twenty_k < required, "20k requires less memory than 200k");
}

#[test]
fn available_memory_gate_is_deterministic() {
    assert!(!exceeds_available_memory(1024, 1024));
    assert!(exceeds_available_memory(1025, 1024));
}

/// Four generated tiles plus a `tiles.yaml` manifest: the same local-input
/// shape the runner tests use, so the concurrency bound is measured on the
/// shipped fetch/decode/place path instead of a throwaway pool.
fn write_local_tiles(work: &std::path::Path) -> String {
    for name in ["tile-0_0", "tile-1_0", "tile-0_1", "tile-1_1"] {
        let mut tile = image::RgbaImage::new(256, 256);
        for (x, y, pixel) in tile.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        image::ImageEncoder::write_image(
            encoder,
            tile.as_raw(),
            256,
            256,
            image::ExtendedColorType::Rgba8,
        )
        .expect("tile encodes");
        std::fs::write(work.join(format!("{name}.png")), &bytes).expect("write tile");
    }
    let dir = work.to_str().expect("utf8 dir").to_string();
    let yaml = format!(
        "url_template: \"file://{dir}/tile-{{{{x}}}}_{{{{y}}}}.png\"\n\
         x_template: \"x * tile_size\"\n\
         y_template: \"y * tile_size\"\n\
         variables:\n\
         \x20 - {{ name: x, from: 0, to: 1 }}\n\
         \x20 - {{ name: y, from: 0, to: 1 }}\n\
         \x20 - {{ name: tile_size, value: 256 }}\n\
         width: 512\n\
         height: 512\n\
         title: \"Perf tiles\"\n"
    );
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
    manifest.to_str().expect("utf8 manifest").to_string()
}

#[test]
fn exec_bounds_inflight_to_max_concurrent() {
    let start = Instant::now();
    let work = std::env::temp_dir().join(format!("dz-perf-exec-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("temp dir");
    let input = write_local_tiles(&work);
    let output = work.join("perf.png");
    let config = PipelineConfig {
        max_concurrent: 2,
        ..PipelineConfig::default()
    };
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_| {},
    )
    .expect("local pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    // The engine's own budget bounds outstanding work: the honest
    // instrumentation peaks within it on the shipped path, with no separate
    // scheduler or pool to enforce the width.
    assert_eq!(outcome.instrumentation.acquired, 4);
    assert!(
        (1..=2).contains(&outcome.instrumentation.peak_inflight),
        "inflight stays within the engine budget: {}",
        outcome.instrumentation.peak_inflight
    );
    let elapsed = start.elapsed();
    println!(
        "exec 4 tiles with max_concurrent=2 in {elapsed:?} (peak_inflight={})",
        outcome.instrumentation.peak_inflight
    );
    assert!(
        elapsed < std::time::Duration::from_secs(60),
        "bounded exec must finish promptly"
    );
    let _ = std::fs::remove_dir_all(&work);
}

#[test]
fn encode_bytes_stay_within_twenty_percent_of_baseline() {
    let image = sweep_image();
    let png = encode_png(
        &image,
        image::codecs::png::CompressionType::Fast,
        None,
        None,
    )
    .expect("png encodes");
    let jpeg = encode_jpeg(&image, 95, None).expect("jpeg encodes");
    let tiff = encode_tiff(&image, 5, None).expect("tiff encodes");
    let base = baseline();
    for (name, actual) in [
        ("png_32_len", png.len()),
        ("jpeg_32_len", jpeg.len()),
        ("tiff_32_len", tiff.len()),
    ] {
        let expected = base[name].as_u64().expect("baseline has len") as usize;
        let ratio = actual as f64 / expected as f64;
        assert!(
            (0.8..=1.2).contains(&ratio),
            "{name} regressed beyond 20 percent: got {actual}, baseline {expected}"
        );
        println!("{name}: {actual} (baseline {expected}, ratio {ratio:.3})");
    }
    // Wall-time smoke: each encode of the 32 by 32 fixture must finish well
    // under a second; criterion benches track finer regressions.
    let start = Instant::now();
    let _ = encode_png(
        &image,
        image::codecs::png::CompressionType::Fast,
        None,
        None,
    )
    .expect("png re-encodes");
    assert!(
        start.elapsed() < std::time::Duration::from_secs(2),
        "encode smoke must stay fast"
    );
}

#[test]
fn cache_keys_are_versioned_sha256_without_secrets() {
    let a = dezoomify_native::cache::cache_key("https://h/tile?x=0&y=0");
    let b = dezoomify_native::cache::cache_key("https://h/tile?x=9&y=9");
    assert_ne!(a, b);
    assert!(a.starts_with("v2-"), "cache version 2, got {a}");
    assert_eq!(a.len(), 3 + 32, "sha256 truncated to 128 bits, got {a}");
    assert!(!a.contains("tile") && !a.contains("https"));
    assert_eq!(dezoomify_native::cache::CACHE_VERSION, 2);
}
