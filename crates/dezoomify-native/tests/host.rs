use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dezoomify::model::ProgressPhase;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};
mod support;
use support::{http_response, scenario_payload, serve_counted, temp_dir, DZI_512};

#[test]
fn known_codec_limits_fail_before_ordinary_tile_fetches() {
    use dezoomify::model::{Error, LimitReason};
    let work = temp_dir("preflight");
    let metadata = DZI_512.replace("512", "70000");
    let counts = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_counted(
        Arc::new(Mutex::new(HashMap::from([(
            "/large.dzi".to_string(),
            http_response("200 OK", "application/xml", metadata.as_bytes()),
        )]))),
        Arc::clone(&counts),
    );
    for (extension, reason) in [
        ("jpg", LimitReason::JpegSide),
        ("webp", LimitReason::WebpSide),
    ] {
        let host = NativeHost::new(JobOptions {
            input_url: format!("{base}/large.dzi"),
            output: OutputTarget::File(work.join(format!("image.{extension}"))),
            largest: true,
            cache_dir: Some(work.join("cache")),
            ..Default::default()
        })
        .unwrap();
        let error = host
            .transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .unwrap_err();
        assert!(matches!(error.cause(), Error::LimitExceeded { limit } if limit.reason == reason));
        assert!(host.publication().is_none());
    }
    assert_eq!(counts.lock().unwrap().len(), 1, "only metadata was fetched");
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn concurrent_optional_acquisitions_share_approval_and_keep_user_pause() {
    use dezoomify::{model::*, Host};
    let work = temp_dir("shared-retry-approval");
    let source = work.join("tile.png");
    image::RgbaImage::new(16, 16).save(&source).unwrap();
    let host = NativeHost::new(JobOptions {
        input_url: source.to_string_lossy().into(),
        output: OutputTarget::File(work.join("out.png")),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    let prompts = std::rc::Rc::new(std::cell::Cell::new(0));
    let asked = std::rc::Rc::clone(&prompts);
    let (send, receive) = tokio::sync::oneshot::channel();
    let receive = std::cell::RefCell::new(Some(receive));
    host.on_retry(move |request| {
        assert_eq!(request.attempt, 4);
        asked.set(asked.get() + 1);
        let receive = receive.borrow_mut().take().unwrap();
        Box::pin(async move { receive.await.map_err(|_| Error::Cancelled) })
    });
    let request = |index| TileAcquisition {
        tile: Tile {
            index,
            request: ResourceRequest {
                uri: source.to_string_lossy().into(),
                headers: Vec::new(),
                purpose: RequestPurpose::Tile,
            },
            placement: TilePlacement {
                position: Point {
                    x: index * 16,
                    y: 0,
                },
                expected_size: Some(Size {
                    width: 16,
                    height: 16,
                }),
                canvas: Some(Size {
                    width: 48,
                    height: 16,
                }),
                processing: ProcessingRecipe::None,
                role: TileRole::output(),
            },
        },
        attempt: 4,
        requires_approval: true,
        previous_failure: Some(Box::new(Error::Timeout {
            transport: ErrorTransport::Native,
            failure: Failure::default(),
        })),
    };
    host.transport.block_on(async {
        let (first, second, ()) = tokio::join!(
            host.acquire_tile(request(0)),
            host.acquire_tile(request(1)),
            async {
                tokio::task::yield_now().await;
                assert_eq!(prompts.get(), 1);
                host.controls.pause();
                send.send(RetryChoice::Retry).unwrap();
                tokio::task::yield_now().await;
                host.controls.resume();
            }
        );
        first.unwrap();
        second.unwrap();
        host.acquire_tile(request(2)).await.unwrap();
        assert_eq!(
            prompts.get(),
            1,
            "later tiles at the approved attempt need no new question"
        );
        host.settle().await;
    });
    assert!(host.publication().is_none());
    drop(host);
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn compatible_single_tile_iiif_preserves_bytes_without_pixel_decoding() {
    let work = temp_dir("iiif-reuse");
    for extension in ["jpg", "png"] {
        let source = work.join(format!("source-{extension}.dzi"));
        let tiles = work.join(format!("source-{extension}_files/4"));
        std::fs::create_dir_all(&tiles).unwrap();
        std::fs::write(&source, format!("<Image TileSize=\"16\" Overlap=\"0\" Format=\"{extension}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"16\" Height=\"16\"/></Image>")).unwrap();
        let pixels = image::RgbaImage::from_pixel(16, 16, image::Rgba([40, 70, 90, 255]));
        let bytes = if extension == "jpg" {
            dezoomify_native::imaging::encode_jpeg(&pixels, 83, None).unwrap()
        } else {
            dezoomify_native::imaging::encode_png(
                &pixels,
                image::codecs::png::CompressionType::Fast,
                None,
                None,
            )
            .unwrap()
        };
        std::fs::write(tiles.join(format!("0_0.{extension}")), &bytes).unwrap();
        dezoomify_native::cache::store(
            &work.join("cache"),
            &dezoomify_native::cache::job_namespace(source.to_str().unwrap()),
            tiles.join(format!("0_0.{extension}")).to_str().unwrap(),
            &bytes[..bytes.len() - 1],
        )
        .unwrap();
        let destination = work.join(format!("out-{extension}.iiif"));
        let host = NativeHost::new(JobOptions {
            input_url: source.to_str().unwrap().into(),
            output: OutputTarget::File(destination.clone()),
            largest: true,
            compression: 99,
            cache_dir: Some(work.join("cache")),
            ..Default::default()
        })
        .unwrap();
        host.transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .unwrap();
        let saved = host.publication().unwrap();
        assert_eq!(saved.instrumentation.pixel_decodes, 0);
        assert_eq!(
            std::fs::read(destination.join(format!("0,0,16,16/16,/0/default.{extension}")))
                .unwrap(),
            bytes
        );
        assert_eq!(
            std::fs::read(destination.join(format!("full/16,/0/default.{extension}"))).unwrap(),
            bytes
        );
        for path in ["0,0,16,16/16,16", "full/full"] {
            assert_eq!(
                std::fs::read(destination.join(format!("{path}/0/default.{extension}"))).unwrap(),
                bytes
            );
        }
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn odd_sized_and_mixed_codec_iiif_trees_roundtrip_through_the_reader() {
    use image::ImageDecoder as _;
    let work = temp_dir("iiif-roundtrip");
    let icc = vec![42; 1024];
    for mixed in [false, true] {
        let source = work.join("source.dzi");
        let tiles = work.join("source_files/10");
        std::fs::create_dir_all(&tiles).unwrap();
        std::fs::write(
            &source,
            DZI_512
                .replace("Width=\"512\"", "Width=\"513\"")
                .replace("Height=\"512\"", "Height=\"513\"")
                .replace("Format=\"png\"", "Format=\"jpg\""),
        )
        .unwrap();
        let mut original = image::RgbaImage::new(513, 513);
        for y in 0..3 {
            for x in 0..3 {
                let pixels = image::RgbaImage::from_pixel(
                    if x == 2 { 1 } else { 256 },
                    if y == 2 { 1 } else { 256 },
                    image::Rgba([x * 60, y * 80, 90, 255]),
                );
                let bytes = if mixed && x == 0 {
                    dezoomify_native::imaging::encode_jpeg(&pixels, 83, Some(&icc)).unwrap()
                } else {
                    dezoomify_native::imaging::encode_png(
                        &pixels,
                        image::codecs::png::CompressionType::Fast,
                        Some(&icc),
                        None,
                    )
                    .unwrap()
                };
                image::imageops::overlay(
                    &mut original,
                    &image::load_from_memory(&bytes).unwrap().into_rgba8(),
                    i64::from(x) * 256,
                    i64::from(y) * 256,
                );
                std::fs::write(tiles.join(format!("{x}_{y}.jpg")), bytes).unwrap();
            }
        }
        let destination = work.join(format!("out-{mixed}.iiif"));
        let result = support::run_file(source.to_str().unwrap(), &destination, |o| {
            o.largest = true;
            o.cache_dir = Some(work.join(format!("cache-{mixed}")));
        })
        .unwrap();
        let info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(destination.join("info.json")).unwrap()).unwrap();
        assert!(info["profile"]
            .as_array()
            .unwrap()
            .iter()
            .all(serde_json::Value::is_object));
        assert_eq!(
            std::fs::read(destination.join("512,512,1,1/1,/0/default.png")).unwrap(),
            std::fs::read(tiles.join("2_2.jpg")).unwrap(),
        );
        let mut expected = image::RgbaImage::new(257, 257);
        for (x, y, region, width, height) in [
            (0, 0, "0,0,512,512", 256, 256),
            (256, 0, "512,0,1,512", 1, 256),
            (0, 256, "0,512,512,1", 256, 1),
            (256, 256, "512,512,1,1", 1, 1),
        ] {
            let bytes =
                std::fs::read(destination.join(format!("{region}/{width},{height}/0/default.png")))
                    .unwrap();
            assert_eq!(
                image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes))
                    .unwrap()
                    .icc_profile()
                    .unwrap(),
                Some(icc.clone()),
            );
            assert_eq!(
                std::fs::read(destination.join(format!("{region}/{width},/0/default.png")))
                    .unwrap(),
                bytes
            );
            image::imageops::overlay(
                &mut expected,
                &image::load_from_memory(&bytes).unwrap().into_rgba8(),
                x,
                y,
            );
        }
        let output = work.join(format!("roundtrip-{mixed}.png"));
        support::run_file(
            destination.join("info.json").to_str().unwrap(),
            &output,
            |o| {
                o.zoom_level = Some(1);
                o.cache_dir = Some(work.join("reader-cache"));
            },
        )
        .unwrap();
        assert_eq!(image::open(output).unwrap().into_rgba8(), expected);
        let mut reference = original;
        for side in [257, 129] {
            reference = image::imageops::resize(
                &reference,
                side,
                side,
                image::imageops::FilterType::Triangle,
            );
        }
        let overview = image::open(destination.join("full/129,/0/default.png"))
            .unwrap()
            .into_rgba8();
        for (actual, expected) in overview
            .get_pixel(128, 128)
            .0
            .into_iter()
            .zip(reference.get_pixel(128, 128).0)
        {
            assert!(
                actual.abs_diff(expected) <= 2,
                "coarser level reused a public edge collision"
            );
        }
        assert!(!destination.join(".pyramid").exists());
        fn files(path: &std::path::Path) -> Vec<std::path::PathBuf> {
            std::fs::read_dir(path)
                .unwrap()
                .flat_map(|e| {
                    let p = e.unwrap().path();
                    if p.is_dir() {
                        files(&p)
                    } else {
                        vec![p]
                    }
                })
                .collect()
        }
        let files = files(&destination);
        assert!(files.iter().all(|p| p.extension().unwrap() != "jpg"));
        assert_eq!(
            result.instrumentation.encoded_bytes,
            files
                .iter()
                .map(|p| p.metadata().unwrap().len())
                .sum::<u64>()
        );
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn zif_reuses_standalone_jpeg_and_rgb_png_tiles() {
    let work = temp_dir("zif-reuse");
    for (extension, width, index) in [
        ("jpg", 16, 0),
        ("png", 16, 0),
        ("jpg", 32, 1),
        ("png", 32, 1),
    ] {
        let source = work.join(format!("source-{extension}-{width}.dzi"));
        let level = if width == 16 { 4 } else { 5 };
        let tiles = work.join(format!("source-{extension}-{width}_files/{level}"));
        std::fs::create_dir_all(&tiles).unwrap();
        std::fs::write(&source, format!("<Image TileSize=\"16\" Overlap=\"0\" Format=\"{extension}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"{width}\" Height=\"16\"/></Image>")).unwrap();
        let pixels = image::RgbImage::from_pixel(16, 16, image::Rgb([40, 70, 90]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        pixels
            .write_to(
                &mut bytes,
                if extension == "jpg" {
                    image::ImageFormat::Jpeg
                } else {
                    image::ImageFormat::Png
                },
            )
            .unwrap();
        let bytes = bytes.into_inner();
        std::fs::write(tiles.join(format!("{index}_0.{extension}")), &bytes).unwrap();
        let lower_bytes = if width == 32 {
            let lower = work.join(format!("source-{extension}-{width}_files/4"));
            std::fs::create_dir_all(&lower).unwrap();
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::RgbImage::from_pixel(16, 8, image::Rgb([90, 70, 40]))
                .write_to(
                    &mut bytes,
                    if extension == "jpg" {
                        image::ImageFormat::Jpeg
                    } else {
                        image::ImageFormat::Png
                    },
                )
                .unwrap();
            let bytes = bytes.into_inner();
            std::fs::write(lower.join(format!("0_0.{extension}")), &bytes).unwrap();
            Some(bytes)
        } else {
            None
        };
        dezoomify_native::cache::store(
            &work.join("cache"),
            &dezoomify_native::cache::job_namespace(source.to_str().unwrap()),
            tiles
                .join(format!("{index}_0.{extension}"))
                .to_str()
                .unwrap(),
            &bytes[..bytes.len() - 1],
        )
        .unwrap();
        let destination = work.join(format!("out-{extension}-{width}.zif"));
        let host = NativeHost::new(JobOptions {
            input_url: source.to_str().unwrap().into(),
            output: OutputTarget::File(destination.clone()),
            largest: true,
            compression: 99,

            max_retries: 0,
            cache_dir: Some(work.join("cache")),
            ..Default::default()
        })
        .unwrap();
        let result = host.transport.block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ));
        if index != 0 {
            assert!(matches!(
                result,
                Err(dezoomify::model::Error::TileFailed { tile: 0, .. })
            ));
            assert!(host.publication().is_none());
            assert!(!destination.exists());
            continue;
        }
        result.unwrap();
        let publication = host.publication().unwrap();
        assert_eq!(publication.instrumentation.pixel_decodes, 0);
        assert_eq!(
            publication.instrumentation.peak_retained_bytes, 0,
            "received grid tiles stream even when tile zero is missing"
        );
        let container = std::fs::read(publication.path).unwrap();
        let metadata = zif_tiff::std::read_zif(std::io::Cursor::new(&container)).unwrap();
        assert_eq!(metadata.level_count(), if index == 0 { 1 } else { 2 });
        assert_eq!(metadata.level(0).unwrap().tile_size(), (16, 16));
        for level in metadata.levels() {
            assert_eq!(
                level.ycbcr_subsampling(),
                (extension == "jpg").then_some((1, 1))
            );
        }
        for level in 0..metadata.level_count() {
            for tile in metadata.level_tiles(level).unwrap() {
                let range = tile.byte_range();
                image::load_from_memory(&container[range.start as usize..range.end as usize])
                    .unwrap();
            }
        }
        let range = metadata
            .level_tiles(0)
            .unwrap()
            .nth(index as usize)
            .unwrap()
            .byte_range();
        assert_eq!(&container[range.start as usize..range.end as usize], bytes);
        if let Some(bytes) = lower_bytes {
            let range = metadata
                .level_tiles(1)
                .unwrap()
                .next()
                .unwrap()
                .byte_range();
            assert_eq!(&container[range.start as usize..range.end as usize], bytes);
        }
    }
    let bytes = std::fs::read(
        dezoomify_fixture_server::scenarios_dir()
            .join("rs-core/formats/payloads/google_arts_and_culture/tile.jpg"),
    )
    .unwrap();
    let source = work.join("subsampled.dzi");
    std::fs::write(&source, "<Image TileSize=\"512\" Overlap=\"0\" Format=\"jpg\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"1000\" Height=\"1000\"/></Image>").unwrap();
    for (level, side) in [(10, 2), (9, 1)] {
        let tiles = work.join(format!("subsampled_files/{level}"));
        std::fs::create_dir_all(&tiles).unwrap();
        for y in 0..side {
            for x in 0..side {
                std::fs::write(tiles.join(format!("{x}_{y}.jpg")), &bytes).unwrap();
            }
        }
    }
    let result = support::run_file(
        source.to_str().unwrap(),
        &work.join("subsampled.zif"),
        |options| options.largest = true,
    )
    .unwrap();
    assert_eq!(result.instrumentation.pixel_decodes, 0);
    let container = std::fs::read(result.path).unwrap();
    let metadata = zif_tiff::std::read_zif(std::io::Cursor::new(&container)).unwrap();
    assert_eq!(metadata.level_count(), 2);
    assert_eq!(
        (
            metadata.level(0).unwrap().width(),
            metadata.level(1).unwrap().width()
        ),
        (1000, 500)
    );
    for level in 0..2 {
        assert_eq!(
            metadata.level(level).unwrap().ycbcr_subsampling(),
            Some((2, 2))
        );
        for tile in metadata.level_tiles(level).unwrap() {
            let range = tile.byte_range();
            assert_eq!(&container[range.start as usize..range.end as usize], bytes);
        }
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn truncated_source_tiles_fail_with_their_uri() {
    use dezoomify::model::Error;
    let work = temp_dir("iiif-truncated");
    let source = work.join("source.dzi");
    let tiles = work.join("source_files/5");
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&source, "<Image TileSize=\"16\" Overlap=\"0\" Format=\"png\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"32\" Height=\"16\"/></Image>").unwrap();
    let bytes = dezoomify_native::imaging::encode_png(
        &image::RgbaImage::new(16, 16),
        image::codecs::png::CompressionType::Fast,
        None,
        None,
    )
    .unwrap();
    let bad = tiles.join("1_0.png");
    std::fs::write(tiles.join("0_0.png"), &bytes).unwrap();
    let lower = work.join("source_files/4");
    std::fs::create_dir_all(&lower).unwrap();
    image::RgbImage::new(16, 8)
        .save(lower.join("0_0.png"))
        .unwrap();
    let mut clipped = dezoomify_native::imaging::encode_png(
        &image::RgbaImage::new(32, 16),
        image::codecs::png::CompressionType::Fast,
        None,
        None,
    )
    .unwrap();
    let data = clipped.windows(4).position(|v| v == b"IDAT").unwrap() + 4;
    clipped[data] ^= 0xff;
    // One fails inspection; the oversized PNG requires decoding before clipping.
    for (case, broken) in [
        ("png", &bytes[..bytes.len() - 1]),
        ("clipped", clipped.as_slice()),
    ] {
        std::fs::write(&bad, broken).unwrap();
        for extension in ["iiif", "zif"] {
            let host = NativeHost::new(JobOptions {
                input_url: source.to_string_lossy().into(),
                output: OutputTarget::File(work.join(format!("out-{case}.{extension}"))),
                largest: true,
                max_retries: 0,
                cache_dir: Some(work.join(format!("cache-{case}-{extension}"))),
                ..Default::default()
            })
            .unwrap();
            let error = support::run_host(&host).unwrap_err();
            assert!(
                matches!(&error, Error::TileFailed { tile: 1, attempts: 1, cause }
                if matches!(&**cause, Error::Resource { request, source, .. }
                    if request == bad.to_str().unwrap() && matches!(source.cause(), Error::DecodeFailed(_))))
            );
            assert!(host.publication().is_none());
            assert!(!work.join(format!("out-{case}.{extension}")).exists());
            drop(host);
        }
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn generic_probe_metadata_uses_final_tile_order_without_refetching() {
    use image::codecs::png::CompressionType;
    use image::ImageDecoder as _;

    let work = temp_dir("probe-metadata");
    let colors = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    let mut routes = HashMap::new();
    let mut profiles = Vec::new();
    let mut metadata = Vec::new();
    for (index, color) in colors.into_iter().enumerate() {
        let profile = vec![
            0,
            0,
            2,
            12,
            b'a',
            b'd',
            b's',
            b'p',
            index as u8,
            0,
            0,
            0,
            b'm',
            b'n',
            b't',
            b'r',
            b'R',
            b'G',
            b'B',
            b' ',
        ];
        let exif = vec![b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0, 42, index as u8];
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba(color));
        let png = dezoomify_native::imaging::encode_png(
            &image,
            CompressionType::Fast,
            Some(&profile),
            Some(&exif),
        )
        .unwrap();
        routes.insert(
            format!("/tile-{}_{}.png", index % 2, index / 2),
            http_response("200 OK", "image/png", &png),
        );
        profiles.push(profile);
        metadata.push(exif);
    }
    let counts = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_counted(Arc::new(Mutex::new(routes)), Arc::clone(&counts));
    let output = work.join("image.png");
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/tile-{{{{X}}}}_{{{{Y}}}}.png"),
        output: OutputTarget::File(output.clone()),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .unwrap();
    let publication = host.publication().unwrap();
    assert_eq!(publication.tile_count, 4);
    assert!(
        publication.output.disposition == dezoomify::model::OutputDisposition::NativePublication
    );
    let mut saved =
        image::codecs::png::PngDecoder::new(std::io::Cursor::new(std::fs::read(output).unwrap()))
            .unwrap();
    assert_eq!(saved.icc_profile().unwrap(), Some(profiles[0].clone()));
    assert_eq!(saved.exif_metadata().unwrap(), Some(metadata[0].clone()));
    let pixels = image::DynamicImage::from_decoder(saved).unwrap().to_rgba8();
    assert_eq!(pixels.dimensions(), (4, 4));
    for (index, color) in colors.into_iter().enumerate() {
        assert_eq!(
            pixels
                .get_pixel((index as u32 % 2) * 2, (index as u32 / 2) * 2)
                .0,
            color
        );
        assert_eq!(
            counts.lock().unwrap()[&format!("/tile-{}_{}.png", index % 2, index / 2)],
            1
        );
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn http_failures_retain_the_request_context_and_transport() {
    use dezoomify::{host::Host, model::*};

    let routes = Arc::new(Mutex::new(HashMap::from([(
        "/blocked".to_string(),
        http_response("403 Forbidden", "text/plain", b"access denied"),
    )])));
    let base = serve_counted(routes, Arc::default());
    let uri = format!("{base}/blocked");
    let work = temp_dir("request-facts");
    let host = NativeHost::new(JobOptions {
        input_url: uri.clone(),
        output: OutputTarget::File(work.join("image.png")),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    host.transport.block_on(async {
        let request = ResourceRequest {
            uri: uri.clone(),
            headers: Vec::new(),
            purpose: RequestPurpose::Metadata,
        };
        let metadata = host
            .fetch(request.clone(), Interaction::Forbidden)
            .await
            .unwrap_err();
        let tile = host
            .acquire_tile(
                Tile {
                    index: 0,
                    request: ResourceRequest {
                        purpose: RequestPurpose::Tile,
                        ..request
                    },
                    placement: TilePlacement {
                        position: Point { x: 0, y: 0 },
                        expected_size: None,
                        canvas: None,
                        processing: ProcessingRecipe::None,
                        role: TileRole::output(),
                    },
                }
                .into(),
            )
            .await
            .unwrap_err();
        for (error, kind) in [
            (&metadata, ResourceKind::Metadata),
            (&tile, ResourceKind::Tile),
        ] {
            let Error::Resource {
                request: context,
                resource_kind,
                source,
            } = error
            else {
                panic!("host failures carry request context")
            };
            assert_eq!(context, &uri);
            assert_eq!(*resource_kind, kind);
            assert_eq!(
                **source,
                Error::HttpError {
                    status: 403,
                    retry_after_ms: None,
                    preview: None,
                    transport: ErrorTransport::Native,
                    failure: Failure {
                        request: Some(uri.clone()),
                        detail: None,
                    },
                }
            );
            assert!(!error.retryable());
            assert!(error.to_string().contains("403"));
        }
        host.settle().await;
    });
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn malformed_encrypted_tile_retains_processing_failure_without_publication() {
    use dezoomify::{host::Host, model::*};

    let work = temp_dir("encrypted-failure");
    let valid = scenario_payload("tile-0_0.png");
    std::fs::write(work.join("good.png"), &valid).unwrap();
    // Encryption marker followed by an impossible plaintext header length.
    std::fs::write(work.join("bad.bin"), [10, 10, 10, 10, 255, 255, 255, 255]).unwrap();
    let output = work.join("image.png");
    let host = NativeHost::new(JobOptions {
        input_url: work.join("tiles.yaml").to_string_lossy().into_owned(),
        output: OutputTarget::File(output.clone()),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    let canvas = Size {
        width: 512,
        height: 256,
    };
    let tile = |index, name: &str| Tile {
        index,
        request: ResourceRequest {
            uri: work.join(name).to_string_lossy().into_owned(),
            headers: Vec::new(),
            purpose: RequestPurpose::Tile,
        },
        placement: TilePlacement {
            position: Point {
                x: index * 256,
                y: 0,
            },
            expected_size: Some(Size {
                width: 256,
                height: 256,
            }),
            canvas: Some(canvas.clone()),
            processing: ProcessingRecipe::GoogleArtsDecrypt,
            role: TileRole::output(),
        },
    };
    host.transport.block_on(async {
        host.acquire_tile(tile(0, "good.png").into()).await.unwrap();
        let error = host
            .acquire_tile(tile(1, "bad.bin").into())
            .await
            .unwrap_err();
        let Error::Resource {
            request,
            resource_kind,
            source,
        } = &error
        else {
            panic!("host failures carry request context")
        };
        assert_eq!(
            request,
            &work.join("bad.bin").to_string_lossy().into_owned()
        );
        assert_eq!(*resource_kind, ResourceKind::Tile);
        assert!(
            matches!(&**source, Error::ProcessingFailed(Failure { detail: Some(detail), .. })
                if detail.contains("unencrypted header"))
        );
        assert!(!error.retryable());
        let mut corrupt_image = tile(1, "bad.bin");
        corrupt_image.placement.processing = ProcessingRecipe::None;
        let decode_error = host.acquire_tile(corrupt_image.into()).await.unwrap_err();
        assert!(
            matches!(decode_error.cause(), Error::DecodeFailed(_)),
            "decode failure: {decode_error}"
        );
        host.settle().await;
    });
    assert!(!output.exists());
    assert!(host.publication().is_none());
    let report = host.diagnostics.report();
    let fields = serde_json::to_value(&report.failures[0].first.fields).unwrap();
    assert_eq!(fields["kind"], "resource");
    assert_eq!(fields["resource_kind"], "tile");
    assert_eq!(fields["source.kind"], "processing-failed");
    assert!(
        fields["source.detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("unencrypted header")),
        "failure record keeps the cause: {fields}"
    );
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn automatic_output_uses_the_selected_title_and_avoids_overwriting() {
    let work = temp_dir("automatic-title");
    std::fs::write(work.join("tile.png"), scenario_payload("tile-0_0.png")).unwrap();
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, format!(
        "url_template: '{}'\nx_template: '0'\ny_template: '0'\nvariables:\n  - {{ name: x, from: 0, to: 0 }}\nwidth: 256\nheight: 256\ntitle: 'An image title'\n",
        work.join("tile.png").display(),
    )).unwrap();
    let options = JobOptions {
        input_url: manifest.to_string_lossy().into_owned(),
        output: OutputTarget::AutoDir {
            dir: work.clone(),
            format: dezoomify::model::OutputFormat::Png,
        },
        ..Default::default()
    };
    let first = support::run_options_observed(options.clone(), |_, _| {}).unwrap();
    assert_eq!(first.path.file_name().unwrap(), "An-image-title.png");
    let original = std::fs::read(&first.path).unwrap();
    let second = support::run_options_observed(options, |_, _| {}).unwrap();
    assert_eq!(second.path.file_name().unwrap(), "An-image-title-2.png");
    assert_eq!(std::fs::read(first.path).unwrap(), original);
    let automatic = support::run_options_observed(
        JobOptions {
            input_url: manifest.to_string_lossy().into_owned(),
            output: OutputTarget::AutoImageDir { dir: work.clone() },
            ..Default::default()
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(automatic.path.file_name().unwrap(), "An-image-title.jpg");
    let image = image::open(&automatic.path).unwrap();
    assert_eq!((image.width(), image.height()), (256, 256));
    image::RgbImage::new(65_536, 1)
        .save(work.join("tile.png"))
        .unwrap();
    let source = std::fs::read_to_string(&manifest).unwrap();
    std::fs::write(
        &manifest,
        source.replace("width: 256\nheight: 256", "width: 65536\nheight: 1"),
    )
    .unwrap();
    let large = support::run_options_observed(
        JobOptions {
            input_url: manifest.to_string_lossy().into_owned(),
            output: OutputTarget::AutoImageDir { dir: work.clone() },
            ..Default::default()
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(large.path.extension().unwrap(), "png");
    let image = image::open(&large.path).unwrap();
    assert_eq!((image.width(), image.height()), (65_536, 1));
}

#[test]
fn automatic_output_requires_all_tiles_and_preserves_source_alpha() {
    let work = temp_dir("automatic-required-tiles");
    let source = work.join("source.dzi");
    let tiles = work.join("source_files/5");
    std::fs::create_dir_all(&tiles).unwrap();
    std::fs::write(&source, "<Image TileSize=\"16\" Overlap=\"0\" Format=\"png\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"32\" Height=\"16\"/></Image>").unwrap();
    image::RgbaImage::from_pixel(16, 16, image::Rgba([100, 150, 200, 255]))
        .save(tiles.join("0_0.png"))
        .unwrap();
    let options = JobOptions {
        input_url: source.to_string_lossy().into(),
        output: OutputTarget::AutoImageDir { dir: work.clone() },
        largest: true,
        max_retries: 0,
        ..Default::default()
    };
    let error = support::run_options_observed(options.clone(), |_, _| {}).unwrap_err();
    assert!(matches!(error, dezoomify::model::Error::TileFailed { .. }));
    assert!(!work.join("source.png").exists());
    assert!(!work.join("source.jpg").exists());
    let mut transparent = image::RgbaImage::from_pixel(16, 16, image::Rgba([100, 150, 200, 255]));
    transparent.save(tiles.join("1_0.png")).unwrap();
    transparent.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
    transparent.save(tiles.join("0_0.png")).unwrap();
    let complete = support::run_options_observed(
        JobOptions {
            cache_dir: Some(work.join("fresh-cache")),
            ..options
        },
        |_, _| {},
    )
    .unwrap();

    assert_eq!(complete.path.extension().unwrap(), "png");
    assert_eq!(
        image::open(complete.path)
            .unwrap()
            .into_rgba8()
            .get_pixel(0, 0)[3],
        0
    );
    std::fs::remove_dir_all(work).unwrap();
}

/// Loopback server delaying tile bodies: at cancel time fetches are mid-air
/// and decodes may be starting, so the cancel path must quiesce tracked
/// async tasks and blocking decode tails before reporting the terminal.
fn serve_counted_with_tile_delay(
    shared: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
    tile_delay: Duration,
) -> String {
    let server = dezoomify_fixture_server::NodeServer::raw("127.0.0.1", move |request| {
        let path = request.path;
        if path.contains("/pyr_files/") {
            std::thread::sleep(tile_delay);
        }
        counts
            .lock()
            .expect("lock")
            .entry(path.clone())
            .and_modify(|n| *n += 1)
            .or_insert(1);
        shared
            .lock()
            .expect("lock")
            .get(&path)
            .cloned()
            .unwrap_or_else(|| http_response("404 Not Found", "text/plain", b"not found"))
            .into()
    });
    let origin = server.origin.clone();
    std::mem::forget(server);
    origin
}

#[test]
fn bounded_concurrency_and_memory_accounting() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("memory");
    let output = work.join("memory.png");
    let config = JobOptions {
        max_concurrent: 2,

        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = support::run_with_options(
        &format!("{base}/pyr.dzi"),
        output.to_str().expect("utf8"),
        false,
        &config,
        &mut |_| {},
    )
    .expect("pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    let stats = &outcome.instrumentation;
    assert!(
        stats.peak_inflight <= 2 + 2,
        "one acquisition slot per tile bounds in-flight work: {}",
        stats.peak_inflight
    );
    assert!(stats.bytes_fetched > 0, "fetched bytes accounted");
    assert!(
        stats.peak_retained_bytes <= 512 << 20,
        "retention stays under the output cap on actual retained bytes"
    );
    assert!(output.exists());
}

/// Approved retries preserve good tiles; successes are never refetched.
#[test]
fn approved_retry_preserves_good_tiles() {
    use dezoomify::model::RetryChoice;
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // The last tile fails transiently until the retry heals it.
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("500 Internal Server Error", "text/plain", b"flaky"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("retry-approval");
    let output = work.join("retry.png");
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        // Exhaust automatic retries before asking for one additional attempt.
        max_retries: 1,
        // Hermetic tile cache: see above (ephemeral-port reuse + shared
        // default cache leaks stale entries into exact-count assertions).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let answered = std::rc::Rc::new(std::cell::Cell::new(false));
    let answer_record = answered.clone();
    host.on_retry(move |_| {
        answer_record.set(true);
        let good = scenario_payload("tile-1_1.png");
        shared.lock().expect("lock").insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("200 OK", "image/png", &good),
        );
        Box::pin(async { Ok(RetryChoice::Retry) })
    });
    let summary = support::run_host(&host).expect("retry heals the job");
    assert!(answered.get(), "retry approval surfaced");
    assert_eq!(summary.tile_count, 4);

    assert!(summary.output.disposition == dezoomify::model::OutputDisposition::NativePublication);
    assert!(output.exists());
    let counts = counts.lock().expect("lock");
    // Good tiles are never refetched after the retry: successes preserved.
    for tile in ["0_0", "1_0", "0_1"] {
        assert_eq!(
            counts
                .get(&format!("/pyr_files/9/{tile}.png"))
                .copied()
                .unwrap_or(0),
            1,
            "good tile preserved across retry: {counts:?}"
        );
    }
    assert!(
        counts.get("/pyr_files/9/1_1.png").copied().unwrap_or(0) >= 2,
        "failed tile retried: {counts:?}"
    );
}

/// In-flight decode bytes are tracked and bounded: every blocking decode
/// reserves its body bytes, the peak is reported in the instrumentation,
/// and it never exceeds the live slot budget times the largest body.
#[test]
fn decode_inflight_bytes_are_bounded_and_accounted() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut max_body = 0usize;
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            max_body = max_body.max(bytes.len());
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("decode-budget");
    let output = work.join("decode.png");
    let config = JobOptions {
        max_concurrent: 2,

        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = support::run_with_options(
        &format!("{base}/pyr.dzi"),
        output.to_str().expect("utf8"),
        false,
        &config,
        &mut |_| {},
    )
    .expect("pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    let stats = &outcome.instrumentation;
    assert!(
        stats.peak_decode_inflight_bytes > 0,
        "decode tracking observed live decode work"
    );
    assert!(
        stats.peak_decode_inflight_bytes <= 2 * max_body as u64,
        "in-flight decode bytes stay within the live slot budget: peak {} with 2 slots of at most {max_body} bytes",
        stats.peak_decode_inflight_bytes
    );
    assert!(output.exists());
}

/// Cancel mid-acquisition with slow tiles: the terminal waits for tracked
/// async tasks and blocking decode tails (quiescence including detached
/// tails), leaving the pre-existing destination byte-identical.
#[test]
fn cancel_during_acquisition_quiesces_without_publication() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted_with_tile_delay(
        Arc::clone(&shared),
        Arc::clone(&counts),
        Duration::from_millis(500),
    );
    let work = temp_dir("cancel-tails");
    let output = work.join("tails.png");
    std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
    let start = Instant::now();
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        max_concurrent: 4,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let controls = host.controls.clone();
    host.on_progress(move |progress| {
        if progress.phase == ProgressPhase::Acquisition {
            controls.cancel();
        }
    });
    let error = support::run_host(&host).expect_err("cancel wins the race");
    assert!(matches!(error.cause(), dezoomify::model::Error::Cancelled));
    assert!(
        start.elapsed() < Duration::from_secs(60),
        "cancel quiesces promptly, including decode tails"
    );
    assert_eq!(
        std::fs::read(&output).expect("sentinel readable"),
        b"pre-existing sentinel",
        "cancel never touches the pre-existing destination"
    );
    assert!(
        std::fs::read_dir(&work).unwrap().all(|entry| {
            let path = entry.unwrap().path();
            path == output || path == work.join("tile-cache")
        }),
        "cancellation removes job-owned staging"
    );
}

/// Cancellation settles an unanswered approval and removes job-owned staging
/// while preserving the destination.
#[test]
fn cancellation_during_unanswered_approval_preserves_destination() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // One tile never arrives: the invocation awaits retry approval where
        // the cancel race is deterministic.
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("503 Service Unavailable", "text/plain", b"missing"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("cancel-race");
    let output = work.join("race.png");
    std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
    let start = Instant::now();
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        max_retries: 0,
        retry_base_delay: Duration::ZERO,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let controls = host.controls.clone();
    host.on_retry(move |_| {
        controls.cancel();
        Box::pin(std::future::pending())
    });
    let error = support::run_host(&host).expect_err("cancel wins the race");
    assert!(matches!(error.cause(), dezoomify::model::Error::Cancelled));
    // Cancellation is prompt (bounded gate wait, aborted fetches, joined
    // tasks) and publishes nothing.
    assert!(
        start.elapsed() < Duration::from_secs(60),
        "cancel quiesces promptly"
    );
    assert_eq!(
        std::fs::read(&output).expect("sentinel readable"),
        b"pre-existing sentinel",
        "cancel never touches the pre-existing destination"
    );
    assert!(
        std::fs::read_dir(&work).unwrap().all(|entry| {
            let path = entry.unwrap().path();
            path == output || path == work.join("tile-cache")
        }),
        "cancellation removes job-owned staging"
    );
}
