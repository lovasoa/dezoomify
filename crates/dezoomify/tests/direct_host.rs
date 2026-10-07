mod support;
use dezoomify::{dezoomify, model::*};
use futures::FutureExt;
use std::num::NonZeroU64;
use support::MemoryHost;
const DZI: &str =
    r#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;
fn input() -> Vec<JobInput> {
    vec![JobInput {
        url: "https://images.test/image.dzi".into(),
        contents: Some(DZI.into()),
        kind: None,
    }]
}
fn options() -> Options {
    Options {
        format: Some("deepzoom".into()),
        ..Default::default()
    }
}
#[allow(clippy::result_large_err)]
fn invoke(host: &MemoryHost, options: Options) -> Result<Output, Error> {
    futures::executor::block_on(dezoomify(input(), options, host))
}
fn failure(status: u16) -> Error {
    Error::HttpError {
        status,
        retry_after_ms: None,
        preview: None,
        transport: ErrorTransport::DisplayOnly,
        failure: Failure::default(),
    }
}
fn fail(host: &MemoryHost, index: u32, errors: impl IntoIterator<Item = Error>) {
    host.failures
        .borrow_mut()
        .insert(index, errors.into_iter().collect());
}

#[test]
fn full_output_uses_lazy_geometry_and_honest_disposition() {
    let host = MemoryHost::default();
    host.yield_tiles.set(true);
    let output = invoke(&host, options()).unwrap();
    assert!(output.is_complete());
    assert_eq!(
        output.canvas,
        Some(Size {
            width: 512,
            height: 512
        })
    );
    assert_eq!(output.disposition, OutputDisposition::BrowserSaveReady);
    assert_eq!(host.acquired.borrow().len(), 4);
    assert_eq!(host.peak.get(), 4);
    assert_eq!(host.settled.get(), 1);
    assert_eq!(host.outputs.borrow().len(), 1);
    assert_eq!(
        host.acquired.borrow()[3].placement.position,
        Point { x: 256, y: 256 }
    );
    assert!(
        host.acquired.borrow()[3]
            .request
            .uri
            .ends_with("/image_files/9/1_1.jpg")
    );
}

#[test]
fn discovery_preserves_the_rejected_lookup_cause_after_a_failed_alternative() {
    let mut host = MemoryHost::default();
    host.resources.insert(
        "https://images.test/tour.xml".into(),
        ResourceResponse {
            bytes: b"<encrypted>not-valid-krpano-data</encrypted>".to_vec(),
            final_uri: None,
        },
    );
    let earlier = failure(403);
    host.fetch_failures
        .insert("https://images.test/first.js".into(), earlier);
    let rejected = Error::HttpError {
        status: 429,
        retry_after_ms: Some(7000),
        preview: Some("slow down".into()),
        transport: ErrorTransport::BrowserSession,
        failure: "final lookup details".to_string().into(),
    };
    host.fetch_failures
        .insert("https://images.test/second.js".into(), rejected.clone());
    let error = futures::executor::block_on(dezoomify(
        vec![JobInput {
            url: "https://images.test/index.html".into(),
            contents: Some(
                r#"<html><script src="first.js"></script><script src="second.js"></script><script>embedpano({xml:"tour.xml"});</script></html>"#.into(),
            ),
            kind: None,
        }],
        Options {
            format: Some("krpano".into()),
            ..Default::default()
        },
        &host,
    ))
    .unwrap_err();
    // The aggregate keeps the per-format evidence and the first typed
    // cause's complete context and retry verdict.
    let retained = rejected.resource("https://images.test/second.js", ResourceKind::Metadata);
    assert_eq!(
        error,
        Error::DiscoveryFailed {
            failure: " - krpano: HTTP 429 fetching this address"
                .to_string()
                .into(),
            cause: Some(Box::new(retained)),
        }
    );
    assert_eq!(error.cause().kind(), "http-error");
    assert!(error.retryable());
    assert_eq!(error.retry_after_ms(), Some(7000));
    assert_eq!(host.fetched.borrow().len(), 3);
    assert_eq!(host.settled.get(), 1);
}
#[test]
fn concurrency_remains_bounded_across_acquisition() {
    for concurrency in [1, 2, 3, 4] {
        let host = MemoryHost::default();
        host.yield_tiles.set(true);
        invoke(
            &host,
            Options {
                max_concurrent: concurrency,
                ..options()
            },
        )
        .unwrap();
        assert_eq!(host.peak.get(), concurrency);
    }
}

#[test]
fn slow_first_tile_does_not_hold_back_other_completions() {
    for output in [OutputFormat::Png, OutputFormat::Zif] {
        let host = MemoryHost::default();
        let (release, first) = futures::channel::oneshot::channel();
        *host.first_tile.borrow_mut() = Some(first);
        let job = dezoomify(
            input(),
            Options {
                output,
                max_concurrent: 2,
                ..options()
            },
            &host,
        );
        futures::pin_mut!(job);
        assert!(job.as_mut().now_or_never().is_none());
        assert_eq!(host.attempts.borrow().len(), 4);
        release.send(()).unwrap();
        assert!(futures::executor::block_on(job).unwrap().is_complete());
        assert_eq!(
            host.acquired.borrow().len(),
            if output == OutputFormat::Zif { 5 } else { 4 }
        );
        assert_eq!(
            host.output_plans.borrow()[0].tile_count,
            if output == OutputFormat::Zif { 5 } else { 4 }
        );
        assert_eq!(host.settled.get(), 1);
    }
}

#[test]
fn accepted_catalog_warns_once_for_malformed_siblings_and_keeps_valid_images() {
    let host = MemoryHost::default();
    let output = futures::executor::block_on(dezoomify(
        vec![JobInput {
            url: "https://images.test/tour.xml".into(),
            contents: Some(
                r#"<krpano>
                <scene name="bad1"><image><level tiledimagewidth="100" tiledimageheight="100"><flat url="missing.jpg"/></level></image></scene>
                <scene name="good"><image tilesize="100"><level tiledimagewidth="100" tiledimageheight="100"><flat url="tile.jpg"/></level></image></scene>
                <scene name="bad2"><image><level tiledimagewidth="100" tiledimageheight="100"><flat url="missing.jpg"/></level></image></scene>
                </krpano>"#.into(),
            ),
            kind: None,
        }],
        Options {
            format: Some("krpano".into()),
            selection: SelectionPolicy::Fitting {
                max_width: 1000,
                max_height: 1000,
                max_area: 1_000_000,
            },
            ..Default::default()
        },
        &host,
    ))
    .unwrap();
    assert!(output.is_complete());
    assert_eq!(host.acquired.borrow().len(), 1);
    assert_eq!(host.outputs.borrow()[0].title.as_deref(), Some("good"));
    assert_eq!(
        *host.warnings.borrow(),
        ["bad krpano level: missing tile size"]
    );
}
#[test]
fn transient_failures_honor_exact_budget_and_retry_after() {
    let host = MemoryHost::default();
    let throttled = Error::HttpError {
        status: 429,
        retry_after_ms: Some(7000),
        preview: None,
        transport: ErrorTransport::DisplayOnly,
        failure: Failure::default(),
    };
    let network = Error::NetworkFailure {
        transport: ErrorTransport::Direct,
        failure: Failure::default(),
    }
    .resource("https://images.test/tile.jpg", ResourceKind::Tile);
    assert!(network.retryable());
    fail(&host, 0, [throttled, network]);
    invoke(&host, options()).unwrap();
    assert_eq!(
        host.attempts.borrow().iter().filter(|i| **i == 0).count(),
        3
    );
    assert_eq!(*host.sleeps.borrow(), [7000, 2000]);
    assert!(host.partials.borrow().is_empty());
}
#[test]
fn permanent_failures_ask_partial_after_all_tiles_settle() {
    for error in [
        failure(403),
        Error::DecodeFailed("corrupt tile".to_string().into())
            .resource("https://images.test/tile.jpg", ResourceKind::Tile),
        Error::ProcessingFailed("invalid encrypted tile".to_string().into())
            .resource("https://images.test/tile.jpg", ResourceKind::Tile),
    ] {
        assert!(!error.retryable());
        let host = MemoryHost::default();
        fail(&host, 0, [error.clone()]);
        host.choices.borrow_mut().push_back(RecoveryChoice::Keep);
        let output = invoke(&host, options()).unwrap();
        assert!(!output.is_complete());
        assert_eq!(output.missing, [0]);
        assert_eq!(host.attempts.borrow().len(), 4);
        assert!(host.sleeps.borrow().is_empty());
        assert_eq!(host.partials.borrow()[0].missing[0].failures[0], error);
        assert_eq!(host.acquired.borrow().len(), 3);
    }
}
#[test]
fn partial_retry_only_reacquires_missing_tiles_with_a_fresh_budget() {
    let host = MemoryHost::default();
    fail(&host, 1, [failure(503), failure(503), failure(503)]);
    host.choices.borrow_mut().push_back(RecoveryChoice::Retry);
    let output = invoke(
        &host,
        Options {
            max_retries: 1,
            ..options()
        },
    )
    .unwrap();
    assert!(output.is_complete());
    assert_eq!(
        host.attempts.borrow().iter().filter(|i| **i == 1).count(),
        4
    );
    assert_eq!(host.acquired.borrow().len(), 4);
    assert_eq!(host.partials.borrow().len(), 1);
    assert_eq!(*host.sleeps.borrow(), [1000, 1000]);
}
#[test]
fn discard_and_empty_output_never_publish() {
    let host = MemoryHost::default();
    fail(&host, 0, [failure(404)]);
    let error = invoke(&host, options()).unwrap_err();
    assert!(matches!(
        &error,
        Error::PartialDiscarded {
            transient: false,
            ..
        }
    ));
    assert!(host.outputs.borrow().is_empty());
    assert_eq!(host.settled.get(), 1);
    let host = MemoryHost::default();
    for tile in 0..4 {
        fail(&host, tile, [failure(404)]);
    }
    let error = invoke(
        &host,
        Options {
            partial: PartialPolicy::Keep,
            ..options()
        },
    )
    .unwrap_err();
    // The aggregate retains every settled failure and derives its verdict
    // from the whole set.
    assert!(matches!(
        &error,
        Error::NoUsableTiles {
            transient: false,
            ..
        }
    ));
    assert!(!error.retryable());
    assert!(host.outputs.borrow().is_empty());
}
#[test]
fn invalid_binding_and_output_failures_abort_immediately() {
    for error in [
        Error::BindingInvalidValue("bad result".to_string().into()),
        Error::OutputUnavailable("canvas allocation failed".to_string().into()),
    ] {
        let host = MemoryHost::default();
        let expected = error.clone();
        fail(&host, 0, [error]);
        assert_eq!(
            invoke(
                &host,
                Options {
                    partial: PartialPolicy::Keep,
                    ..options()
                }
            )
            .unwrap_err(),
            expected
        );
        assert!(host.partials.borrow().is_empty());
        assert!(host.outputs.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}
#[test]
fn cancellation_and_publication_failure_always_settle() {
    let host = MemoryHost::default();
    host.cancel_after.set(Some(1));
    assert!(matches!(
        invoke(&host, options()).unwrap_err(),
        Error::Cancelled
    ));
    assert!(host.outputs.borrow().is_empty());
    assert_eq!(host.settled.get(), 1);
    let host = MemoryHost::default();
    *host.finish_error.borrow_mut() = Some(Error::OutputDenied);
    assert!(matches!(
        invoke(&host, options()).unwrap_err(),
        Error::OutputDenied
    ));
    assert_eq!(host.settled.get(), 1);
}
#[test]
fn host_reports_the_actual_output_disposition() {
    let host = MemoryHost::default();
    host.display_only.set(true);
    let output = invoke(&host, options()).unwrap();
    assert_eq!(output.disposition, OutputDisposition::DisplayOnly);
    assert_eq!(host.outputs.borrow().len(), 1);
}
#[test]
fn invalid_inputs_and_limits_are_rejected_before_host_reads() {
    for (options, kind) in [
        (
            Options {
                max_concurrent: 0,
                ..options()
            },
            "invalid-options",
        ),
        (
            Options {
                max_tiles: 0,
                ..options()
            },
            "invalid-options",
        ),
        (
            Options {
                max_bytes: 0,
                ..options()
            },
            "invalid-options",
        ),
        (
            Options {
                max_concurrent: 65,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_tiles: 16_777_217,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_bytes: 1,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_bytes: 4_294_967_297,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_retries: 1025,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_deferred_follows: 65,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                retry_base_delay_ms: 300_001,
                ..options()
            },
            "resource-limit",
        ),
        (
            Options {
                max_tiles: 1,
                ..options()
            },
            "invalid-options",
        ),
    ] {
        let host = MemoryHost::default();
        assert_eq!(invoke(&host, options).unwrap_err().kind(), kind);
        assert!(host.fetched.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
    let host = MemoryHost::default();
    assert_eq!(
        futures::executor::block_on(dezoomify(Vec::new(), options(), &host))
            .unwrap_err()
            .kind(),
        "invalid-input"
    );
    assert_eq!(host.settled.get(), 1);
}
#[test]
fn supplied_documents_obey_resource_limits_before_host_io() {
    for contents in [String::new(), "é".repeat(513)] {
        let host = MemoryHost::default();
        let error = futures::executor::block_on(dezoomify(
            vec![JobInput {
                contents: Some(contents),
                ..input().remove(0)
            }],
            Options {
                max_bytes: 1024,
                ..options()
            },
            &host,
        ))
        .unwrap_err();
        assert_eq!(error.kind(), "resource-limit");
        assert!(host.fetched.borrow().is_empty());
        assert!(host.probes.borrow().is_empty());
        assert!(host.acquired.borrow().is_empty());
        assert!(host.outputs.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}
#[test]
fn image_and_level_choices_are_checked() {
    let host = MemoryHost::default();
    host.image.set(20);
    assert_eq!(
        invoke(&host, options()).unwrap_err().kind(),
        "invalid-state"
    );
    let host = MemoryHost::default();
    host.level.set(Some(20));
    assert_eq!(
        invoke(&host, options()).unwrap_err().kind(),
        "invalid-state"
    );
    let host = MemoryHost::default();
    assert_eq!(
        invoke(
            &host,
            Options {
                max_tiles: 3,
                max_concurrent: 3,
                ..options()
            }
        )
        .unwrap_err()
        .kind(),
        "resource-limit"
    );
    assert!(host.acquired.borrow().is_empty());
}
#[test]
fn browser_fitting_and_native_selection_preserve_dimension_policy() {
    for (selection, expected) in [
        (
            SelectionPolicy::Fitting {
                max_width: 300,
                max_height: 300,
                max_area: 90000,
            },
            256,
        ),
        (
            SelectionPolicy::Fitting {
                max_width: 1,
                max_height: 1,
                max_area: 1,
            },
            1,
        ),
        (
            SelectionPolicy::Automatic {
                image_index: usize::MAX,
                largest: true,
                max_width: Some(1),
                max_height: Some(1),
                zoom_level: None,
            },
            512,
        ),
        (
            SelectionPolicy::Automatic {
                image_index: 0,
                largest: false,
                max_width: Some(300),
                max_height: Some(300),
                zoom_level: None,
            },
            256,
        ),
        (
            SelectionPolicy::Automatic {
                image_index: 0,
                largest: true,
                max_width: None,
                max_height: None,
                zoom_level: Some(0),
            },
            1,
        ),
    ] {
        let host = MemoryHost::default();
        let output = invoke(
            &host,
            Options {
                selection,
                ..options()
            },
        )
        .unwrap();
        assert_eq!(output.canvas.unwrap().width, expected);
    }
}
#[test]
fn generic_probes_reuse_placed_tiles_and_keep_boundaries() {
    let host = MemoryHost::default();
    host.probe_results.borrow_mut().extend([
        ProbeOutcome::Available {
            width: NonZeroU64::new(256).unwrap(),
            height: NonZeroU64::new(256).unwrap(),
        },
        ProbeOutcome::Missing,
        ProbeOutcome::Missing,
        ProbeOutcome::Missing,
    ]);
    let output = futures::executor::block_on(dezoomify(
        vec![JobInput::new("https://tiles.test/{{X}}/{{Y}}.jpg")],
        Options {
            format: Some("generic".into()),
            ..Default::default()
        },
        &host,
    ))
    .unwrap();
    assert_eq!(
        output.canvas,
        Some(Size {
            width: 256,
            height: 256
        })
    );
    assert!(host.acquired.borrow().is_empty());
    assert_eq!(host.probes.borrow().len(), 4);
    assert_eq!(
        host.probes.borrow()[0].placement.role,
        TileRole::probe_and_output()
    );
}

#[test]
fn probe_budget_stops_generic_search_and_iiif_fallback_before_excess_io() {
    let metadata = r#"{"@context":"http://iiif.io/api/image/3/context.json","id":"https://tiles.test/iiif","type":"ImageService3","width":256,"height":256,"extraFeatures":["sizeUpscaling"],"tiles":[{"width":256,"scaleFactors":[1]}]}"#;
    for (input, first_probe) in [
        (
            JobInput::new("https://tiles.test/{{X}}/{{Y}}.jpg"),
            ProbeOutcome::Available {
                width: NonZeroU64::new(256).unwrap(),
                height: NonZeroU64::new(256).unwrap(),
            },
        ),
        (
            JobInput {
                url: "https://tiles.test/iiif/info.json".into(),
                contents: Some(metadata.into()),
                kind: None,
            },
            ProbeOutcome::Missing,
        ),
    ] {
        let host = MemoryHost::default();
        host.probe_results.borrow_mut().push_back(first_probe);
        let error = futures::executor::block_on(dezoomify(
            vec![input],
            Options {
                max_tiles: 1,
                max_concurrent: 1,
                ..Default::default()
            },
            &host,
        ))
        .unwrap_err();
        assert_eq!(error.kind(), "resource-limit");
        assert_eq!(host.probes.borrow().len(), 1);
        assert!(host.fetched.borrow().is_empty());
        assert!(host.acquired.borrow().is_empty());
        assert!(host.outputs.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}

#[test]
fn pause_blocks_new_acquisition_and_retry_waits_until_resume() {
    for failed in [false, true] {
        let host = MemoryHost::default();
        let (resume, barrier) = futures::channel::oneshot::channel();
        *host.resume.borrow_mut() = Some(barrier);
        host.pause_after_attempt.set(Some(1));
        if failed {
            fail(&host, 0, [failure(503)]);
        }
        let mut future = Box::pin(dezoomify(
            input(),
            Options {
                max_concurrent: 1,
                ..options()
            },
            &host,
        ));
        assert!(future.as_mut().now_or_never().is_none());
        assert_eq!(host.attempts.borrow().len(), 1);
        assert!(host.sleeps.borrow().is_empty());
        assert!(host.outputs.borrow().is_empty());
        host.paused.set(false);
        resume.send(()).unwrap();
        assert!(futures::executor::block_on(future).unwrap().is_complete());
        assert_eq!(host.acquired.borrow().len(), 4);
        assert_eq!(host.sleeps.borrow().len(), usize::from(failed));
    }
}

#[test]
fn automatic_selection_follows_catalog_entries_and_rejects_cycles() {
    let mut host = MemoryHost::default();
    host.resources.insert(
        "https://images.test/image.dzi".into(),
        ResourceResponse {
            bytes: DZI.as_bytes().to_vec(),
            final_uri: None,
        },
    );
    let inputs = vec![
        JobInput {
            url: "https://images.test/list.txt".into(),
            contents: Some("https://images.test/image.dzi".into()),
            kind: None,
        },
        JobInput {
            url: "https://images.test/image.dzi".into(),
            contents: None,
            kind: Some(DiscoveryInputKind::ObservedResource),
        },
    ];
    let opts = Options {
        max_deferred_follows: 1,
        selection: SelectionPolicy::Fitting {
            max_width: 300,
            max_height: 300,
            max_area: 90000,
        },
        ..Default::default()
    };
    let output = futures::executor::block_on(dezoomify(inputs, opts, &host)).unwrap();
    assert_eq!(output.canvas.unwrap().width, 256);
    assert_eq!(
        host.fetched
            .borrow()
            .iter()
            .filter(|request| request.uri.ends_with("image.dzi"))
            .count(),
        1
    );
    let mut host = MemoryHost::default();
    host.resources.insert(
        "https://images.test/list.txt".into(),
        ResourceResponse {
            bytes: b"https://images.test/list.txt".to_vec(),
            final_uri: None,
        },
    );
    let options = Options {
        selection: SelectionPolicy::Automatic {
            image_index: 0,
            largest: true,
            max_width: None,
            max_height: None,
            zoom_level: None,
        },
        ..Default::default()
    };
    let error = futures::executor::block_on(dezoomify(
        vec![JobInput::new("https://images.test/list.txt")],
        options,
        &host,
    ))
    .unwrap_err();
    assert_eq!(error, Error::DeferredLimit { max: 8 });
    assert_eq!(host.fetched.borrow().len(), 1);
    assert!(host.outputs.borrow().is_empty());
}

#[test]
fn deferred_cycles_do_not_reacquire_supplied_sources_or_their_redirected_addresses() {
    const SOURCE: &str = "https://images.test/list.txt";
    const REDIRECTED: &str = "https://images.test/catalog/list.txt";
    for (supplied, final_uri, target) in [
        (true, None, SOURCE),
        (false, Some(REDIRECTED), SOURCE),
        (false, Some(REDIRECTED), REDIRECTED),
    ] {
        let mut host = MemoryHost::default();
        host.resources.insert(
            SOURCE.into(),
            ResourceResponse {
                bytes: target.as_bytes().to_vec(),
                final_uri: final_uri.map(str::to_owned),
            },
        );
        let error = futures::executor::block_on(dezoomify(
            vec![JobInput {
                url: SOURCE.into(),
                contents: supplied.then(|| target.to_owned()),
                kind: None,
            }],
            Options {
                format: Some("bulk_text".into()),
                ..Default::default()
            },
            &host,
        ))
        .unwrap_err();
        assert_eq!(error, Error::DeferredLimit { max: 8 });
        assert_eq!(host.fetched.borrow().len(), usize::from(!supplied));
        assert!(host.outputs.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
}

#[test]
fn unsupported_schemes_and_zero_canvas_limits_are_rejected() {
    for uri in [
        "ftp://images.test/image.dzi",
        "javascript:void(0)",
        "data:text/html,metadata",
        "file://remote.test/image.dzi",
    ] {
        let host = MemoryHost::default();
        let error =
            futures::executor::block_on(dezoomify(vec![JobInput::new(uri)], options(), &host))
                .unwrap_err();
        assert_eq!(error.kind(), "invalid-input");
        assert!(host.fetched.borrow().is_empty());
    }
    let host = MemoryHost::default();
    let error = invoke(
        &host,
        Options {
            selection: SelectionPolicy::Fitting {
                max_width: 0,
                max_height: 10,
                max_area: 100,
            },
            ..options()
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), "invalid-options");
}

#[test]
fn missing_tiles_preserve_the_complete_original_host_error() {
    let host = MemoryHost::default();
    let error = Error::HttpError {
        status: 403,
        retry_after_ms: Some(5000),
        preview: Some("denied body".into()),
        transport: ErrorTransport::Native,
        failure: Failure {
            request: Some("https://redirected.test/image?signature=precise".into()),
            detail: Some("original diagnostic context".into()),
        },
    };
    fail(&host, 0, [error.clone()]);
    host.choices.borrow_mut().push_back(RecoveryChoice::Keep);
    invoke(&host, options()).unwrap();
    let partials = host.partials.borrow();
    assert_eq!(partials[0].missing[0].failures[0], error);
    assert!(!partials[0].missing[0].failures[0].retryable());
    assert_eq!(
        partials[0].missing[0].failures[0].retry_after_ms(),
        Some(5000)
    );
}
