//! Native JPEG decode and output parity with the shared browser fixture golden.

use std::path::PathBuf;

mod support;

#[test]
fn freezoompack_outputs_match_both_rounding_profile_goldens() {
    let scenario =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios/formats/fzp");
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(scenario.join("expected/result.json")).unwrap())
            .unwrap();
    let output_dir = std::env::temp_dir().join(format!("dezoomify-fzp-{}", std::process::id()));
    std::fs::create_dir_all(&output_dir).unwrap();
    for profile in ["floor", "ceil"] {
        let levels = expected[profile].as_array().unwrap();
        for (position, golden) in levels.iter().enumerate() {
            let width = golden["width"].as_u64().unwrap() as u32;
            let height = golden["height"].as_u64().unwrap() as u32;
            let input = scenario.join(format!(
                "payloads/127.0.0.1/fzp/resources/{profile}/root.xml"
            ));
            let output = output_dir.join(format!("{profile}-{}.png", golden["level"]));
            let outcome = support::run_file(input.to_str().unwrap(), &output, |options| {
                // Public level positions run from smallest to largest.
                options.zoom_level = Some(levels.len() - 1 - position);
                options.max_retries = 0;
                options.keep_partial = false;
                options.overwrite = true;
            })
            .unwrap();
            assert_eq!(
                outcome.tile_count as u64,
                golden["tile_count"].as_u64().unwrap()
            );
            assert!(outcome.output.missing.is_empty());
            let image = image::open(&output).unwrap().to_rgb8();
            assert_eq!(image.dimensions(), (width, height));
            for (pixel, gray) in image
                .pixels()
                .zip(golden["gray_pixels"].as_array().unwrap())
            {
                assert_eq!(pixel.0, [gray.as_u64().unwrap() as u8; 3]);
            }
        }
    }
    std::fs::remove_dir_all(output_dir).unwrap();
}
