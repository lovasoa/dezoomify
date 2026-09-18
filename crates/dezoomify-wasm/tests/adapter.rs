//! Typed session boundary tests. These exercise the Rust methods exported
//! through `Ts<JobCommand>`/`Ts<DispatchResult>` by wasm-bindgen.

use dezoomify_protocol::dto::{
    BlockedReason, BufferHandle, ErrorPhase, ErrorTransport, FetchFailureDto, HostEffect,
    HostMessage, JobCommand, JobEvent, JobInputDto, RecoveryChoice, SessionConfig,
};
use dezoomify_wasm::{AdapterErrorCode, Session, SessionState};
use std::num::NonZeroUsize;

fn session() -> Session {
    Session::new(SessionConfig::default()).expect("typed session")
}

fn start(session: &mut Session) -> Vec<HostMessage> {
    session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .expect("typed start")
}

#[test]
fn start_returns_typed_events_and_effects_directly() {
    let messages = start(&mut session());
    assert!(matches!(
        messages.first(),
        Some(HostMessage::Event(JobEvent::JobState { .. }))
    ));
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostMessage::Effect(_))));
}

#[test]
fn typed_fetch_error_requires_and_preserves_context() {
    let mut session = session();
    let messages = start(&mut session);
    let request = messages
        .iter()
        .find_map(|message| match message {
            HostMessage::Effect(dezoomify_protocol::dto::HostEffect::AcquireResource {
                request,
            }) => Some(request.id),
            _ => None,
        })
        .expect("discovery request");
    let error = FetchFailureDto {
        code: "PROXY_ERROR".into(),
        retryable: true,
        message: "The metadata proxy failed.".into(),
        recovery: Vec::new(),
        transport: ErrorTransport::MetadataProxy,
        blocked_reason: Some(BlockedReason::Network),
        http: Some(502),
        preview: None,
        detail: None,
    };
    let messages = session
        .dispatch(JobCommand::ProvideFetchFailure { request, error })
        .expect("typed failure accepted");
    let failed = messages.iter().find_map(|message| match message {
        HostMessage::Event(JobEvent::Failed { error }) => Some(error),
        _ => None,
    });
    let failed = failed.expect("terminal failure");
    assert_eq!(failed.code, "PROXY_ERROR");
    assert_eq!(failed.phase, ErrorPhase::Discovery);
    assert_eq!(failed.transport, Some(ErrorTransport::MetadataProxy));
    assert_eq!(failed.http, Some(502));
}

#[test]
fn typed_config_and_handles_enforce_limits_and_generation() {
    let mut session = Session::new(SessionConfig {
        max_buffer_bytes: std::num::NonZeroU64::new(4),
        ..SessionConfig::default()
    })
    .expect("bounded session");
    assert_eq!(
        session.allocate_buffer(5).unwrap_err().code(),
        AdapterErrorCode::LimitExceeded
    );
    let handle = session.allocate_buffer(4).expect("allocate");
    session
        .write_buffer(handle, 0, &[1, 2, 3, 4])
        .expect("write");
    session.commit_buffer(handle, 4).expect("commit");
    assert_eq!(session.take_buffer(handle).expect("take"), vec![1, 2, 3, 4]);
}

#[test]
fn dispose_returns_typed_cancellation_once() {
    let mut session = session();
    start(&mut session);
    let messages = session.dispose().expect("dispose");
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Cancelled))));
    assert!(session.dispose().expect("repeat dispose").is_empty());
}

const TILE_DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const GENERIC_PROBE_TEMPLATE: &str = "https://example.test/generic/placeholder.svg?x={{X}}&y={{Y}}";

fn tile_fetch_failure() -> FetchFailureDto {
    FetchFailureDto {
        code: "TILE_FAILED".into(),
        retryable: false,
        message: "The tile could not be fetched.".into(),
        recovery: Vec::new(),
        transport: ErrorTransport::BrowserSession,
        blocked_reason: None,
        http: None,
        preview: None,
        detail: None,
    }
}

fn commit_host_bytes(session: &mut Session, bytes: &[u8]) -> BufferHandle {
    let length = u64::try_from(bytes.len()).expect("fixture bytes fit");
    let handle = session.allocate_buffer(length).expect("allocate fixture");
    session
        .write_buffer(handle, 0, bytes)
        .expect("write fixture");
    session
        .commit_buffer(handle, length)
        .expect("commit fixture");
    session
        .buffer_handle(handle)
        .expect("fixture buffer handle")
}

fn acquire_tile_requests(messages: &[HostMessage]) -> Vec<u32> {
    messages
        .iter()
        .filter_map(|message| match message {
            HostMessage::Effect(HostEffect::AcquireTile { request, .. }) => Some(request.id),
            _ => None,
        })
        .collect()
}

fn start_four_tile_grid(session: &mut Session) -> Vec<u32> {
    let messages = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto {
                url: "https://example.com/image.dzi".to_string(),
                contents: Some(TILE_DZI.to_string()),
            }],
        })
        .expect("inline discovery");
    let catalog = messages
        .iter()
        .find_map(|message| match message {
            HostMessage::Event(JobEvent::Catalog { catalog }) => Some(catalog),
            _ => None,
        })
        .expect("inline catalog");
    let level_count = catalog
        .images
        .first()
        .map(|image| image.levels.len())
        .unwrap_or(0);
    assert!(level_count >= 2, "fixture grid must expose levels");
    session
        .dispatch(JobCommand::SelectImage { image: 0 })
        .expect("select image");
    let level = u32::try_from(level_count - 1).expect("level position fits");
    let messages = session
        .dispatch(JobCommand::SelectLevel { level })
        .expect("select level");
    assert_eq!(session.state(), SessionState::AcquiringTiles);
    let requests = acquire_tile_requests(&messages);
    assert_eq!(requests.len(), 4, "largest fixture level has four tiles");
    requests
}

#[test]
fn late_tile_responses_after_partial_decision_are_processed() {
    // A sibling's retry exhaustion can move the engine to
    // AwaitingPartialDecision while other in-flight fetches are still out.
    // The adapter forwards those late answers (the engine owns acceptance):
    // successes are counted, an exhausted failure is recorded in the open
    // decision without re-opening it, and the arena slot is released.
    let mut session = Session::new(SessionConfig {
        max_retries: Some(0),
        max_buffers: NonZeroUsize::new(1),
        ..SessionConfig::default()
    })
    .expect("bounded retry session");
    let requests = start_four_tile_grid(&mut session);

    let failed = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: requests[0],
            error: tile_fetch_failure(),
        })
        .expect("first-attempt tile failure");
    assert!(failed
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Warning { .. }))));
    assert_eq!(session.state(), SessionState::AwaitingPartialDecision);

    let late_buffer = commit_host_bytes(&mut session, b"late-tile-bytes");
    let late_resource = session
        .dispatch(JobCommand::ProvideResource {
            request: requests[1],
            buffer: late_buffer,
            final_uri: None,
        })
        .expect("late tile bytes are forwarded");
    assert!(late_resource.iter().any(|message| matches!(
        message,
        HostMessage::Event(JobEvent::Progress {
            acquired: 1,
            total: 4
        })
    )));
    assert_eq!(session.state(), SessionState::AwaitingPartialDecision);
    let released = session
        .allocate_buffer(8)
        .expect("late tile bytes must be released");
    session
        .free_buffer(released)
        .expect("release probe allocation");

    let late_failure = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: requests[2],
            error: tile_fetch_failure(),
        })
        .expect("late tile failure is forwarded");
    assert!(late_failure
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Warning { .. }))));
    assert!(
        !late_failure.iter().any(|message| matches!(
            message,
            HostMessage::Effect(HostEffect::RequestDecision { .. })
        )),
        "an open decision must not be re-opened"
    );
    assert_eq!(session.state(), SessionState::AwaitingPartialDecision);

    let late_display = session
        .dispatch(JobCommand::ProvideDisplayOutcome {
            request: requests[3],
        })
        .expect("late display outcome is forwarded");
    assert!(late_display.iter().any(|message| matches!(
        message,
        HostMessage::Event(JobEvent::Progress {
            acquired: 2,
            total: 4
        })
    )));

    let decision = session
        .dispatch(JobCommand::RecoveryChoice {
            generation: 0,
            choice: RecoveryChoice::Keep,
        })
        .expect("partial keep stays reachable");
    assert!(decision.iter().any(|message| matches!(
        message,
        HostMessage::Effect(HostEffect::FinalizeOutput { partial: true, .. })
    )));
    let completed = session
        .dispatch(JobCommand::FinalizationSucceeded)
        .expect("finalize kept partial");
    assert!(completed
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::PartialCompleted))));
    assert_eq!(session.state(), SessionState::PartiallyCompleted);
}

#[test]
fn late_tile_responses_do_not_deadlock_a_retry_choice() {
    // The regression the phase-check workarounds caused: late in-flight
    // answers were dropped while the engine kept them in its in-flight set,
    // so a Retry choice could never re-emit them and the job stalled. With
    // engine-owned acceptance the late answers are processed, Retry
    // re-fetches the failed tiles, and the job completes in full.
    let mut session = Session::new(SessionConfig {
        max_retries: Some(0),
        ..SessionConfig::default()
    })
    .expect("bounded retry session");
    let requests = start_four_tile_grid(&mut session);

    session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: requests[0],
            error: tile_fetch_failure(),
        })
        .expect("first-attempt tile failure");
    let late_buffer = commit_host_bytes(&mut session, b"late-tile-bytes");
    session
        .dispatch(JobCommand::ProvideResource {
            request: requests[1],
            buffer: late_buffer,
            final_uri: None,
        })
        .expect("late tile bytes are forwarded");
    session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: requests[2],
            error: tile_fetch_failure(),
        })
        .expect("late tile failure is forwarded");
    assert_eq!(session.state(), SessionState::AwaitingPartialDecision);

    let retried = session
        .dispatch(JobCommand::RecoveryChoice {
            generation: 0,
            choice: RecoveryChoice::Retry,
        })
        .expect("retry stays reachable");
    assert_eq!(session.state(), SessionState::AcquiringTiles);
    let retry_requests = acquire_tile_requests(&retried);
    assert_eq!(retry_requests.len(), 2, "failed tiles are re-fetched");

    for retry in retry_requests {
        let buffer = commit_host_bytes(&mut session, b"retried-tile-bytes");
        session
            .dispatch(JobCommand::ProvideResource {
                request: retry,
                buffer,
                final_uri: None,
            })
            .expect("retried tile settles");
    }
    let settled = session
        .dispatch(JobCommand::ProvideDisplayOutcome {
            request: requests[3],
        })
        .expect("last outstanding sibling settles");
    assert!(settled.iter().any(|message| matches!(
        message,
        HostMessage::Effect(HostEffect::FinalizeOutput { partial: false, .. })
    )));
    let completed = session
        .dispatch(JobCommand::FinalizationSucceeded)
        .expect("finalize completed job");
    assert!(completed
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Completed))));
    assert_eq!(session.state(), SessionState::Completed);
}

#[test]
fn unknown_request_id_stays_a_typed_rejection() {
    // The adapter's request ledger is the canary: ids it never minted are
    // rejected, even after the job has left the phase the request named.
    let mut session = session();
    start(&mut session);
    let buffer = commit_host_bytes(&mut session, b"unclaimed-bytes");
    let err = session
        .dispatch(JobCommand::ProvideResource {
            request: 999,
            buffer,
            final_uri: None,
        })
        .expect_err("forged request id is rejected");
    assert_eq!(err.code(), AdapterErrorCode::WrongState);
}

#[test]
fn empty_tile_bytes_forward_a_failure_without_leaking_the_arena_slot() {
    let mut session = Session::new(SessionConfig {
        max_buffers: NonZeroUsize::new(1),
        ..SessionConfig::default()
    })
    .expect("single-slot session");
    let requests = start_four_tile_grid(&mut session);
    let empty = commit_host_bytes(&mut session, b"");
    let messages = session
        .dispatch(JobCommand::ProvideResource {
            request: requests[0],
            buffer: empty,
            final_uri: None,
        })
        .expect("empty tile bytes are a failed outcome");
    assert_eq!(session.state(), SessionState::AcquiringTiles);
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Warning { .. }))));
    session
        .allocate_buffer(1)
        .expect("empty tile bytes must be released");
}

#[test]
fn late_probe_failure_after_cancel_is_ignored() {
    let mut session = session();
    let started = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new(GENERIC_PROBE_TEMPLATE)],
        })
        .expect("start probe job");
    assert!(started
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Catalog { .. }))));
    session
        .dispatch(JobCommand::SelectImage { image: 0 })
        .expect("select probe image");
    let planned = session
        .dispatch(JobCommand::SelectLevel { level: 0 })
        .expect("start probe planning");
    assert_eq!(session.state(), SessionState::Planning);
    let probe = acquire_tile_requests(&planned)
        .into_iter()
        .next()
        .expect("outstanding probe");
    session
        .dispatch(JobCommand::Cancel)
        .expect("cancel planning");
    assert_eq!(session.state(), SessionState::Cancelled);
    let late = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: probe,
            error: tile_fetch_failure(),
        })
        .expect("cancelled probe failure is moot");
    assert!(late.is_empty());
}
