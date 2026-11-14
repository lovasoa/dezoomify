//! Mixed tile encodings share native decoding for raster and tiled exports.
use dezoomify_native::imaging::{encode_jpeg, encode_png};
mod support;

#[test]
fn pdf_fallback_probes_reuse_decoded_pixels_and_preserve_alpha() {
    use hayro_syntax::{object::Stream, Pdf};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    let work = tempfile::tempdir().unwrap();
    let rgba = image::RgbaImage::from_fn(11, 7, |x, y| {
        image::Rgba([
            (x * 17) as u8,
            (y * 31) as u8,
            ((x + y) * 13) as u8,
            (x * 23) as u8,
        ])
    });
    let png = encode_png(&rgba, image::codecs::png::CompressionType::Fast, None, None).unwrap();
    for (name, bytes) in [
        ("jp2", include_bytes!("data/jpeg2000/rgb.jp2").as_slice()),
        ("png", png.as_slice()),
    ] {
        let routes = HashMap::from([(
            format!("/tile-0_0.{name}"),
            support::http_response("200 OK", "application/octet-stream", bytes),
        )]);
        let base = support::serve_counted(
            Arc::new(Mutex::new(routes)),
            Arc::new(Mutex::new(HashMap::new())),
        );
        let output = work.path().join(format!("probe-{name}.pdf"));
        let publication = support::run_file(
            &format!("{base}/tile-{{{{X}}}}_{{{{Y}}}}.{name}"),
            &output,
            |options| options.cache_dir = Some(work.path().join(format!("cache-{name}"))),
        )
        .unwrap();
        assert_eq!(publication.instrumentation.pixel_decodes, 1, "{name}");
        let pdf = Pdf::new(std::fs::read(output).unwrap()).unwrap();
        let objects = &pdf.pages()[0].resources().x_objects;
        assert_eq!(objects.keys().count(), 1);
        let image = objects
            .get::<Stream<'_>>(objects.keys().next().unwrap())
            .unwrap();
        assert_eq!(image.dict().get::<i32>(b"Width"), Some(11));
        assert_eq!(image.dict().get::<i32>(b"Height"), Some(7));
        let expected: Vec<u8> = rgba
            .pixels()
            .flat_map(|pixel| pixel.0[..3].to_vec())
            .collect();
        assert_eq!(image.decoded().unwrap().as_ref(), expected, "{name}");
        if name == "png" {
            let mask = image.dict().get::<Stream<'_>>(b"SMask").unwrap();
            let alpha: Vec<u8> = rgba.pixels().map(|pixel| pixel[3]).collect();
            assert_eq!(mask.decoded().unwrap().as_ref(), alpha);
        }
    }
}

#[test]
fn jpeg2000_tiles_preserve_pixels_in_pdf() {
    use hayro_syntax::{object::Stream, Pdf};

    let work = tempfile::tempdir().unwrap();
    let manifest = work.path().join("source.dzi");
    let tiles = work.path().join("source_files/4");
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&manifest, "<Image TileSize=\"11\" Overlap=\"0\" Format=\"jp2\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"11\" Height=\"7\"/></Image>").unwrap();
    let expected: Vec<u8> = (0..7)
        .flat_map(|y| (0..11).flat_map(move |x| [x * 17, y * 31, (x + y) * 13]))
        .collect();
    for (name, bytes) in [
        ("jp2", include_bytes!("data/jpeg2000/rgb.jp2").as_slice()),
        ("j2k", include_bytes!("data/jpeg2000/rgb.j2k").as_slice()),
    ] {
        std::fs::write(tiles.join("0_0.jp2"), bytes).unwrap();
        let output = work.path().join(format!("{name}.pdf"));
        support::run_file(manifest.to_str().unwrap(), &output, |options| {
            options.largest = true;
            options.cache_dir = Some(work.path().join(format!("cache-{name}")));
        })
        .unwrap();
        let pdf = Pdf::new(std::fs::read(output).unwrap()).unwrap();
        assert_eq!(pdf.pages().len(), 1);
        let objects = &pdf.pages()[0].resources().x_objects;
        assert_eq!(objects.keys().count(), 1);
        let image = objects
            .get::<Stream<'_>>(objects.keys().next().unwrap())
            .unwrap();
        assert_eq!(image.dict().get::<i32>(b"Width"), Some(11));
        assert_eq!(image.dict().get::<i32>(b"Height"), Some(7));
        assert_eq!(image.decoded().unwrap().as_ref(), expected, "{name}");
    }
}

#[test]
fn mixed_jpeg_png_jp2_and_codestream_tiles_save_to_native_outputs() {
    let work = tempfile::tempdir().unwrap();
    let manifest = work.path().join("source.dzi");
    let tiles = work.path().join("source_files/6");
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&manifest, "<Image TileSize=\"11\" Overlap=\"0\" Format=\"jp2\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"44\" Height=\"7\"/></Image>").unwrap();
    let rgb = image::RgbaImage::from_fn(11, 7, |x, y| {
        image::Rgba([(x * 17) as u8, (y * 31) as u8, ((x + y) * 13) as u8, 255])
    });
    let png = encode_png(&rgb, image::codecs::png::CompressionType::Fast, None, None).unwrap();
    let jpeg = encode_jpeg(&rgb, 95, None).unwrap();
    let jpeg_pixels = image::load_from_memory(&jpeg).unwrap().into_rgba8();
    for (x, bytes) in [
        include_bytes!("data/jpeg2000/rgb.jp2").as_slice(),
        &png,
        &jpeg,
        include_bytes!("data/jpeg2000/rgb.j2k").as_slice(),
    ]
    .into_iter()
    .enumerate()
    {
        std::fs::write(tiles.join(format!("{x}_0.jp2")), bytes).unwrap();
    }
    let expected = image::RgbaImage::from_fn(44, 7, |x, y| {
        if x / 11 == 2 {
            *jpeg_pixels.get_pixel(x % 11, y)
        } else {
            *rgb.get_pixel(x % 11, y)
        }
    });
    for extension in ["png", "jp2", "iiif", "zif"] {
        let output = work.path().join(format!("result.{extension}"));
        support::run_file(manifest.to_str().unwrap(), &output, |options| {
            options.largest = true;
            options.compression = 0;
        })
        .unwrap_or_else(|e| panic!("{extension}: {e}"));
        let saved = match extension {
            "png" => image::open(output).unwrap().into_rgba8(),
            "jp2" => {
                let jp2 = openjp2::Image::from_file(output).unwrap();
                let decoded: image::DynamicImage = (&jp2).try_into().unwrap();
                decoded.into_rgba8()
            }
            "iiif" => {
                let reconstructed = work.path().join("iiif.png");
                support::run_file(
                    output.join("info.json").to_str().unwrap(),
                    &reconstructed,
                    |o| o.largest = true,
                )
                .unwrap();
                image::open(reconstructed).unwrap().into_rgba8()
            }
            "zif" => {
                let reconstructed = work.path().join("zif.png");
                support::run_file(output.to_str().unwrap(), &reconstructed, |o| {
                    o.largest = true
                })
                .unwrap();
                image::open(reconstructed).unwrap().into_rgba8()
            }
            _ => unreachable!(),
        };
        assert_eq!(saved, expected, "{extension}");
    }
}
