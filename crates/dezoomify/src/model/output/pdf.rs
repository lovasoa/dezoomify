use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Pdf,
    name: "PDF",
    extensions: &["pdf"],
    max_side: None,
    control: OutputControl::Effort,
    layout: OutputLayout::Document,
    hint: "document",
    size_coefficients: &[(100, 1.6)],
};
