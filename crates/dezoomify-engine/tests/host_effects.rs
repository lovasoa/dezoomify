//! Host-effect payloads: tile effects carry everything a pixel-owning host
//! needs (URI, headers, processing recipe, destination, expected extent,
//! canvas), discovery honors the host's post-redirect URL, and deferred
//! catalog entries expose their follow-up URI.

mod support;

use dezoomify_engine::Config;
use support::{JobCommand, ScriptedHost, DZI, DZI_INPUT_URL};

fn host_with_id(job: &str) -> ScriptedHost {
    ScriptedHost::new(job, DZI_INPUT_URL, Config::default()).unwrap()
}

fn resource(_job: &str, request: u32, bytes: Vec<u8>) -> JobCommand {
    JobCommand::ResourceBytes {
        request,
        bytes,
        final_uri: None,
    }
}

fn discover_select_grant(host: &mut ScriptedHost, job: &str) {
    host.start().unwrap();
    host.apply(resource(job, 0, DZI.as_bytes().to_vec()))
        .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
}

#[test]
fn tile_effects_carry_geometry_processing_and_canvas() {
    let mut host = host_with_id("job:tile-meta");
    discover_select_grant(&mut host, "job:tile-meta");
    assert_eq!(host.state(), "AcquiringTiles");
    let tiles: Vec<serde_json::Value> = host
        .effects
        .iter()
        .filter(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-tile"))
        .cloned()
        .collect();
    assert_eq!(tiles.len(), 4, "largest DZI level is a 2x2 grid");
    for tile in &tiles {
        let uri = tile
            .get("uri")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        assert!(
            uri.ends_with(".jpg"),
            "tile URI carries the DZI format: {uri}"
        );
        assert_eq!(
            tile.get("processing").and_then(serde_json::Value::as_str),
            Some("none"),
            "plain DZI tiles need no byte processing"
        );
        assert!(
            tile.get("headers")
                .and_then(serde_json::Value::as_object)
                .is_some(),
            "tile headers ride along even when empty"
        );
        let dest = tile.get("destination").expect("destination");
        assert!(
            dest.get("x").and_then(serde_json::Value::as_u64).is_some()
                && dest.get("y").and_then(serde_json::Value::as_u64).is_some(),
            "tile destination is explicit: {tile}"
        );
        let extent = tile.get("expected_size").expect("expected_size");
        assert_eq!(
            (
                extent.get("x").and_then(serde_json::Value::as_u64),
                extent.get("y").and_then(serde_json::Value::as_u64)
            ),
            (Some(256), Some(256)),
            "full grid cells declare their extent: {tile}"
        );
        let canvas = tile.get("canvas").expect("canvas");
        assert_eq!(
            (
                canvas.get("x").and_then(serde_json::Value::as_u64),
                canvas.get("y").and_then(serde_json::Value::as_u64)
            ),
            (Some(512), Some(512)),
            "canvas rides on every tile effect: {tile}"
        );
        assert!(
            tile.get("probe").is_none(),
            "ordinary tiles carry no probe marker: {tile}"
        );
    }
    let mut destinations: Vec<(u64, u64)> = tiles
        .iter()
        .map(|tile| {
            let dest = tile.get("destination").expect("destination");
            (
                dest.get("x")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                dest.get("y")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
        })
        .collect();
    destinations.sort_unstable();
    assert_eq!(
        destinations,
        vec![(0, 0), (0, 256), (256, 0), (256, 256)],
        "row-major 2x2 layout"
    );
}

#[test]
fn final_uri_rebases_relative_tile_urls() {
    // The bytes were read from a post-redirect URL: relative tile URLs must
    // resolve against it, not the pre-redirect request URI.
    let mut host = ScriptedHost::new(
        "job:redir",
        "https://cdn.test/old/image.dzi",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: Some("https://cdn.test/new/image.dzi".to_string()),
    })
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    for (_, uri, _) in host.tile_effects() {
        assert!(
            uri.starts_with("https://cdn.test/new/image_files/"),
            "tiles resolve against the post-redirect base: {uri}"
        );
    }
}

#[test]
fn deferred_entries_expose_their_follow_up_uri() {
    // A bulk list is still-deferred metadata: one entry per listed URL.
    let list = "https://example.test/a.dzi\nhttps://example.test/b.dzi\n";
    let mut host = ScriptedHost::new(
        "job:deferred",
        "https://example.test/list.txt",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    host.apply(resource("job:deferred", 0, list.as_bytes().to_vec()))
        .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    let catalog = host
        .events
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("catalog"))
        .expect("catalog event")
        .clone();
    let entries = catalog
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .expect("entries")
        .clone();
    assert_eq!(entries.len(), 2);
    assert!(
        entries.iter().all(|entry| {
            entry.get("kind").and_then(serde_json::Value::as_str) == Some("image-request")
        }),
        "bulk entries stay deferred: {catalog}"
    );
    // Deferred entries cannot be selected; the host follows the URI instead.
    let selected = host.apply(JobCommand::SelectImage { image: 0 });
    assert!(selected.is_err(), "deferred images are not selectable");
    assert_eq!(
        entries[0].get("uri").and_then(serde_json::Value::as_str),
        Some("https://example.test/a.dzi"),
        "the projected request carries the first listed URL"
    );
    assert_eq!(
        host.deferred_uri_for_test(0),
        Some("https://example.test/a.dzi".to_string()),
        "first entry resolves to the first listed URL"
    );
}
