mod support;

use dezoomify::core::discovery::DiscoveryInput;
use dezoomify::core::{DiscoveredEntry, DiscoveryCatalog, DiscoveryError, Grid, TileSource};
use dezoomify::model::{ResourceRead, ResourceResponse};
use std::cell::RefCell;
use zif_tiff::{Codec, ColorModel, LevelConfig, WriteBatch, Writer};

fn apply(bytes: &mut Vec<u8>, batch: WriteBatch) {
    for action in batch.into_actions() {
        let start = action.offset as usize;
        let end = start + action.bytes.len();
        bytes.resize(bytes.len().max(end), 0);
        bytes[start..end].copy_from_slice(&action.bytes);
    }
}

fn pyramid(dimensions: &[(u64, u64)]) -> Vec<u8> {
    let mut builder = Writer::new()
        .codec(Codec::Jpeg)
        .color_model(ColorModel::YCbCr)
        .channels(3)
        .unwrap();
    for &size in dimensions {
        builder = builder.level(LevelConfig::new(size, (16, 16)).unwrap());
    }
    let mut writer = builder.build().unwrap();
    let mut bytes = Vec::new();
    apply(&mut bytes, writer.init().unwrap());
    for (level, &(w, h)) in dimensions.iter().enumerate() {
        for row in 0..h.div_ceil(16) {
            for col in 0..w.div_ceil(16) {
                let payload = format!("level {level}, tile {col},{row}");
                apply(
                    &mut bytes,
                    writer
                        .put_tile_at_level(level, (col, row), payload.as_bytes())
                        .unwrap(),
                );
            }
        }
    }
    bytes
}

fn discover(bytes: &[u8], redirected: bool) -> Result<DiscoveryCatalog, DiscoveryError> {
    let requests = RefCell::new(Vec::new());
    let source = "https://test/image.ZIF?token=exact%2Fvalue";
    let final_uri = "https://cdn.test/image.zif?token=exact%2Fvalue";
    let catalog =
        futures::executor::block_on(dezoomify::core::registry_for("zif").unwrap().discover(
            vec![DiscoveryInput::new(source)],
            Default::default(),
            |request, _| {
                requests.borrow_mut().push(request.clone());
                assert_eq!(
                    request.uri,
                    if redirected && requests.borrow().len() > 1 {
                        final_uri
                    } else {
                        source
                    }
                );
                let range = request
                    .header("range")
                    .unwrap()
                    .strip_prefix("bytes=")
                    .unwrap();
                let (start, end) = range.split_once('-').unwrap();
                let start = start.parse::<usize>().unwrap();
                let end = end.parse::<usize>().unwrap();
                assert!(end - start < 1024 * 1024);
                assert!(end < bytes.len());
                let body = bytes[start..=end].to_vec();
                async move {
                    Ok(ResourceRead::Response {
                        response: ResourceResponse {
                            bytes: body,
                            final_uri: redirected.then(|| final_uri.to_string()),
                        },
                    })
                }
            },
            support::parse_html,
            |_| async { Ok(Vec::new()) },
        ))?;
    let requests = requests.into_inner();
    assert!(
        requests.len() > 3,
        "incremental reads must complete despite sharing a URL"
    );
    assert_eq!(requests[0].header("Range"), Some("bytes=0-15"));
    Ok(catalog)
}

fn grids(catalog: &DiscoveryCatalog) -> Vec<&Grid> {
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!("one image")
    };
    assert_eq!(image.format, "zif");
    image
        .levels
        .iter()
        .map(|level| match &level.source {
            TileSource::Grid(grid) => grid,
            _ => panic!("regular tiles"),
        })
        .collect()
}

#[test]
fn direct_ranges_preserve_queries_redirects_and_every_tile() {
    let bytes = pyramid(&[(33, 35), (16, 17), (8, 8)]);
    let catalog = discover(&bytes, true).unwrap();
    let [DiscoveredEntry::Ready(image)] = catalog.entries() else {
        panic!()
    };
    assert_eq!(
        image.source_url.as_deref(),
        Some("https://cdn.test/image.zif?token=exact%2Fvalue")
    );
    let levels = grids(&catalog);
    assert_eq!(levels.len(), 3);
    for (level, grid) in levels.iter().rev().enumerate() {
        for tile in grid.tiles_row_major() {
            let tile = tile.unwrap();
            assert_eq!(tile.request.uri, image.source_url.as_deref().unwrap());
            let range = tile
                .request
                .header("range")
                .unwrap()
                .strip_prefix("bytes=")
                .unwrap();
            let (start, end) = range.split_once('-').unwrap();
            let payload = &bytes[start.parse::<usize>().unwrap()..=end.parse::<usize>().unwrap()];
            let col = tile.destination.x / 16;
            let row = tile.destination.y / 16;
            assert_eq!(
                payload,
                format!("level {level}, tile {col},{row}").as_bytes()
            );
        }
    }
}

#[test]
fn malformed_and_truncated_metadata_cannot_publish_an_image() {
    for bytes in [vec![0; 16], pyramid(&[(32, 32)])[..16].to_vec()] {
        let result =
            futures::executor::block_on(dezoomify::core::registry_for("zif").unwrap().discover(
                vec![DiscoveryInput::new("https://test/image.zif")],
                Default::default(),
                |_, _| async {
                    Ok(ResourceRead::Response {
                        response: ResourceResponse {
                            bytes: bytes.clone(),
                            final_uri: None,
                        },
                    })
                },
                support::parse_html,
                |_| async { Ok(Vec::new()) },
            ));
        assert!(result.is_err());
    }
}

#[test]
fn a_large_tile_index_is_read_in_bounded_distinct_ranges() {
    let tile_count = 131_073u64;
    let mut writer = Writer::new()
        .dimensions((tile_count * 16, 16))
        .tile_size((16, 16))
        .unwrap()
        .codec(Codec::Jpeg)
        .color_model(ColorModel::YCbCr)
        .channels(3)
        .unwrap()
        .build()
        .unwrap();
    let mut bytes = Vec::new();
    apply(&mut bytes, writer.init().unwrap());
    let payload_offset = bytes.len() as u64;
    // Every tile references the same tiny payload: only the index is large.
    let u64_at = |bytes: &[u8], at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    let directory = u64_at(&bytes, 8) as usize;
    let entries = u64_at(&bytes, directory) as usize;
    for i in 0..entries {
        let entry = directory + 8 + i * 20;
        let tag = u16::from_le_bytes(bytes[entry..entry + 2].try_into().unwrap());
        if matches!(tag, 324 | 325) {
            let start = u64_at(&bytes, entry + 12) as usize;
            for tile in 0..tile_count as usize {
                if tag == 324 {
                    bytes[start + tile * 8..start + tile * 8 + 8]
                        .copy_from_slice(&payload_offset.to_le_bytes());
                } else {
                    bytes[start + tile * 4..start + tile * 4 + 4]
                        .copy_from_slice(&1u32.to_le_bytes());
                }
            }
        }
    }
    bytes.push(b'x');
    let catalog = discover(&bytes, false).unwrap();
    assert_eq!(grids(&catalog)[0].count(), tile_count);
}

#[test]
fn directory_collections_and_unwritten_tiles_are_rejected() {
    for bytes in [pyramid(&[(32, 32), (32, 32)]), zif_tiff::sample_file()] {
        let result = discover(&bytes, false);
        assert!(
            result.is_err(),
            "non-pyramids and missing tiles must not produce plans"
        );
    }
}
