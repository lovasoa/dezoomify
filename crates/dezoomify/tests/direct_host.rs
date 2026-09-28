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
    let mut e = Error::new(
        "TRANSPORT_HTTP_ERROR",
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
    assert!(output.complete);
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
    assert!(!output.complete);
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
    assert!(output.complete);
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
        "job.partial-discarded"
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
        "job.no-usable-tiles"
    );
    assert!(host.outputs.borrow().is_empty());
}
#[test]
fn invalid_binding_and_output_allocation_failures_abort_immediately() {
    for (code, phase) in [
        ("binding.invalid-value", ErrorPhase::Acquisition),
        ("OUTPUT_ALLOCATION_FAILED", ErrorPhase::Output),
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
    assert_eq!(invoke(&host, options()).unwrap_err().code, "job.cancelled");
    assert!(host.outputs.borrow().is_empty());
    assert_eq!(host.settled.get(), 1);
    let host = MemoryHost::default();
    *host.finish_error.borrow_mut() = Some(Error::new(
        "output.denied",
        ErrorPhase::Publication,
        "denied",
    ));
    assert_eq!(invoke(&host, options()).unwrap_err().code, "output.denied");
    assert_eq!(host.settled.get(), 1);
}
#[test]
fn display_only_tiles_produce_display_only_output() {
    let host = MemoryHost::default();
    host.display_only.set(true);
    let output = invoke(&host, options()).unwrap();
    assert_eq!(output.disposition, OutputDisposition::DisplayOnly);
    assert!(host.outputs.borrow()[0].display_only);
}
#[test]
fn invalid_inputs_and_limits_are_rejected_before_host_reads() {
    for options in [
        Options {
            max_concurrent: 0,
            ..options()
        },
        Options {
            max_tiles: 0,
            ..options()
        },
        Options {
            max_bytes: 1,
            ..options()
        },
        Options {
            max_retries: 1025,
            ..options()
        },
    ] {
        let host = MemoryHost::default();
        assert_eq!(
            invoke(&host, options).unwrap_err().code,
            "job.resource-limit"
        );
        assert!(host.fetched.borrow().is_empty());
        assert_eq!(host.settled.get(), 1);
    }
    let host = MemoryHost::default();
    assert_eq!(
        futures::executor::block_on(dezoomify(Vec::new(), options(), &host))
            .unwrap_err()
            .code,
        "job.invalid-input"
    );
    assert_eq!(host.settled.get(), 1);
}
#[test]
fn image_and_level_choices_are_checked() {
    let host = MemoryHost::default();
    host.image.set(20);
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        "job.invalid-selection"
    );
    let host = MemoryHost::default();
    host.level.set(Some(20));
    assert_eq!(
        invoke(&host, options()).unwrap_err().code,
        "job.invalid-selection"
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
        "job.resource-limit"
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
    assert!(host.probes.borrow()[0].placement.probe_output);
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
        assert!(futures::executor::block_on(future).unwrap().complete);
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
    let inputs = vec![JobInput {
        url: "https://images.test/list.txt".into(),
        contents: Some("https://images.test/image.dzi".into()),
        kind: None,
    }];
    let opts = Options {
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
    assert_eq!(error.code, "job.deferred-limit");
    assert!(host.outputs.borrow().is_empty());
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
        assert_eq!(error.code, "job.invalid-input");
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
    assert_eq!(error.code, "job.invalid-options");
}

#[test]
fn missing_tile_details_preserve_observed_transport_and_refusal() {
    let host = MemoryHost::default();
    let mut error = failure(403);
    error.transport = Some(ErrorTransport::BrowserSession);
    error.blocked_reason = Some(BlockedReason::Forbidden);
    error.preview = Some("denied body".into());
    fail(&host, 0, [error]);
    host.choices.borrow_mut().push_back(RecoveryChoice::Keep);
    invoke(&host, options()).unwrap();
    let partials = host.partials.borrow();
    let observed = partials[0].missing[0].failures[0]
        .observed
        .as_ref()
        .unwrap();
    assert_eq!(observed.http, Some(403));
    assert_eq!(observed.transport, ErrorTransport::BrowserSession);
    assert_eq!(observed.blocked_reason, Some(BlockedReason::Forbidden));
    assert_eq!(observed.preview.as_deref(), Some("denied body"));
}
