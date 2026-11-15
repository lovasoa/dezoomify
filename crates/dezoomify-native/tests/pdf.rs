//! Native document behavior, inspected with an independent lightweight PDF reader.
use dezoomify::{
    model::{Error, OutputDisposition, OutputFormat},
    Host,
};
use dezoomify_native::{JobOptions, NativeHost, OutputDocument, OutputTarget};
use hayro_syntax::{object::Stream, Pdf};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};

fn source(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(format!("{name}.dzi"));
    let tiles = directory.join(format!("{name}_files/4"));
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&path, "<Image TileSize=\"16\" Overlap=\"0\" Format=\"jpg\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"16\" Height=\"16\"/></Image>").unwrap();
    std::fs::write(tiles.join("0_0.jpg"), bytes).unwrap();
    path
}

fn options(input: &Path, output: &Path) -> JobOptions {
    JobOptions {
        input_url: input.to_string_lossy().into(),
        output: OutputTarget::File(output.into()),
        largest: true,
        compression: 99,
        cache_dir: Some(output.parent().unwrap().join("cache")),
        ..Default::default()
    }
}

fn jpeg(color: [u8; 4]) -> Vec<u8> {
    dezoomify_native::imaging::encode_jpeg(
        &image::RgbaImage::from_pixel(16, 16, image::Rgba(color)),
        83,
        None,
    )
    .unwrap()
}

fn payloads(pdf: &Pdf, page: usize) -> Vec<Vec<u8>> {
    let objects = &pdf.pages()[page].resources().x_objects;
    objects
        .keys()
        .map(|name| {
            objects
                .get::<Stream<'_>>(name)
                .unwrap()
                .raw_data()
                .into_owned()
        })
        .collect()
}

#[test]
fn compatible_tiles_preserve_compression_without_pixel_decoding() {
    let directory = tempfile::tempdir().unwrap();
    let jpg = jpeg([40, 70, 90, 255]);
    let mut png = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(16, 16, image::Rgb([40, 70, 90]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    for (name, bytes) in [("jpeg", jpg), ("png", png.into_inner())] {
        let input = source(directory.path(), name, &bytes);
        let output = directory.path().join(format!("{name}.pdf"));
        let host = NativeHost::new(options(&input, &output)).unwrap();
        host.transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .unwrap();
        let publication = host.publication().unwrap();
        assert_eq!(publication.output.format, OutputFormat::Pdf);
        assert_eq!(publication.instrumentation.pixel_decodes, 0);
        let pdf = Pdf::new(std::fs::read(&output).unwrap()).unwrap();
        assert_eq!(pdf.pages().len(), 1);
        let payload = payloads(&pdf, 0).pop().unwrap();
        if name == "jpeg" {
            assert_eq!(payload, bytes);
        } else {
            let mut idat = Vec::new();
            let mut at = 8;
            while at + 12 <= bytes.len() {
                let length = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                if &bytes[at + 4..at + 8] == b"IDAT" {
                    idat.extend_from_slice(&bytes[at + 8..at + 8 + length]);
                }
                at += length + 12;
            }
            assert_eq!(payload, idat);
        }
    }
}

#[test]
fn transparent_tiles_use_lossless_color_and_alpha_streams() {
    let directory = tempfile::tempdir().unwrap();
    let pixels = image::RgbaImage::from_fn(16, 16, |x, y| {
        image::Rgba([x as u8, y as u8, 90, (x * 16) as u8])
    });
    let bytes = dezoomify_native::imaging::encode_png(
        &pixels,
        image::codecs::png::CompressionType::Fast,
        None,
        None,
    )
    .unwrap();
    let input = source(directory.path(), "transparent", &bytes);
    let output = directory.path().join("transparent.pdf");
    let host = NativeHost::new(options(&input, &output)).unwrap();
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .unwrap();
    assert_eq!(host.publication().unwrap().instrumentation.pixel_decodes, 1);
    let pdf = Pdf::new(std::fs::read(output).unwrap()).unwrap();
    let objects = &pdf.pages()[0].resources().x_objects;
    let image = objects
        .get::<Stream<'_>>(objects.keys().next().unwrap())
        .unwrap();
    let alpha = image
        .dict()
        .get::<Stream<'_>>(b"SMask")
        .unwrap()
        .decoded()
        .unwrap();
    let colors = image.decoded().unwrap();
    assert_eq!(
        alpha.as_ref(),
        pixels.pixels().map(|pixel| pixel[3]).collect::<Vec<_>>()
    );
    assert_eq!(
        colors.as_ref(),
        pixels
            .pixels()
            .flat_map(|pixel| pixel.0[..3].to_vec())
            .collect::<Vec<_>>()
    );
}

#[test]
fn interrupted_documents_publish_only_complete_pages() {
    let directory = tempfile::tempdir().unwrap();
    let first = jpeg([200, 40, 20, 255]);
    let second = jpeg([20, 180, 60, 255]);
    let output = directory.path().join("collection.pdf");
    let mut document = OutputDocument::new(OutputTarget::File(output.clone()), false).unwrap();
    for (name, bytes, cancel) in [
        ("first", &first, false),
        ("second", &second, false),
        ("last", &first, true),
    ] {
        let input = source(directory.path(), name, bytes);
        prepare_document_page(&mut document, &input, &output, cancel);
    }
    let publication = document.finish().unwrap().unwrap();
    assert_eq!(publication.pages, 2);
    let pdf = Pdf::new(std::fs::read(&output).unwrap()).unwrap();
    assert_eq!(pdf.pages().len(), 2);
    assert_eq!(payloads(&pdf, 0), [first]);
    assert_eq!(payloads(&pdf, 1), [second]);
}

fn prepare_document_page(document: &mut OutputDocument, input: &Path, output: &Path, cancel: bool) {
    let host = NativeHost::new(options(input, output))
        .unwrap()
        .with_document_page(document.page().unwrap())
        .unwrap();
    if cancel {
        host.controls().cancel();
    }
    let result = host.transport.block_on(dezoomify::dezoomify(
        host.inputs(),
        host.algorithm_options(),
        &host,
    ));
    if cancel {
        assert!(matches!(result.unwrap_err(), Error::Cancelled));
    } else {
        assert_eq!(
            result.unwrap().disposition,
            OutputDisposition::NativePrepared
        );
    }
    assert!(host.publication().is_none());
    assert!(
        !output.exists(),
        "a prepared page must not report a published document"
    );
}

#[test]
fn dropping_an_incomplete_first_page_publishes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("empty.pdf");
    let mut document = OutputDocument::new(OutputTarget::File(output.clone()), false).unwrap();
    drop(document.page().unwrap());
    assert!(document.finish().unwrap().is_none());
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn failure_after_streaming_part_of_a_page_allows_later_pages() {
    use dezoomify::model::*;
    let directory = tempfile::tempdir().unwrap();
    let bytes = jpeg([80, 120, 40, 255]);
    let input = source(directory.path(), "first", &bytes);
    let output = directory.path().join("partial.pdf");
    let mut document = OutputDocument::new(OutputTarget::File(output.clone()), false).unwrap();
    let host = NativeHost::new(options(&input, &output))
        .unwrap()
        .with_document_page(document.page().unwrap())
        .unwrap();
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .unwrap();
    drop(host);
    let host = NativeHost::new(options(&input, &output))
        .unwrap()
        .with_document_page(document.page().unwrap())
        .unwrap();
    let bad = directory.path().join("bad.jpg");
    std::fs::write(&bad, b"not an image").unwrap();
    host.transport.block_on(async {
        let canvas = Size {
            width: 32,
            height: 16,
        };
        host.begin_output(OutputPlan {
            canvas: Some(canvas.clone()),
            grid: None,
            source_levels: Vec::new(),
            tile_count: 2,
            format: OutputFormat::Pdf,
            title: None,
        })
        .await
        .unwrap();
        for (index, path) in [directory.path().join("first_files/4/0_0.jpg"), bad.clone()]
            .into_iter()
            .enumerate()
        {
            let result = host
                .acquire_tile(
                    Tile {
                        index: index as u32,
                        source: ResourceRequest {
                            uri: path.to_string_lossy().into(),
                            headers: Vec::new(),
                            purpose: RequestPurpose::Tile,
                        }
                        .into(),
                        placement: TilePlacement {
                            position: Point {
                                x: index as u32 * 16,
                                y: 0,
                            },
                            expected_size: Some(Size {
                                width: 16,
                                height: 16,
                            }),
                            canvas: Some(canvas.clone()),
                            processing: ProcessingRecipe::None,
                            role: TileRole::output(),
                        },
                    }
                    .into(),
                )
                .await;
            if index == 0 {
                result.unwrap();
            } else {
                assert!(matches!(
                    result.unwrap_err().cause(),
                    Error::DecodeFailed(_)
                ));
            }
        }
        host.settle().await;
    });
    prepare_document_page(&mut document, &input, &output, false);
    assert_eq!(document.finish().unwrap().unwrap().pages, 2);
    let pdf = Pdf::new(std::fs::read(output).unwrap()).unwrap();
    assert_eq!(pdf.pages().len(), 2);
    assert_eq!(payloads(&pdf, 0).as_slice(), std::slice::from_ref(&bytes));
    assert_eq!(payloads(&pdf, 1), [bytes]);
}

#[test]
fn compressed_tiles_stream_on_a_large_canvas() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("wide.dzi");
    let tiles = directory.path().join("wide_files/16");
    std::fs::create_dir(tiles.parent().unwrap()).unwrap();
    std::fs::create_dir(&tiles).unwrap();
    std::fs::write(&input, "<Image TileSize=\"256\" Overlap=\"0\" Format=\"jpg\"><Size Width=\"65536\" Height=\"256\"/></Image>").unwrap();
    let image = image::RgbaImage::from_fn(256, 256, |x, y| {
        image::Rgba([x as u8, y as u8, (x ^ y) as u8, 255])
    });
    let bytes = dezoomify_native::imaging::encode_jpeg(&image, 85, None).unwrap();
    for x in 0..256 {
        std::fs::write(tiles.join(format!("{x}_0.jpg")), &bytes).unwrap();
    }
    let output = directory.path().join("wide.pdf");
    let host = NativeHost::new(JobOptions {
        max_concurrent: 1,
        ..options(&input, &output)
    })
    .unwrap();
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .unwrap();
    let result = host.publication().unwrap();
    assert_eq!(result.instrumentation.pixel_decodes, 0);
    assert!(result.instrumentation.encoded_bytes > 256 << 10);
    assert!(result.instrumentation.peak_retained_bytes <= 256 << 10);
    let pdf = Pdf::new(std::fs::read(output).unwrap()).unwrap();
    assert_eq!(pdf.pages().len(), 1);
    assert_eq!(payloads(&pdf, 0).len(), 256);
}
