//! Native pipeline benchmarks: end-to-end tile throughput on the shipped
//! exec path, encode time per format, and the peak-RSS model for the 20k by
//! 20k fixture.
//!
//! The throughput bench runs the real `pipeline::run` over four generated
//! local tiles (no network, no separate pool): it tracks the shipped
//! fetch/decode/assemble/encode path the driver uses, including the engine
//! concurrency budget.
//!
//! The 20k fixture itself (about 1.5 GiB of RGBA) is modeled, not allocated:
//! allocating it in a bench would OOM CI runners. The model compares the
//! legacy peak (decoded set plus canvas plus transient buffer) against the
//! streaming peak (canvas plus one tile plus file buffers) using the same
//! helpers the driver uses (`estimated_peak_*`, `should_spill`,
//! `required_memory_bytes`), so the bench tracks the shipped decision.

use criterion::{criterion_group, criterion_main, Criterion};
use dezoomify_native::pipeline::{
    self, canvas_bytes, encode_jpeg, encode_png, encode_tiff, estimated_peak_legacy_bytes,
    estimated_peak_streaming_bytes, required_memory_bytes, should_spill, PipelineConfig,
};
use std::hint::black_box;

fn sweep_image(width: u32, height: u32) -> image::RgbaImage {
    let mut image = image::RgbaImage::new(width, height);
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

fn solid_tile_png() -> Vec<u8> {
    let mut image = image::RgbaImage::new(256, 256);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
    }
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        256,
        256,
        image::ExtendedColorType::Rgba8,
    )
    .expect("tile encodes");
    bytes
}

/// Tile throughput: run the real `pipeline::run` over four generated local
/// tiles per iteration (fetch is the local fast path; decode, assemble,
/// and encode are the shipped code). The output reuses one path with
/// overwrite so every iteration measures the full publish.
fn bench_tile_throughput(criterion: &mut Criterion) {
    let work = std::env::temp_dir().join(format!("dezoomify-bench-tiles-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("bench dir");
    let tile = solid_tile_png();
    for name in ["tile-0_0", "tile-1_0", "tile-0_1", "tile-1_1"] {
        std::fs::write(work.join(format!("{name}.png")), &tile).expect("write tile");
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
         title: \"Bench tiles\"\n"
    );
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, yaml.as_bytes()).expect("write manifest");
    let input = manifest.to_str().expect("utf8 manifest").to_string();
    let output = work.join("bench.png");
    let output_str = output.to_str().expect("utf8 output").to_string();
    let config = PipelineConfig::default();
    let mut group = criterion.benchmark_group("tile-throughput");
    group.bench_function("pipeline-4-tiles", |bencher| {
        bencher.iter(|| {
            let outcome = pipeline::run(
                black_box(&input),
                black_box(&output_str),
                true,
                black_box(&config),
                &mut |_| {},
            )
            .expect("pipeline succeeds");
            black_box(outcome.tile_count)
        });
    });
    group.finish();
}

/// Encode time per format on a 256 by 256 sweep fixture (deterministic bytes,
/// small enough for CI, same code path as the driver publish).
fn bench_encode_time(criterion: &mut Criterion) {
    let image = sweep_image(256, 256);
    let mut group = criterion.benchmark_group("encode-time");
    group.bench_function("png-fast", |bencher| {
        bencher.iter(|| {
            let bytes = encode_png(
                black_box(&image),
                image::codecs::png::CompressionType::Fast,
                None,
                None,
            )
            .expect("png encodes");
            black_box(bytes.len())
        });
    });
    group.bench_function("jpeg-95", |bencher| {
        bencher.iter(|| {
            let bytes = encode_jpeg(black_box(&image), 95, None).expect("jpeg encodes");
            black_box(bytes.len())
        });
    });
    group.bench_function("tiff-fast", |bencher| {
        bencher.iter(|| {
            let bytes = encode_tiff(black_box(&image), 5, None).expect("tiff encodes");
            black_box(bytes.len())
        });
    });
    group.finish();
}

/// Peak-RSS model for the 20k by 20k fixture plus the 40k canvas-limit gate.
/// No gigapixel allocation: the same pure helpers the driver calls decide
/// spill and budget, so a regression in the model is a regression in the
/// shipped gate.
fn bench_peak_rss_model(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("peak-rss-20k");
    group.bench_function("streaming-halves-legacy", |bencher| {
        bencher.iter(|| {
            let legacy = estimated_peak_legacy_bytes(black_box(20_000), black_box(20_000))
                .expect("legacy model");
            let streaming = estimated_peak_streaming_bytes(black_box(20_000), black_box(20_000))
                .expect("streaming model");
            assert!(
                streaming * 2 <= legacy,
                "streaming peak must be at most half the legacy peak"
            );
            assert!(should_spill(20_000, 20_000), "20k canvas spills");
            black_box((legacy, streaming))
        });
    });
    group.bench_function("large-canvas-memory-model", |bencher| {
        bencher.iter(|| {
            let required =
                required_memory_bytes(black_box(200_000), black_box(200_000)).expect("200k model");
            assert!(
                required > canvas_bytes(200_000, 200_000).expect("200k canvas"),
                "the model includes the transient encode buffer"
            );
            black_box(required)
        });
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_tile_throughput,
    bench_encode_time,
    bench_peak_rss_model
);
criterion_main!(benches);
