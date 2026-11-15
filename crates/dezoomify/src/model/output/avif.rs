use crate::model::{OutputCodec, OutputControl, OutputFormat, OutputLayout};

pub(in crate::model) const CODEC: OutputCodec = OutputCodec {
    format: OutputFormat::Avif,
    name: "AVIF",
    extensions: &["avif"],
    max_side: Some(65_535),
    // Conservative UI guidance, not a universal usability cutoff.
    // https://github.com/kornelski/cavif-rs#advanced-usage
    control: OutputControl::Quality {
        minimum: 1,
        warning_below: 30,
    },
    layout: OutputLayout::Buffered,
    hint: "advancedCompression",
    size_coefficients: SIZES,
};

// Native image 0.25.10 samples, fitted within 512x512; AVIF uses speed 4.
// Transparency and different content may cost more.
const SIZES: &[(u8, f64)] = &[
    (1, 0.012),
    (5, 0.013),
    (10, 0.016),
    (20, 0.023),
    (25, 0.027),
    (50, 0.1),
    (75, 0.15),
    (90, 0.3),
    (95, 0.45),
    (98, 0.7),
    (100, 1.15),
];
