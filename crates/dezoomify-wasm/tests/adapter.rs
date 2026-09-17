//! Typed session boundary tests. These exercise the Rust methods exported
//! through `Ts<JobCommand>`/`Ts<DispatchResult>` by wasm-bindgen.

use dezoomify_protocol::dto::{
    BlockedReason, ErrorDto, ErrorPhase, ErrorTransport, HostMessage, JobCommand, JobEvent,
    JobInputDto, SessionConfig,
};
use dezoomify_wasm::{AdapterErrorCode, Session};

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
    let mut error = ErrorDto::new(
        "PROXY_ERROR",
        ErrorPhase::Discovery,
        "The metadata proxy failed.",
    );
    error.retryable = true;
    error.transport = Some(ErrorTransport::MetadataProxy);
    error.http = Some(502);
    error.blocked_reason = Some(BlockedReason::Network);
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
        max_buffer_bytes: Some(4),
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
