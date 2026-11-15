use crate::{
    host::Controls,
    pixel_pipe::tests::put,
    raster::{
        tests::{decode_buffered, directory, publish},
        EncoderTask,
    },
};
use dezoomify::model::{OutputFormat, Size};

#[tokio::test]
async fn avif_quality_endpoints_preserve_dimensions_colors_and_alpha() {
    let directory = directory();
    for compression in [0, 5, 99, 100] {
        let destination = directory.join(format!("quality-{compression}.avif"));
        let task = EncoderTask::start(
            &destination,
            Size {
                width: 33,
                height: 19,
            },
            None,
            OutputFormat::Avif,
            compression,
            Controls::default(),
        )
        .unwrap();
        let source = image::RgbaImage::from_fn(33, 19, |x, _| {
            image::Rgba([120, 40, 80, if x < 16 { 128 } else { 255 }])
        });
        // Arrive out of order across a tile boundary.
        for (id, x, width) in [(1, 16, 17), (0, 0, 16)] {
            put(
                &task.pipe,
                id,
                x,
                0,
                image::imageops::crop_imm(&source, x, 0, width, 19).to_image(),
            );
        }
        publish(task, &destination).await;
        let decoded = decode_buffered(&destination);
        assert_eq!(decoded.dimensions(), (33, 19));
        let rgba = decoded.as_raw();
        // Flat colors remain recognizable even at quality 1. Quality 95+
        // has tighter tolerances, and alpha must survive on both sides.
        let tolerance = if compression <= 5 { 5 } else { 35 };
        for (x, alpha) in [(8, 128u8), (24, 255u8)] {
            let pixel = &rgba[(9 * 33 + x) * 4..][..4];
            for (actual, expected) in pixel.iter().zip([120, 40, 80, alpha]) {
                assert!(
                    actual.abs_diff(expected) <= tolerance,
                    "compression {compression}: {pixel:?}"
                );
            }
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}
