//! Independent rendering requires Poppler; run through `cargo xtask test pdf`.
use dezoomify_native::{JobOptions, NativeHost, OutputDocument, OutputTarget};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn fixture(directory: &Path, alpha: bool) -> (PathBuf, image::RgbaImage) {
    let input = directory.join("image.dzi");
    let tiles = directory.join("image_files/6");
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&input, "<Image TileSize=\"16\" Overlap=\"3\" Format=\"png\"><Size Width=\"33\" Height=\"25\"/></Image>").unwrap();
    let mut expected = image::RgbaImage::from_pixel(33, 25, image::Rgba([255, 255, 255, 255]));
    for row in 0..2u32 {
        for column in 0..3u32 {
            let x = column * 16;
            let y = row * 16;
            let left = x.saturating_sub(3);
            let top = y.saturating_sub(3);
            // Deliberately pad edge payloads beyond their declared extents.
            let pixels = image::RgbaImage::from_fn(22, 22, |px, py| {
                image::Rgba([
                    (left + px) as u8 * 5,
                    (top + py) as u8 * 6,
                    90,
                    if alpha { ((left + px) * 5) as u8 } else { 255 },
                ])
            });
            let bytes = if alpha {
                dezoomify_native::imaging::encode_png(
                    &pixels,
                    image::codecs::png::CompressionType::Fast,
                    None,
                    None,
                )
                .unwrap()
            } else {
                dezoomify_native::imaging::encode_jpeg(&pixels, 90, None).unwrap()
            };
            let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
            let clipped = image::imageops::crop_imm(
                &decoded,
                x - left,
                y - top,
                16.min(33 - x),
                16.min(25 - y),
            )
            .to_image();
            image::imageops::overlay(&mut expected, &clipped, i64::from(x), i64::from(y));
            std::fs::write(tiles.join(format!("{column}_{row}.png")), bytes).unwrap();
        }
    }
    (input, expected)
}

#[test]
#[ignore = "requires Poppler; run cargo xtask test pdf"]
fn rendered_pages_preserve_orientation_padding_overlap_and_transparency() {
    for alpha in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (input, expected) = fixture(directory.path(), alpha);
        let pdf = directory.path().join("image.pdf");
        let host = NativeHost::new(JobOptions {
            input_url: input.to_string_lossy().into(),
            output: OutputTarget::File(pdf.clone()),
            largest: true,
            cache_dir: Some(directory.path().join("cache")),
            ..Default::default()
        })
        .unwrap();
        host.transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .unwrap();
        let rendered = Command::new("pdftoppm")
            .args(["-png", "-r", "72", "-singlefile"])
            .arg(&pdf)
            .arg(directory.path().join("rendered"))
            .output()
            .expect("install Poppler's pdftoppm");
        assert!(
            rendered.status.success(),
            "{}",
            String::from_utf8_lossy(&rendered.stderr)
        );
        assert!(
            rendered.stderr.is_empty(),
            "a valid PDF needs no repair: {}",
            String::from_utf8_lossy(&rendered.stderr)
        );
        let actual = image::open(directory.path().join("rendered.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(actual.dimensions(), expected.dimensions());
        for ((x, y, actual), expected) in actual.enumerate_pixels().zip(expected.pixels()) {
            assert!(
                actual
                    .0
                    .iter()
                    .zip(expected.0)
                    .all(|(a, e)| a.abs_diff(e) <= 3),
                "pixel ({x},{y}) {actual:?} != {expected:?}; alpha={alpha}"
            );
        }
    }
}

#[test]
#[ignore = "requires Poppler; run cargo xtask test pdf"]
fn interrupted_document_renders_without_repair() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("partial.pdf");
    let mut document = OutputDocument::new(OutputTarget::File(output.clone()), false).unwrap();
    for incomplete in [false, true] {
        let source = directory
            .path()
            .join(if incomplete { "incomplete" } else { "complete" });
        let (input, _) = fixture(&source, false);
        if incomplete {
            std::fs::remove_file(source.join("image_files/6/2_1.png")).unwrap();
        }
        let host = NativeHost::new(JobOptions {
            input_url: input.to_string_lossy().into(),
            output: OutputTarget::File(output.clone()),
            largest: true,
            max_concurrent: 1,
            cache_dir: Some(source.join("cache")),
            ..Default::default()
        })
        .unwrap()
        .with_document_page(document.page().unwrap())
        .unwrap();
        let result = host.transport.block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ));
        assert_eq!(result.is_err(), incomplete);
    }
    assert_eq!(document.finish().unwrap().unwrap().pages, 1);
    let rendered = Command::new("pdftoppm")
        .args(["-png", "-r", "72", "-singlefile"])
        .arg(output)
        .arg(directory.path().join("rendered"))
        .output()
        .unwrap();
    assert!(rendered.status.success(), "{rendered:?}");
    assert!(rendered.stderr.is_empty(), "{rendered:?}");
    assert_eq!(
        image::open(directory.path().join("rendered.png"))
            .unwrap()
            .width(),
        33
    );
}
