use super::*;
use dezoomify::model::OutputFormat;

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
    let mut writer = ZifWriter::new(&directory.path().join("out.zif"), &plan, 5, 100).unwrap();
    assert_eq!(
        writer.initialize(Profile::PngRgb, &AtomicBool::new(true)),
        Err(Error::Cancelled)
    );
}
