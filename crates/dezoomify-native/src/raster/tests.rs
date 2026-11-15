use super::*;
use crate::{
    imaging::DecodedTile,
    pixel_pipe::tests::{placement, put},
};
use dezoomify::model::OutputLayout;
fn raster_formats() -> impl Iterator<Item = OutputFormat> {
    dezoomify::model::OUTPUT_CODECS
        .iter()
        .filter(|codec| {
            matches!(
                codec.layout,
                OutputLayout::Streaming | OutputLayout::Buffered
            )
        })
        .map(|codec| codec.format)
}

pub(crate) fn decode_buffered(path: &Path) -> image::RgbaImage {
    let decoded = std::process::Command::new("node")
        .args(["--input-type=module", "-e", r#"
            import sharp from 'sharp';
            const {data, info} = await sharp(process.argv[1]).ensureAlpha().raw().toBuffer({resolveWithObject:true});
            const header = Buffer.alloc(8);
            header.writeUInt32LE(info.width); header.writeUInt32LE(info.height, 4);
            process.stdout.write(header); process.stdout.write(data);
        "#])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .arg(path).output().unwrap();
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    let width = u32::from_le_bytes(decoded.stdout[0..4].try_into().unwrap());
    let height = u32::from_le_bytes(decoded.stdout[4..8].try_into().unwrap());
    image::RgbaImage::from_raw(width, height, decoded.stdout[8..].to_vec()).unwrap()
}

pub(crate) fn directory() -> std::path::PathBuf {
    let path = crate::output::temp_sibling(&std::env::temp_dir().join("raster-test"));
    std::fs::create_dir(&path).unwrap();
    path
}
pub(crate) fn start(
    path: &Path,
    format: OutputFormat,
    size: Size,
    controls: Controls,
) -> EncoderTask {
    let cap = if format.codec().layout == OutputLayout::Buffered {
        32 << 20
    } else {
        8 << 20
    };
    EncoderTask::start(path, size, None, format, 5, cap, controls).unwrap()
}
pub(crate) async fn publish(task: EncoderTask, destination: &Path) -> Vec<u8> {
    task.pipe.finish(&[]).unwrap();
    // A deadlock watchdog, not a compression benchmark: full-image codecs
    // can take seconds in unoptimized builds on shared CI runners.
    let mut staged = tokio::time::timeout(std::time::Duration::from_secs(30), task.wait())
        .await
        .unwrap_or_else(|error| {
            panic!("encoder for {} must finish: {error}", destination.display())
        })
        .unwrap();
    staged
        .publish(
            destination,
            false,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
    std::fs::read(destination).unwrap()
}

#[tokio::test]
async fn metadata_is_finalized_after_pixels_without_recompressing_the_image() {
    let directory = directory();
    let icc = vec![
        0, 0, 2, 12, 0x61, 0x64, 0x73, 0x70, 0, 0, 0, 0, 0x6d, 0x6e, 0x74, 0x72, 0x52, 0x47, 0x42,
        0x20,
    ];
    let exif = vec![0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a];
    let source = image::RgbaImage::from_pixel(2, 1, image::Rgba([40, 80, 120, 255]));
    // These encoders promise embedded profile preservation.
    for format in [
        OutputFormat::Png,
        OutputFormat::Jpeg,
        OutputFormat::Tiff,
        OutputFormat::Webp,
    ] {
        let destination = directory.join(format.extension());
        let task = start(
            &destination,
            format,
            Size {
                width: 2,
                height: 1,
            },
            Controls::default(),
        );
        for x in [1, 0] {
            task.pipe
                .place(
                    x,
                    &placement(x, 0),
                    DecodedTile {
                        image: image::imageops::crop_imm(&source, x, 0, 1, 1).to_image(),
                        icc_profile: (x == 1).then(|| icc.clone()),
                        exif_metadata: (x == 0).then(|| exif.clone()),
                    },
                )
                .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while task.pipe.consumed() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pixels must be read before metadata finalization");
        let bytes = publish(task, &destination).await;
        if format == OutputFormat::Tiff {
            let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
            assert_eq!(
                decoder.get_tag_u8_vec(tiff::tags::Tag::IccProfile).unwrap(),
                icc
            );
        } else {
            let decoded = crate::imaging::load_image_with_metadata(&bytes).unwrap();
            assert_eq!(decoded.icc_profile.as_ref(), Some(&icc));
            if format == OutputFormat::Png {
                assert_eq!(decoded.exif_metadata.as_ref(), Some(&exif));
            }
        }
        if format == OutputFormat::Jpeg {
            assert_eq!(
                bytes,
                crate::formats::jpeg::encode(&source, 95, Some(&icc)).unwrap()
            );
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn codecs_match_pixels_across_strip_handoffs_and_jpeg_edge_padding() {
    let directory = directory();
    for (width, height) in [
        (1, 1),
        (1, 9),
        (7, 7),
        (8, 8),
        (9, 9),
        (13, 19),
        (16, 17),
        (1, 65),
        (9, 64),
        (13, 129),
    ] {
        let source = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x * 17) as u8,
                (y * 11) as u8,
                ((x + y) * 7) as u8,
                if (x + y) % 3 == 0 { 128 } else { 255 },
            ])
        });
        for format in raster_formats() {
            let destination = directory.join(format!("{width}-{height}.{}", format.extension()));
            let task = start(
                &destination,
                format,
                Size { width, height },
                Controls::default(),
            );
            let pipe = Arc::clone(&task.pipe);
            for y in (0..height).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                for x in (0..width).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                    put(
                        &pipe,
                        y * width + x,
                        x,
                        y,
                        image::imageops::crop_imm(
                            &source,
                            x,
                            y,
                            (width - x).min(5),
                            (height - y).min(5),
                        )
                        .to_image(),
                    );
                }
            }
            let bytes = publish(task, &destination).await;
            if format == OutputFormat::Jpeg {
                assert_eq!(
                    bytes,
                    crate::formats::jpeg::encode(&source, 95, None).unwrap(),
                    "{width}x{height}"
                );
            } else {
                let decoded = if format.codec().layout == OutputLayout::Buffered {
                    decode_buffered(&destination)
                } else {
                    image::load_from_memory(&bytes).unwrap().into_rgba8()
                };
                assert_eq!(decoded.dimensions(), source.dimensions());
                if matches!(
                    format.codec().control,
                    dezoomify::model::OutputControl::Quality { .. }
                ) {
                    let error: u64 = decoded
                        .as_raw()
                        .iter()
                        .zip(source.as_raw())
                        .map(|(a, b)| u64::from(a.abs_diff(*b)))
                        .sum();
                    assert!(
                        error as f64 / source.as_raw().len() as f64 <= 5.0,
                        "{format:?} {width}x{height}"
                    );
                } else {
                    assert_eq!(decoded, source, "{format:?} {width}x{height}");
                }
            }
            assert_eq!(pipe.consumed(), u64::from(width) * u64::from(height));
            drop(pipe);
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn cancellation_and_source_failure_wake_waiting_encoders_and_remove_staging() {
    let directory = directory();
    for format in raster_formats() {
        for cancellation in [true, false] {
            let controls = Controls::default();
            let task = start(
                &directory.join(format.extension()),
                format,
                Size {
                    width: 9,
                    height: 9,
                },
                controls.clone(),
            );
            let error = if cancellation {
                controls.cancel();
                Error::Cancelled
            } else {
                let error = Error::WriteFailed("original source failure".into());
                task.pipe.fail(error.clone());
                error
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(3), task.wait())
                .await
                .expect("reader must wake");
            assert!(matches!(result, Err(cause) if cause == error));
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}
