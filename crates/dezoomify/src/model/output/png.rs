use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Png,
    name: "PNG",
    extensions: &["png"],
    max_side: None,
    control: OutputControl::Effort,
    layout: OutputLayout::Streaming,
    hint: "lossless",
    size_coefficients: &[(100, 1.6)],
};
