//! Perf smoke for the real native pipeline. Fast and deterministic: no
//! public network. Wall-time numbers print for CI tracking; hard gates cover
//! actual bounded pipeline instrumentation plus a 20 percent regression
//! bound on encoded byte sizes versus `perf-baseline.json`.

use dezoomify_native::pipeline::{
    self, encode_jpeg, encode_png, encode_tiff, exceeds_available_memory, required_memory_bytes,
    PipelineConfig, MAX_CONCURRENT,
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

/// Grid-shaped local inputs for the scaling test: `grid` by `grid` tiles of
/// `tile_px`, the same local-input shape the runner tests use, so scaling is
/// measured on the shipped fetch/decode/place path.
fn write_local_tiles_grid(work: &std::path::Path, grid: u32, tile_px: u32) -> String {
    for x in 0..grid {
        for y in 0..grid {
            let mut tile = image::RgbaImage::new(tile_px, tile_px);
            for (px, py, pixel) in tile.enumerate_pixels_mut() {
                *pixel = image::Rgba([
                    ((px + x * 13) % 256) as u8,
                    ((py + y * 29) % 256) as u8,
                    128,
                    255,
                ]);
            }
            let mut bytes = Vec::new();
            let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
            image::ImageEncoder::write_image(
                encoder,
                tile.as_raw(),
                tile_px,
                tile_px,
                image::ExtendedColorType::Rgba8,
            )
            .expect("tile encodes");
            std::fs::write(work.join(format!("tile-{x}_{y}.png")), &bytes).expect("write tile");
        }
    }
    let edge = grid * tile_px;
    let dir = work.to_str().expect("utf8 dir").to_string();
    let yaml = format!(
        "url_template: \"file://{dir}/tile-{{{{x}}}}_{{{{y}}}}.png\"\n\
         x_template: \"x * tile_size\"\n\
         y_template: \"y * tile_size\"\n\
         variables:\n\
         \x20 - {{ name: x, from: 0, to: {} }}\n\
         \x20 - {{ name: y, from: 0, to: {} }}\n\
         \x20 - {{ name: tile_size, value: {tile_px} }}\n\
         width: {edge}\n\
         height: {edge}\n\
         title: \"Scaling tiles\"\n",
        grid - 1,
        grid - 1,
    );
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
    manifest.to_str().expect("utf8 manifest").to_string()
}

/// Scheduling scaling on the REAL pipeline: 1/16/64/256-tile grids through
/// the shipped `pipeline::run` (local fetch, decode, assemble, encode).
/// In-flight descriptors stay within the engine slot budget at every shape
/// while completions track the plan exactly (linear by construction).
#[test]
fn exec_scales_with_bounded_inflight_across_increasing_tile_counts() {
    use std::time::Instant;
    let work = std::env::temp_dir().join(format!("dz-perf-scale-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("temp dir");
    const BUDGET: usize = 8;
    let mut table = Vec::new();
    for grid in [1u32, 4, 8, 16] {
        let expected = (grid * grid) as usize;
        // The local-input route matches the `tiles.yaml` filename, so each
        // shape gets its own directory.
        let shape = work.join(format!("grid-{grid}"));
        std::fs::create_dir_all(&shape).expect("shape dir");
        let input = write_local_tiles_grid(&shape, grid, 64);
        let output = work.join(format!("scale-{grid}.png"));
        let config = PipelineConfig {
            max_concurrent: BUDGET,
            ..PipelineConfig::default()
        };
        let start = Instant::now();
        let outcome = pipeline::run(
            &input,
            output.to_str().expect("utf8 output"),
            false,
            &config,
            &mut |_| {},
        )
        .expect("local pipeline succeeds");
        let elapsed = start.elapsed();
        assert_eq!(
            outcome.tile_count, expected,
            "plan size for {grid}x{grid} grid"
        );
        assert_eq!(
            outcome.instrumentation.acquired, expected as u64,
            "completions track the plan for {grid}x{grid} grid"
        );
        assert!(
            (1..=BUDGET).contains(&outcome.instrumentation.peak_inflight),
            "inflight stays within the engine budget at {expected} tiles: {}",
            outcome.instrumentation.peak_inflight
        );
        assert!(
            elapsed < std::time::Duration::from_secs(120),
            "scaling shape {expected} tiles must finish promptly"
        );
        table.push((expected, outcome.instrumentation.peak_inflight, elapsed));
    }
    for (tiles, peak, elapsed) in &table {
        println!("native scaling: tiles={tiles} peak_inflight={peak} elapsed={elapsed:?}");
    }
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
