mod support;
use core::discovery::{DiscoveryInput, DiscoveryLimits, url_suffix, viewer};
use dezoomify::{
    core::{
        self, DiscoveredEntry, DiscoveryCatalog, DiscoveryError, DiscoveryResource, FormatSpec,
        ParsedResource, Request, ResolvedImage,
    },
    model::{Error, Interaction, ResourceRead, ResourceResponse},
};
use futures::FutureExt;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    task::Poll,
};
fn catalog(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    Ok(ParsedResource::Complete(DiscoveryCatalog::new([
        DiscoveredEntry::Ready(ResolvedImage {
            title: Some(resource.text_lossy().into()),
            ..Default::default()
        }),
    ])))
}
const FIRST: FormatSpec = FormatSpec::new(
    "first",
    &[viewer(url_suffix("/root"))
        .resolve_metadata(|_| Ok(Request::new("https://test/a")))
        .then_decode(catalog)],
);
const SECOND: FormatSpec = FormatSpec::new(
    "second",
    &[viewer(url_suffix("/root"))
        .resolve_metadata(|_| Ok(Request::new("https://test/b")))
        .then_decode(catalog)],
);
fn registry() -> core::Registry {
    let mut r = core::Registry::new();
    r.register(FIRST);
    r.register(SECOND);
    r
}
fn response(text: &str) -> ResourceRead {
    ResourceRead::Response {
        response: ResourceResponse {
            bytes: text.as_bytes().to_vec(),
            final_uri: None,
        },
    }
}
fn selected(catalog: DiscoveryCatalog) -> String {
    match &catalog.entries()[0] {
        DiscoveredEntry::Ready(image) => {
            if image
                .title
                .as_deref()
                .is_some_and(|title| title.starts_with("https://test/"))
            {
                assert_eq!(
                    image.source_url, image.title,
                    "canonical URL belongs to the winning branch"
                );
            }
            image.title.clone().unwrap()
        }
        _ => panic!("ready image"),
    }
}

#[test]
fn decoding_defaults_to_the_final_target_through_decoder_bound_references() {
    fn page(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        Ok(resource.follow_relative("metadata").decode_with(metadata))
    }
    fn metadata(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        Ok(resource
            .follow_relative("image?token=exact%2Fvalue&size=full")
            .decode_with(catalog))
    }
    const SPEC: FormatSpec =
        FormatSpec::new("default", &[viewer(url_suffix("/root")).decode(page)]);
    let mut registry = core::Registry::new();
    registry.register(SPEC);
    let result = futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        Default::default(),
        |request, _| async move {
            Ok(ResourceRead::Response {
                response: ResourceResponse {
                    bytes: request.uri.as_bytes().to_vec(),
                    final_uri: request.uri.contains("/image?").then(|| {
                        "https://redirect.test/image?token=exact%2Fvalue&size=full".into()
                    }),
                },
            })
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert_eq!(
        support::ready_image(result).source_url.as_deref(),
        Some("https://redirect.test/image?token=exact%2Fvalue&size=full")
    );
}

#[test]
fn intermediate_decoding_retains_the_default_page_source() {
    fn page(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        Ok(resource
            .follow_relative("auxiliary")
            .decode_intermediate_with(contextual_image))
    }
    fn contextual_image(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        let page =
            resource.context().resources().next().ok_or_else(|| {
                DiscoveryError::InvalidMetadata("page context is required".into())
            })?;
        assert_eq!(page.uri(), "https://test/root");
        catalog(resource)
    }
    const ROUTE: core::DiscoveryRoute = viewer(url_suffix("/root")).decode(page);
    const UNMARKED: FormatSpec = FormatSpec::new("context", &[ROUTE.non_canonical()]);
    const DEFAULT: FormatSpec = FormatSpec::new("context", &[ROUTE]);
    const BOUND: FormatSpec = FormatSpec::new(
        "context",
        &[viewer(url_suffix("/root"))
            .decode(|resource| Ok(resource.follow_relative("auxiliary")))
            .then_decode_intermediate(contextual_image)],
    );
    const ROUTED: FormatSpec = FormatSpec::new(
        "context",
        &[
            viewer(url_suffix("/root"))
                .decode(|resource| Ok(resource.follow_relative("auxiliary"))),
            viewer(url_suffix("/auxiliary"))
                .decode(contextual_image)
                .non_canonical(),
        ],
    );
    for (spec, expected) in [
        (UNMARKED, None),
        (DEFAULT, Some("https://test/root")),
        (BOUND, Some("https://test/root")),
        (ROUTED, Some("https://test/root")),
    ] {
        let mut registry = core::Registry::new();
        registry.register(spec);
        let result = futures::executor::block_on(registry.discover(
            vec![DiscoveryInput::new("https://test/root")],
            Default::default(),
            |_, _| async { Ok(response("image")) },
            support::parse_html,
            |_| async { Ok(Vec::new()) },
        ))
        .unwrap();
        let [DiscoveredEntry::Ready(image)] = result.entries() else {
            panic!("ready image")
        };
        assert_eq!(image.source_url.as_deref(), expected);
    }
}
#[test]
fn a_successful_fetch_with_rejected_metadata_cannot_set_the_winners_source() {
    fn rejected(_: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        Err(DiscoveryError::InvalidMetadata("not an image".into()))
    }
    const REJECTED: FormatSpec = FormatSpec::new(
        "rejected",
        &[viewer(url_suffix("/root"))
            .resolve_metadata(|_| Ok(Request::new("https://test/a")))
            .then_decode(rejected)],
    );
    const UNMARKED: FormatSpec = FormatSpec::new(
        "unmarked",
        &[viewer(url_suffix("/root"))
            .resolve_metadata(|_| Ok(Request::new("https://test/b")))
            .then_decode_intermediate(catalog)
            .non_canonical()],
    );
    for marked in [false, true] {
        let mut registry = core::Registry::new();
        registry.register(REJECTED);
        registry.register(if marked { SECOND } else { UNMARKED });
        let result = futures::executor::block_on(registry.discover(
            vec![DiscoveryInput::new("https://test/root")],
            Default::default(),
            |request, _| async move { Ok(response(&request.uri)) },
            support::parse_html,
            |_| async { Ok(Vec::new()) },
        ))
        .unwrap();
        let image = support::ready_image(result);
        assert_eq!(image.title.as_deref(), Some("https://test/b"));
        assert_eq!(
            image.source_url.as_deref(),
            marked.then_some("https://test/b")
        );
    }
}
#[test]
fn an_earlier_ordinary_read_keeps_precedence_over_a_later_ready_image() {
    let (send, receive) = futures::channel::oneshot::channel::<()>();
    let receive = RefCell::new(Some(receive));
    let registry = registry();
    let future = registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        Default::default(),
        |request, _| {
            let wait = if request.uri.ends_with("/a") {
                receive.borrow_mut().take()
            } else {
                None
            };
            async move {
                if let Some(wait) = wait {
                    wait.await.unwrap();
                }
                Ok(response(&request.uri))
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    );
    let mut future = Box::pin(future);
    assert!(future.as_mut().now_or_never().is_none());
    send.send(()).unwrap();
    assert_eq!(
        selected(futures::executor::block_on(future).unwrap()),
        "https://test/a"
    );
}
#[test]
fn a_later_stalled_read_cannot_delay_an_earlier_winner() {
    let started = Cell::new(0);
    let registry = registry();
    let future = registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        Default::default(),
        |request, _| {
            started.set(started.get() + 1);
            async move {
                if request.uri.ends_with("/b") {
                    return std::future::pending().await;
                }
                let mut yielded = false;
                futures::future::poll_fn(|cx| {
                    if yielded {
                        Poll::Ready(())
                    } else {
                        yielded = true;
                        cx.waker().wake_by_ref();
                        Poll::Pending
                    }
                })
                .await;
                Ok(response("first"))
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    );
    let mut future = Box::pin(future);
    assert!(future.as_mut().now_or_never().is_none());
    assert_eq!(started.get(), 2);
    assert_eq!(
        selected(
            future
                .as_mut()
                .now_or_never()
                .expect("later pending read must not block")
                .unwrap()
        ),
        "first"
    );
}
#[test]
fn blocked_access_yields_to_ordinary_work_without_asking_for_permission() {
    let calls = RefCell::new(Vec::new());
    let registry = registry();
    let catalog = futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        Default::default(),
        |request, interaction| {
            calls.borrow_mut().push((request.uri.clone(), interaction));
            async move {
                Ok(if request.uri.ends_with("/a") {
                    ResourceRead::NeedsAccess {
                        origin: "https://test".into(),
                    }
                } else {
                    response("public")
                })
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert_eq!(selected(catalog), "public");
    assert!(
        calls
            .borrow()
            .iter()
            .all(|(_, i)| *i == Interaction::Forbidden)
    );
}

#[test]
fn live_observations_win_before_blocked_http_access() {
    const DZI: &str = "<Image TileSize=\"256\" Overlap=\"0\" Format=\"jpg\"><Size Width=\"512\" Height=\"512\"/></Image>";
    let calls = RefCell::new(Vec::new());
    let catalog = futures::executor::block_on(core::default_registry().discover(
        vec![DiscoveryInput::with_contents(
            "https://test/root",
            br#"<a href="https://blocked.test/image.dzi">image</a>"#,
        )],
        Default::default(),
        |_, interaction| async move {
            assert_eq!(interaction, Interaction::Forbidden);
            Ok(ResourceRead::NeedsAccess {
                origin: "https://blocked.test".into(),
            })
        },
        support::parse_html,
        |interaction| {
            calls.borrow_mut().push(interaction);
            async move {
                assert_eq!(interaction, Interaction::Forbidden);
                Ok(vec![
                    DiscoveryInput::with_contents("https://viewer.test/#loaded", DZI)
                        .with_kind(dezoomify::model::DiscoveryInputKind::ObservedMetadata),
                ])
            }
        },
    ))
    .unwrap();
    assert_eq!(support::ready_image(catalog).format, "deepzoom");
    assert_eq!(*calls.borrow(), [Interaction::Forbidden]);
}

#[test]
fn declared_catalog_precedes_the_loaded_pages_snapshot() {
    use dezoomify::model::DiscoveryInputKind;
    let catalog = futures::executor::block_on(core::default_registry().discover(
        vec![
            DiscoveryInput::with_contents(
                "https://viewer.onb.ac.at/1000ABD0",
                "<html></html>",
            ),
            DiscoveryInput::with_contents(
                "https://images.test/first/info.json",
                include_str!("../../../fixtures/iiif/v3/info.json")
                    .replace("{{origin}}/fixtures/iiif/v3", "https://images.test/first"),
            )
            .with_kind(DiscoveryInputKind::ObservedMetadata),
            DiscoveryInput::new("https://api.onb.ac.at/iiif/presentation/v3/manifest/1000ABD0")
                .with_kind(DiscoveryInputKind::ObservedResource),
        ],
        Default::default(),
        |request, _| async move {
            assert_eq!(
                request.uri,
                "https://api.onb.ac.at/iiif/presentation/v3/manifest/1000ABD0"
            );
            Ok(ResourceRead::Response {
                response: ResourceResponse {
                    bytes: include_bytes!("../../../fixtures/iiif/manifest/manifest.json").to_vec(),
                    final_uri: None,
                },
            })
        },
        support::parse_html,
        |_| async { panic!("no additional source access is needed") },
    ))
    .unwrap();
    assert_eq!(catalog.len(), 1);
    assert!(
        matches!(&catalog.entries()[0], core::DiscoveredEntry::Deferred(resource)
        if resource.uri == "https://api.onb.ac.at/iiif/presentation/v3/v3/info.json")
    );
}

#[test]
fn deferred_frame_observations_precede_permissions_for_unrelated_resources() {
    let observations = RefCell::new(Vec::new());
    let catalog = futures::executor::block_on(core::default_registry().discover(
        vec![DiscoveryInput::new("https://analytics.test/script.js")
            .with_kind(dezoomify::model::DiscoveryInputKind::ObservedResource)],
        Default::default(),
        |_, interaction| async move {
            assert_eq!(interaction, Interaction::Forbidden, "the viewer should win before analytics access");
            Ok(ResourceRead::NeedsAccess { origin: "https://analytics.test".into() })
        },
        support::parse_html,
        |interaction| {
            observations.borrow_mut().push(interaction);
            async move {
                Ok(if interaction == Interaction::Forbidden { Vec::new() } else {
                    vec![DiscoveryInput::with_contents("https://viewer.test/#loaded", br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#)
                        .with_kind(dezoomify::model::DiscoveryInputKind::ObservedMetadata)]
                })
            }
        },
    )).unwrap();
    assert_eq!(support::ready_image(catalog).format, "deepzoom");
    assert_eq!(
        *observations.borrow(),
        [Interaction::Forbidden, Interaction::Allowed]
    );
}

#[test]
fn a_new_source_session_can_make_an_already_rejected_metadata_url_readable() {
    const URL: &str = "https://viewer.test/file.dzi";
    let granted = Cell::new(false);
    let reads = Cell::new(0);
    let catalog = futures::executor::block_on(core::default_registry().discover(
        vec![DiscoveryInput::new(URL)],
        Default::default(),
        |_, _| {
            reads.set(reads.get() + 1);
            let body = if granted.get() {
                r#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#
            } else { "<html>Sign in</html>" };
            async move { Ok(response(body)) }
        },
        support::parse_html,
        |interaction| {
            let inputs = if interaction == Interaction::Allowed && !granted.replace(true) {
                vec![DiscoveryInput::new(URL).with_kind(dezoomify::model::DiscoveryInputKind::ObservedResource)]
            } else { Vec::new() };
            async { Ok(inputs) }
        },
    )).unwrap();
    assert_eq!(support::ready_image(catalog).format, "deepzoom");
    assert_eq!(reads.get(), 2);
}

#[test]
fn additional_rendered_documents_replace_inert_reads_and_continue_recursive_discovery() {
    use dezoomify::model::DiscoveryInputKind;
    const DZI: &str = "<Image TileSize=\"256\" Overlap=\"0\" Format=\"jpg\"><Size Width=\"512\" Height=\"512\"/></Image>";
    let reads = RefCell::new(Vec::new());
    let observations = RefCell::new(Vec::new());
    let rendered = Cell::new(false);
    let catalog = futures::executor::block_on(core::default_registry().discover(
        vec![DiscoveryInput::with_contents("https://test/root", br#"<iframe src="/frame"></iframe>"#)],
        Default::default(),
        |request, interaction| {
            assert_eq!(interaction, Interaction::Forbidden);
            reads.borrow_mut().push(request.uri);
            async { Ok(response("<html><head><title>Jarvis DZI viewer</title><link href='style.css'></head></html>")) }
        },
        support::parse_html,
        |interaction| {
            observations.borrow_mut().push(interaction);
            let inputs = if interaction == Interaction::Allowed {
                vec![DiscoveryInput::with_contents("https://test/nested#loaded", DZI)
                    .with_kind(DiscoveryInputKind::ObservedMetadata)]
            } else if !rendered.replace(true) {
                vec![DiscoveryInput::with_contents("https://test/frame", br#"<iframe src="/nested"></iframe>"#)
                    .with_kind(DiscoveryInputKind::ObservedDocument)]
            } else {
                Vec::new()
            };
            async { Ok(inputs) }
        },
    )).unwrap();
    assert_eq!(support::ready_image(catalog).format, "deepzoom");
    assert_eq!(
        *reads.borrow(),
        ["https://test/frame", "https://test/nested"]
    );
    assert_eq!(
        *observations.borrow(),
        [
            Interaction::Forbidden,
            Interaction::Forbidden,
            Interaction::Allowed
        ]
    );
}
#[test]
fn deferred_access_runs_after_every_runnable_branch_and_reuses_its_resource() {
    let calls = RefCell::new(Vec::new());
    let registry = registry();
    let catalog = futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        Default::default(),
        |request, interaction| {
            calls.borrow_mut().push((request.uri.clone(), interaction));
            async move {
                if request.uri.ends_with("/b") {
                    return Err(Error::DiscoveryFailed {
                        failure: "unavailable".to_string().into(),
                        cause: None,
                    });
                }
                Ok(if interaction == Interaction::Forbidden {
                    ResourceRead::NeedsAccess {
                        origin: "https://test".into(),
                    }
                } else {
                    response("authorized")
                })
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert_eq!(selected(catalog), "authorized");
    assert_eq!(
        *calls.borrow(),
        [
            ("https://test/a".into(), Interaction::Forbidden),
            ("https://test/b".into(), Interaction::Forbidden),
            ("https://test/a".into(), Interaction::Allowed)
        ]
    );
}
fn branch(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    if resource.context().resources().next().is_none() {
        return Ok(ParsedResource::FollowWith(
            Request::new("https://test/child").with_header("X-Image", "kept"),
            branch,
        ));
    }
    assert!(resource.context().has_visited("https://redirect.test/root"));
    assert_eq!(
        resource.context().resources().next().unwrap().bytes(),
        b"root"
    );
    assert_eq!(resource.final_uri(), "https://redirect.test/child");
    catalog(resource)
}
#[test]
fn shared_reads_keep_branch_history_headers_and_redirected_bases() {
    const A: FormatSpec = FormatSpec::new("first", &[viewer(url_suffix("/root")).decode(branch)]);
    const B: FormatSpec = FormatSpec::new("second", &[viewer(url_suffix("/root")).decode(branch)]);
    let mut registry = core::Registry::new();
    registry.register(A);
    registry.register(B);
    let calls = RefCell::new(Vec::new());
    let catalog = futures::executor::block_on(registry.discover(
        vec![
            DiscoveryInput::new("https://test/root"),
            DiscoveryInput::with_contents("https://test/child", b"stale child")
                .with_kind(dezoomify::model::DiscoveryInputKind::ObservedDocument),
        ],
        Default::default(),
        |request, _| {
            calls.borrow_mut().push(request.clone());
            async move {
                if request.uri.ends_with("/root") {
                    Ok(ResourceRead::Response {
                        response: ResourceResponse {
                            bytes: b"root".to_vec(),
                            final_uri: Some("https://redirect.test/root".into()),
                        },
                    })
                } else {
                    assert_eq!(request.header("X-Image"), Some("kept"));
                    Ok(ResourceRead::Response {
                        response: ResourceResponse {
                            bytes: b"child".to_vec(),
                            final_uri: Some("https://redirect.test/child".into()),
                        },
                    })
                }
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert_eq!(selected(catalog), "child");
    assert_eq!(calls.borrow().len(), 2);
}
#[test]
fn live_resource_concurrency_stays_within_the_declared_bound() {
    let active = Rc::new(Cell::new(0));
    let peak = Rc::new(Cell::new(0));
    const THIRD: FormatSpec = FormatSpec::new(
        "third",
        &[viewer(url_suffix("/root"))
            .resolve_metadata(|_| Ok(Request::new("https://test/c")))
            .then_decode(catalog)],
    );
    let mut registry = registry();
    registry.register(THIRD);
    futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new("https://test/root")],
        DiscoveryLimits {
            concurrent: 2,
            ..Default::default()
        },
        |request, _| {
            let active = active.clone();
            let peak = peak.clone();
            async move {
                active.set(active.get() + 1);
                peak.set(peak.get().max(active.get()));
                let mut yielded = false;
                futures::future::poll_fn(|cx| {
                    if yielded {
                        Poll::Ready(())
                    } else {
                        yielded = true;
                        cx.waker().wake_by_ref();
                        Poll::Pending
                    }
                })
                .await;
                active.set(active.get() - 1);
                Ok(response(&request.uri))
            }
        },
        support::parse_html,
        |_| async { Ok(Vec::new()) },
    ))
    .unwrap();
    assert!(peak.get() <= 2);
}

#[test]
fn rejected_candidates_retain_host_failure_facts() {
    use dezoomify::model::{ErrorTransport, Failure, ResourceKind};
    for transport in [ErrorTransport::Native, ErrorTransport::DisplayOnly] {
        // The exact structured facts a host observed survive the discovery
        // layer unchanged: no field is stripped or flattened away.
        let failure = Error::HttpError {
            status: 429,
            retry_after_ms: Some(9000),
            preview: Some("original response".into()),
            transport,
            failure: Failure {
                request: Some("https://redirected.test/metadata?access=exact".into()),
                detail: Some("original explanation".into()),
            },
        }
        .resource("https://test/root", ResourceKind::Metadata);
        let registry = registry();
        let error = futures::executor::block_on(registry.discover(
            vec![DiscoveryInput::new("https://test/root")],
            Default::default(),
            |_, _| futures::future::ready(Err(failure.clone())),
            support::parse_html,
            |_| async { Ok(Vec::new()) },
        ))
        .unwrap_err();
        let DiscoveryError::NoCandidateAccepted { diagnostics } = error else {
            panic!("expected candidate diagnostics")
        };
        let failures: Vec<_> = diagnostics
            .iter()
            .filter_map(|entry| entry.cause.as_deref())
            .collect();
        assert!(!failures.is_empty());
        assert!(failures.into_iter().all(|cause| cause == &failure));
    }
}
