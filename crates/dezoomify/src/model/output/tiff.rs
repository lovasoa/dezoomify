use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Tiff,
    name: "TIFF",
    extensions: &["tif", "tiff"],
    max_side: None,
    control: OutputControl::Effort,
    layout: OutputLayout::Streaming,
    hint: "archival",
    size_coefficients: &[(100, 3.0)],
};
