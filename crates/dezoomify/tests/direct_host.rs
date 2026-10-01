mod support;
use dezoomify::model::ErrorCode;
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
    let mut e = Error::new(
        ErrorCode::TransportHttpError,
        ErrorPhase::Acquisition,
        "tile refused",
    );
    e.http = Some(status);
    e
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
    let mut earlier = failure(403);
    earlier.phase = ErrorPhase::Discovery;
    host.fetch_failures
        .insert("https://images.test/first.js".into(), earlier);
    let mut rejected = failure(429);
    rejected.phase = ErrorPhase::Discovery;
    rejected.message = "the final viewer lookup was throttled".into();
    rejected.transport = Some(ErrorTransport::BrowserSession);
    rejected.blocked_reason = Some(BlockedReason::Throttled);
    rejected.resource_kind = Some(ResourceKind::Metadata);
    rejected.retry_after_ms = Some(7000);
    rejected.preview = Some("slow down".into());
    rejected.detail = Some("final lookup details".into());
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
    rejected.retryable = true;
    rejected.request = Some("https://images.test/second.js".into());
    assert_eq!(error, rejected);
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
    let mut error = failure(429);
    error.retry_after_ms = Some(7000);
    fail(&host, 0, [error, failure(503)]);
    invoke(&host, options()).unwrap();
    assert_eq!(
        host.attempts.borrow().iter().filter(|i| **i == 0).count(),
        3
    );
    assert_eq!(*host.sleeps.borrow(), [7000, 2000]);
    assert!(host.partials.borrow().is_empty());
}
#[test]
fn forbidden_is_permanent_and_partial_is_asked_after_all_tiles_settle() {
    let host = MemoryHost::default();
    fail(&host, 0, [failure(403)]);
    host.choices.borrow_mut().push_back(RecoveryChoice::Keep);
    let output = invoke(&host, options()).unwrap();
    assert!(!output.is_complete());
    assert_eq!(output.missing, [0]);
    assert_eq!(host.attempts.borrow().len(), 4);
    assert!(host.sleeps.borrow().is_empty());
    assert_eq!(
        host.partials.borrow()[0].missing[0].failures[0].http,
        Some(403)
    );
    assert_eq!(host.acquired.borrow().len(), 3);
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
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        ErrorCode::JobPartialDiscarded
    );
    assert!(host.outputs.borrow().is_empty());
    assert_eq!(host.settled.get(), 1);
    let host = MemoryHost::default();
    for tile in 0..4 {
        fail(&host, tile, [failure(404)]);
    }
    assert_eq!(
        invoke(
            &host,
            Options {
                partial: PartialPolicy::Keep,
                ..options()
            }
        )
        .unwrap_err()
        .code,
        ErrorCode::JobNoUsableTiles
    );
    assert!(host.outputs.borrow().is_empty());
}
#[test]
fn invalid_binding_and_output_allocation_failures_abort_immediately() {
    for (code, phase) in [
        (ErrorCode::BindingInvalidValue, ErrorPhase::Acquisition),
        (ErrorCode::CanvasAllocationFailed, ErrorPhase::Output),
    ] {
        let host = MemoryHost::default();
        fail(&host, 0, [Error::new(code, phase, "bad result")]);
        assert_eq!(
            invoke(
                &host,
                Options {
                    partial: PartialPolicy::Keep,
                    ..options()
                }
            )
            .unwrap_err()
            .code,
            code
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
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        ErrorCode::JobCancelled
    );
    assert!(host.outputs.borrow().is_empty());
    assert_eq!(host.settled.get(), 1);
    let host = MemoryHost::default();
    *host.finish_error.borrow_mut() = Some(Error::new(
        ErrorCode::OutputDenied,
        ErrorPhase::Publication,
        "denied",
    ));
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        ErrorCode::OutputDenied
    );
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
    for (options, code) in [
        (
            Options {
                max_concurrent: 0,
                ..options()
            },
            ErrorCode::JobInvalidConfig,
        ),
        (
            Options {
                max_tiles: 0,
                ..options()
            },
            ErrorCode::JobInvalidConfig,
        ),
        (
            Options {
                max_bytes: 0,
                ..options()
            },
            ErrorCode::JobInvalidConfig,
        ),
        (
            Options {
                max_concurrent: 65,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_tiles: 16_777_217,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_bytes: 1,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_bytes: 4_294_967_297,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_retries: 1025,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_deferred_follows: 65,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                retry_base_delay_ms: 300_001,
                ..options()
            },
            ErrorCode::JobResourceLimit,
        ),
        (
            Options {
                max_tiles: 1,
                ..options()
            },
            ErrorCode::JobInvalidConfig,
        ),
    ] {
        let host = MemoryHost::default();
        assert_eq!(invoke(&host, options).unwrap_err().code, code);
        assert!(host.fetched.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
    let host = MemoryHost::default();
    assert_eq!(
        futures::executor::block_on(dezoomify(Vec::new(), options(), &host))
            .unwrap_err()
            .code,
        ErrorCode::JobInvalidInput
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
        assert_eq!(error.code, ErrorCode::JobResourceLimit);
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
        invoke(&host, options()).unwrap_err().code,
        ErrorCode::JobInvalidSelection
    );
    let host = MemoryHost::default();
    host.level.set(Some(20));
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        ErrorCode::JobInvalidSelection
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
        .code,
        ErrorCode::JobResourceLimit
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
        assert_eq!(error.code, ErrorCode::JobResourceLimit);
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
    assert_eq!(error.code, ErrorCode::JobDeferredLimit);
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
        assert_eq!(error.code, ErrorCode::JobDeferredLimit);
        assert_eq!(error.phase, ErrorPhase::Discovery);
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
        assert_eq!(error.code, ErrorCode::JobInvalidInput);
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
    assert_eq!(error.code, ErrorCode::JobInvalidOptions);
}

#[test]
fn missing_tiles_preserve_the_complete_original_host_error() {
    let host = MemoryHost::default();
    let mut error = failure(403);
    error = error.with_code(ErrorCode::HostInternal);
    error.transport = Some(ErrorTransport::Native);
    error.request = Some("https://redirected.test/image?signature=precise".into());
    error.resource_kind = Some(ResourceKind::Tile);
    error.retry_after_ms = Some(5000);
    error.blocked_reason = Some(BlockedReason::Forbidden);
    error.preview = Some("denied body".into());
    error.detail = Some("original diagnostic context".into());
    fail(&host, 0, [error.clone()]);
    host.choices.borrow_mut().push_back(RecoveryChoice::Keep);
    invoke(&host, options()).unwrap();
    let partials = host.partials.borrow();
    assert_eq!(partials[0].missing[0].failures[0], error);
    assert!(!partials[0].missing[0].failures[0].retryable);
    assert_eq!(
        partials[0].missing[0].failures[0].retry_after_ms,
        Some(5000)
    );
}
