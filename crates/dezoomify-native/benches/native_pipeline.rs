//! Native pipeline benchmarks (todo 3.1): tile throughput on the fixed pool,
//! encode time per format, and peak-RSS model for the 20k by 20k fixture.
//!
//! The 20k fixture itself (about 1.5 GiB of RGBA) is modeled, not allocated:
//! allocating it in a bench would OOM CI runners. The model compares the
//! legacy peak (decoded set plus canvas plus transient buffer) against the
//! streaming peak (canvas plus one tile plus file buffers) using the same
//! helpers the driver uses (`estimated_peak_*`, `should_spill`,
//! `required_memory_bytes`), so the bench tracks the shipped decision.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use dezoomify_native::pipeline::{
    encode_jpeg, encode_png, encode_tiff, estimated_peak_legacy_bytes,
    estimated_peak_streaming_bytes, required_memory_bytes, should_spill, MAX_CONCURRENT,
};
use dezoomify_native::pool::run_bounded;
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

/// Tile throughput: decode one cached 256 by 256 PNG on each pool job.
/// Measures the fixed-pool dispatch plus decode path that `acquire_tiles`
/// uses (fetch is loopback in integration tests; here the bytes are local).
fn bench_tile_throughput(criterion: &mut Criterion) {
    let tile = solid_tile_png();
    let mut group = criterion.benchmark_group("tile-throughput");
    for width in [4usize, 16usize] {
        group.bench_with_input(
            BenchmarkId::from_parameter(width),
            &width,
            |bencher, &width| {
                bencher.iter(|| {
                    let jobs: Vec<Box<dyn FnOnce() -> usize + Send>> = (0..width)
                        .map(|_| {
                            let bytes = tile.clone();
                            let boxed: Box<dyn FnOnce() -> usize + Send> = Box::new(move || {
                                let decoded =
                                    image::load_from_memory(&bytes).expect("tile decodes");
                                let rgba = decoded.to_rgba8();
                                black_box(rgba.width() + rgba.height()) as usize
                            });
                            boxed
                        })
                        .collect();
                    let out = run_bounded(jobs, MAX_CONCURRENT);
                    black_box(out.len())
                });
            },
        );
    }
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
    group.bench_function("40k-fails-canvas-limit", |bencher| {
        bencher.iter(|| {
            let required =
                required_memory_bytes(black_box(40_000), black_box(40_000)).expect("40k model");
            assert!(
                required > 8 << 30,
                "40k with its encode buffer must exceed the 8 GiB desktop budget"
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
