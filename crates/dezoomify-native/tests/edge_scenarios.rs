//! Malformed metadata, wire responses, and redirects exercise real native I/O.
use std::sync::{Arc, Mutex};

use dezoomify_native::diagnostics::Diagnostics;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};
mod support;

#[test]
fn edge_responses_control_publication_and_keep_request_context() {
    let origin = support::start_fixture_server();
    for (input, code, retryable, purpose) in [
        ("cache-304/pyramid.dzi", "partial-discarded", false, "tile"),
        ("exif/pyramid.dzi", "ok", false, "metadata"),
        (
            "gzip-cache/pyramid.dzi",
            "discovery-failed",
            false,
            "metadata",
        ),
        (
            "malformed-json/info.json",
            "discovery-failed",
            false,
            "metadata",
        ),
        (
            "malformed-xml/broken.dzi",
            "discovery-failed",
            false,
            "metadata",
        ),
        (
            "range-truncate/pyramid.dzi",
            "partial-discarded",
            false,
            "tile",
        ),
        ("redirect-chain/start", "ok", false, "metadata"),
        ("redirect-loop/start", "redirect-limit", false, "metadata"),
        ("resume-offline/pyramid.dzi", "ok", false, "metadata"),
        (
            "throttle-429/pyramid.dzi",
            "partial-discarded",
            true,
            "tile",
        ),
        ("zero-tile/empty.dzi", "no-image-found", false, "metadata"),
    ] {
        let dir = support::temp_dir(&format!("edge-{}", input.replace('/', "-")));
        let output = dir.join("out.png");
        let records = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&records);
        let diagnostics = Diagnostics::new("edge-test", "0");
        diagnostics.set_sink(move |record| {
            sink.lock()
                .unwrap()
                .push(serde_json::to_value(record).unwrap());
        });
        let host = NativeHost::with_diagnostics(
            JobOptions {
                input_url: format!("{origin}/fetch?url=https://fixtures.test/edge/{input}"),
                output: OutputTarget::File(output.clone()),
                cache_dir: Some(dir.join("cache")),
                keep_partial: false,
                ..Default::default()
            },
            diagnostics,
        )
        .unwrap();
        let result = support::run_host(&host);
        if code == "ok" {
            let publication = result.unwrap_or_else(|error| panic!("{input}: {error}"));
            assert!(publication.output.is_complete(), "{input}");
            assert_eq!(publication.tile_count, 4, "{input}");
            assert_eq!(image::open(output).unwrap().width(), 512, "{input}");
        } else {
            let error = result.expect_err(input);
            assert_eq!(error.cause().kind(), code, "{input}: {error}");
            assert_eq!(error.retryable(), retryable, "{input}: {error}");
            assert!(!output.exists(), "{input} wrote output after failure");
            assert!(
                records.lock().unwrap().iter().any(|record| {
                    record["event"] == "request"
                        && record["fields"]["purpose"] == purpose
                        && record["fields"]["transport"] == "native"
                }),
                "{input} lost transport/request context"
            );
        }
    }
}
