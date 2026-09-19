//! Host-effect payloads: discovery honors the host's post-redirect URL.

mod support;

use dezoomify_engine::Config;
use support::{JobCommand, ScriptedHost, DZI};

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
