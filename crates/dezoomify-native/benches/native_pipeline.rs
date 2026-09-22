//! Native pipeline benchmarks: end-to-end tile throughput on the shipped
//! exec path and encode time per format.
//!
//! The throughput bench runs the real `start_job` over four generated
//! local tiles (no network, no separate pool): it tracks the shipped
//! fetch/decode/assemble/encode path the driver uses, including the engine
//! concurrency budget.
//!
use criterion::{criterion_group, criterion_main, Criterion};
use dezoomify_native::pipeline::{encode_jpeg, encode_png, encode_tiff};
use dezoomify_native::{JobOptions, OutputTarget};
use std::hint::black_box;

#[path = "../tests/support/mod.rs"]
mod support;

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

/// Tile throughput: run the real `start_job` over four generated local
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
    let mut group = criterion.benchmark_group("tile-throughput");
    group.bench_function("native-runner-4-tiles", |bencher| {
        bencher.iter(|| {
            let options = JobOptions {
                input_url: black_box(&input).clone(),
                output: OutputTarget::File(black_box(&output).to_path_buf()),
                overwrite: true,
                ..JobOptions::default()
            };
            let outcome = support::run_options_observed(options, |_, _| {})
                .expect("native job service succeeds");
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

criterion_group!(benches, bench_tile_throughput, bench_encode_time);
criterion_main!(benches);
