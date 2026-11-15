use crate::{
    host::Controls,
    pixel_pipe::tests::put,
    raster::{
        tests::{directory, publish},
        EncoderTask,
    },
};
use dezoomify::model::{OutputFormat, Size};

#[tokio::test]
async fn reversed_tiles_encode_png() {
    let directory = directory();
    let destination = directory.join("reversed.png");
    let source = image::RgbaImage::from_fn(1031, 1037, |x, y| {
        image::Rgba([x as u8, y as u8, (x ^ y) as u8, 255])
    });
    let task = EncoderTask::start(
        &destination,
        Size {
            width: source.width(),
            height: source.height(),
        },
        None,
        OutputFormat::Png,
        5,
        Controls::default(),
    )
    .unwrap();
    for y in (0..source.height()).step_by(257).rev() {
        for x in (0..source.width()).step_by(257).rev() {
            put(
                &task.pipe,
                y * source.width() + x,
                x,
                y,
                image::imageops::crop_imm(
                    &source,
                    x,
                    y,
                    257.min(source.width() - x),
                    257.min(source.height() - y),
                )
                .to_image(),
            );
        }
    }
    let bytes = publish(task, &destination).await;
    assert_eq!(
        image::load_from_memory(&bytes).unwrap().into_rgba8(),
        source
    );
    std::fs::remove_dir_all(directory).unwrap();
}
