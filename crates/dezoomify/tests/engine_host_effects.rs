//! Host-effect payloads: discovery honors the host's post-redirect URL.

mod support;

use dezoomify::engine::{Config, UserCommand};
use support::{DZI, ScriptedHost};

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
    host.provide_metadata(
        0,
        DZI.as_bytes(),
        Some("https://cdn.test/new/image.dzi".to_string()),
    )
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.command(UserCommand::SelectImage { image }).unwrap();
    host.command(UserCommand::SelectLevel {
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
