use super::*;
use crate::codecs::NativeFormat;
use dezoomify::model::{OutputFormat, ProcessingRecipe, TilePlacement, TileRole};

#[test]
fn retained_tile_and_metadata_share_one_budget() {
    use image::ImageEncoder;
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    encoder.set_icc_profile(vec![42; 4096]).unwrap();
    encoder
        .write_image(&[1, 2, 3], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    assert!(matches!(profile(&bytes), Some(Profile::PngRgb)));
    let mut transparent = bytes.clone();
    // Valid RGB tRNS chunk for the encoded pixel [1, 2, 3].
    transparent.splice(
        33..33,
        [
            0, 0, 0, 6, b't', b'R', b'N', b'S', 0, 1, 0, 2, 0, 3, 201, 75, 171, 245,
        ],
    );
    assert!(profile(&transparent).is_none());
    let size = Size {
        width: 1,
        height: 1,
    };
    let directory = tempfile::tempdir().unwrap();
    let budget = 4096 + bytes.len() as u64 - 1;
    let mut writer = ZifWriter::new(
        &directory.path().join("out.zif"),
        &OutputPlan {
            canvas: Some(size.clone()),
            grid: None,
            source_levels: Vec::new(),
            tile_count: 1,
            format: OutputFormat::Zif,
            title: None,
        },
        budget,
        5,
        100,
    )
    .unwrap();
    let error = writer
        .place(
            EncodedTile {
                probe_pixels: None,
                request: None,
                id: 0,
                size: size.clone(),
                bytes,
                format: NativeFormat::Image(image::ImageFormat::Png),
                placement: TilePlacement {
                    position: Point { x: 0, y: 0 },
                    expected_size: None,
                    canvas: Some(size),
                    processing: ProcessingRecipe::None,
                    role: TileRole::output(),
                },
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        Error::LimitExceeded { .. } | Error::ResourceLimit(_)
    ));
    assert!(
        writer.metadata.is_empty(),
        "rejected tile metadata is not retained"
    );
}

#[test]
fn cancelled_header_write_preserves_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let plan = OutputPlan {
        canvas: Some(Size {
            width: 16,
            height: 16,
        }),
        grid: None,
        source_levels: Vec::new(),
        tile_count: 1,
        format: OutputFormat::Zif,
        title: None,
    };
    let mut writer =
        ZifWriter::new(&directory.path().join("out.zif"), &plan, 1 << 20, 5, 100).unwrap();
    assert_eq!(
        writer.initialize(Profile::PngRgb, &AtomicBool::new(true)),
        Err(Error::Cancelled)
    );
}
