use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Jpeg,
    name: "JPEG",
    extensions: &["jpg", "jpeg"],
    max_side: Some(65_535),
    // Conservative UI guidance, not a universal usability cutoff.
    // https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/doc/usage.txt
    control: OutputControl::Quality {
        minimum: 0,
        warning_below: 25,
    },
    layout: OutputLayout::Streaming,
    hint: "compressed",
    size_coefficients: SIZES,
};

// Native image 0.25.10 samples, fitted within 512x512; AVIF uses speed 4.
// Transparency and different content may cost more.
const SIZES: &[(u8, f64)] = &[
    (1, 0.035),
    (5, 0.044),
    (10, 0.057),
    (20, 0.076),
    (25, 0.085),
    (50, 0.15),
    (75, 0.25),
    (90, 0.4),
    (95, 0.55),
    (98, 0.85),
    (100, 1.15),
];
