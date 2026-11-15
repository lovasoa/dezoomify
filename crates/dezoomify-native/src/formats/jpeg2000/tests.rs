use super::*;
use crate::{
    imaging::load_image_with_metadata,
    pixel_pipe::tests::{placement, put},
    raster::EncoderTask,
};
use dezoomify::model::OutputFormat;
const RGB_JP2: &[u8] = include_bytes!("../../../tests/data/jpeg2000/rgb.jp2");
const RGB_J2K: &[u8] = include_bytes!("../../../tests/data/jpeg2000/rgb.j2k");

#[test]
fn reads_reference_containers_codestreams_and_16_bit_gray() {
    let expected = image::RgbaImage::from_fn(11, 7, |x, y| {
        image::Rgba([(x * 17) as u8, (y * 31) as u8, ((x + y) * 13) as u8, 255])
    });
    for bytes in [RGB_JP2, RGB_J2K] {
        assert_eq!(load_image_with_metadata(bytes).unwrap().image, expected);
        for truncated in [&bytes[..30], &bytes[..bytes.len() - 1]] {
            assert!(load_image_with_metadata(truncated).is_err());
        }
    }
    let gray = load_image_with_metadata(include_bytes!("../../../tests/data/jpeg2000/gray16.j2k"))
        .unwrap()
        .image;
    assert_eq!(
        gray,
        image::RgbaImage::from_fn(5, 3, |x, y| {
            let v = (((x + 5 * y) * 4096 + 128) / 257) as u8;
            image::Rgba([v, v, v, 255])
        })
    );
}

fn grid() -> OutputGrid {
    OutputGrid {
        tile_size: Size {
            width: 17,
            height: 11,
        },
        overlap: Size {
            width: 1,
            height: 1,
        },
    }
}

#[tokio::test]
async fn preserves_source_grid_overlap_edges_and_origin_profile() {
    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("image.jp2");
    let size = Size {
        width: 43,
        height: 27,
    };
    let source = image::RgbaImage::from_fn(size.width, size.height, |x, y| {
        image::Rgba([x as u8, y as u8, (x ^ y) as u8, 255])
    });
    let mut profile = vec![0; 128];
    profile[16..20].copy_from_slice(b"RGB ");
    let task = EncoderTask::start(
        &path,
        size,
        Some(&grid()),
        OutputFormat::Jpeg2000,
        0,
        Controls::default(),
    )
    .unwrap();
    for row in (0u32..3).rev() {
        for col in (0u32..3).rev() {
            let x = (col * 17).saturating_sub(1);
            let y = (row * 11).saturating_sub(1);
            let right = ((col + 1) * 17 + 1).min(source.width());
            let bottom = ((row + 1) * 11 + 1).min(source.height());
            task.pipe
                .place(
                    row * 3 + col,
                    &placement(x, y),
                    crate::imaging::DecodedTile {
                        image: image::imageops::crop_imm(&source, x, y, right - x, bottom - y)
                            .to_image(),
                        icc_profile: (col == 0 && row == 0).then(|| profile.clone()),
                        exif_metadata: None,
                    },
                )
                .unwrap();
        }
    }
    task.pipe.finish(&[]).unwrap();
    let staged = task.wait().await.unwrap();
    let bytes = std::fs::read(staged.path()).unwrap();
    let decoded = load_image_with_metadata(&bytes).unwrap();
    assert_eq!(decoded.image, source);
    assert_eq!(decoded.icc_profile, Some(profile));
    let mut decoder = openjp2::Decoder::new(J2KFormat::JP2).unwrap();
    decoder.read_header(&mut Stream::from_bytes(bytes)).unwrap();
    let info = decoder.cstr_info().unwrap();
    assert_eq!((info.tdx, info.tdy, info.tw, info.th), (17, 11, 3, 3));
}

#[tokio::test]
async fn encodes_before_acquisition_finishes_and_cleans_up_on_cancellation() {
    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("out.jp2");
    std::fs::write(&path, b"existing destination").unwrap();
    let controls = Controls::default();
    let task = EncoderTask::start(
        &path,
        Size {
            width: 34,
            height: 11,
        },
        Some(&grid()),
        OutputFormat::Jpeg2000,
        0,
        controls.clone(),
    )
    .unwrap();
    put(
        &task.pipe,
        0,
        0,
        0,
        image::RgbaImage::from_pixel(17, 11, image::Rgba([40, 80, 120, 255])),
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while task.pipe.consumed() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first tile must encode before remaining downloads");
    controls.cancel();
    assert!(matches!(task.wait().await, Err(Error::Cancelled)));
    assert_eq!(std::fs::read(path).unwrap(), b"existing destination");
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn lossy_compression_encodes_within_tolerance() {
    for compression in [1, 100] {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("out.jp2");
        let task = EncoderTask::start(
            &path,
            Size {
                width: 34,
                height: 11,
            },
            Some(&grid()),
            OutputFormat::Jpeg2000,
            compression,
            Controls::default(),
        )
        .unwrap();
        put(
            &task.pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(17, 11, image::Rgba([40, 80, 120, 255])),
        );
        put(
            &task.pipe,
            1,
            16,
            0,
            image::RgbaImage::from_pixel(18, 11, image::Rgba([40, 80, 120, 255])),
        );
        task.pipe.finish(&[]).unwrap();
        let staged = task.wait().await.unwrap();
        let decoded = load_image_with_metadata(&std::fs::read(staged.path()).unwrap())
            .unwrap()
            .image;
        assert_eq!(decoded.dimensions(), (34, 11));
        assert!(decoded
            .pixels()
            .all(|p| p[0].abs_diff(40) < 5 && p[1].abs_diff(80) < 5 && p[2].abs_diff(120) < 5));
    }
}

#[tokio::test]
async fn rejects_unsupported_grids_before_creating_staging() {
    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("out.jp2");
    let encoder = Encoder { compression: 0 };
    assert!(encoder
        .grid(
            &Size {
                width: 1,
                height: 1
            },
            None
        )
        .is_err());
    let too_many = OutputGrid {
        tile_size: Size {
            width: 1,
            height: 1,
        },
        overlap: Size {
            width: 0,
            height: 0,
        },
    };
    assert!(encoder
        .grid(
            &Size {
                width: 256,
                height: 256
            },
            Some(&too_many)
        )
        .is_err());
    assert!(EncoderTask::start(
        &path,
        Size {
            width: 34,
            height: 22
        },
        None,
        OutputFormat::Jpeg2000,
        0,
        Controls::default()
    )
    .is_err());
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}
