use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Jpeg2000,
    name: "JPEG 2000",
    extensions: &["jp2"],
    max_side: Some(i32::MAX as u32),
    control: OutputControl::Quality {
        minimum: 0,
        warning_below: 25,
    },
    layout: OutputLayout::Tiled,
    hint: "tiled",
    size_coefficients: SIZES,
};

// RGB8 rates: 3 bytes/pixel divided by 1 + compression, with a
// heuristic for reversible coding at compression zero.
const SIZES: &[(u8, f64)] = &[
    (0, 3.0 / 101.0),
    (50, 3.0 / 51.0),
    (75, 3.0 / 26.0),
    (90, 3.0 / 11.0),
    (95, 0.5),
    (98, 1.0),
    (99, 1.5),
    (100, 1.6),
];
