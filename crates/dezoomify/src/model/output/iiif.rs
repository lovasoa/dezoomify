use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::IiifDir,
    name: "IIIF folder",
    extensions: &["iiif", ""],
    max_side: None,
    control: OutputControl::Quality {
        minimum: 0,
        warning_below: 25,
    },
    layout: OutputLayout::Directory,
    hint: "tiled",
    size_coefficients: super::jpeg::CODEC.size_coefficients,
};
