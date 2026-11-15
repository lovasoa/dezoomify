use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Webp,
    name: "WebP",
    extensions: &["webp"],
    max_side: Some(16_383),
    control: OutputControl::None,
    layout: OutputLayout::Buffered,
    hint: "lossless",
    size_coefficients: &[(100, 1.3)],
};
