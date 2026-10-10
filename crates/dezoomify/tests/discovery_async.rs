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
        .then_decode(catalog)
        .canonical_target()],
);
const SECOND: FormatSpec = FormatSpec::new(
    "second",
    &[viewer(url_suffix("/root"))
        .resolve_metadata(|_| Ok(Request::new("https://test/b")))
        .then_decode(catalog)
        .canonical_target()],
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
fn a_context_dependent_decoder_can_designate_its_page_instead_of_its_last_fetch() {
    fn page(_: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        Ok(ParsedResource::FollowWith(
            Request::new("https://test/auxiliary"),
            contextual_image,
        ))
    }
    fn contextual_image(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        assert_eq!(
            resource.context().resources().next().unwrap().uri(),
            "https://test/root"
        );
        catalog(resource)
    }
    const ROUTE: core::DiscoveryRoute = viewer(url_suffix("/root")).decode(page);
    const UNMARKED: FormatSpec = FormatSpec::new("context", &[ROUTE]);
    const MARKED: FormatSpec = FormatSpec::new("context", &[ROUTE.canonical_source()]);
    for marked in [false, true] {
        let mut registry = core::Registry::new();
        registry.register(if marked { MARKED } else { UNMARKED });
        let result = futures::executor::block_on(registry.discover(
            vec![DiscoveryInput::new("https://test/root")],
            Default::default(),
            |_, _| async { Ok(response("image")) },
            support::parse_html,
        ))
        .unwrap();
        let [DiscoveredEntry::Ready(image)] = result.entries() else {
            panic!("ready image")
        };
        assert_eq!(
            image.source_url.as_deref(),
            marked.then_some("https://test/root")
        );
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
            .then_decode(rejected)
            .canonical_target()],
    );
    const UNMARKED: FormatSpec = FormatSpec::new(
        "unmarked",
        &[viewer(url_suffix("/root"))
            .resolve_metadata(|_| Ok(Request::new("https://test/b")))
            .then_decode(catalog)],
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
