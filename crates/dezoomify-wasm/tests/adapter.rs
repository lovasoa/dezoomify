//! Typed session boundary tests: start, validation, completion, and one
//! retry round-trip. Exact timer vectors live in E2E, not here.

use dezoomify_protocol::dto::{
    BlockedReason, ErrorPhase, ErrorTransport, FetchFailureDto, HostEffect, JobCommand,
    JobInputDto, SessionConfig,
};
use dezoomify_wasm::Session;

fn session() -> Session {
    Session::new(SessionConfig::default()).expect("typed session")
}

fn start(session: &mut Session) -> (Vec<HostEffect>, dezoomify_protocol::dto::EngineSnapshotDto) {
    session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .expect("typed start")
}

/// Start and keep the messages only; the snapshot travels separately.
fn start_messages(session: &mut Session) -> Vec<HostEffect> {
    start(session).0
}

#[test]
fn start_returns_effects_with_a_discovering_snapshot() {
    let (messages, snapshot) = start(&mut session());
    assert_eq!(
        snapshot.lifecycle,
        dezoomify_protocol::dto::JobState::Discovering
    );
    assert!(snapshot.terminal.is_none());
    assert!(!messages.is_empty());
    assert!(messages.iter().all(|message| matches!(
        message,
        HostEffect::AcquireResource { .. }
            | HostEffect::AcquireTile { .. }
            | HostEffect::WaitRetryTimer { .. }
            | HostEffect::FinalizeOutput { .. }
            | HostEffect::CancelWork
            | HostEffect::RequestDecision { .. }
    )));
}

#[test]
fn typed_fetch_error_requires_and_preserves_context() {
    let mut session = session();
    let messages = start_messages(&mut session);
    let request = messages
        .iter()
        .find_map(|message| match message {
            HostEffect::AcquireResource { request } => Some(request.id),
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
        retry_after_ms: None,
        preview: None,
        detail: None,
    };
    let (messages, snapshot) = session
        .dispatch(JobCommand::ProvideFetchFailure { request, error })
        .expect("typed failure accepted");
    assert!(messages.is_empty(), "terminal answers carry no new effects");
    let failed = match snapshot.terminal {
        Some(dezoomify_protocol::dto::SnapshotTerminalDto::Failed { error }) => error,
        ref terminal => panic!("expected failed terminal, got {terminal:?}"),
    };
    assert_eq!(failed.code, "PROXY_ERROR");
    assert_eq!(failed.phase, ErrorPhase::Discovery);
    assert_eq!(failed.transport, Some(ErrorTransport::MetadataProxy));
    assert_eq!(failed.http, Some(502));
}

#[test]
fn typed_config_budgets_are_validated_by_the_engine() {
    let mut session = Session::new(SessionConfig {
        max_tiles: std::num::NonZeroU32::new(u32::MAX),
        ..SessionConfig::default()
    })
    .expect("construction defers budget validation to the engine");
    let error = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .unwrap_err();
    assert_eq!(
        error.code(),
        dezoomify_wasm::AdapterErrorCode::LimitExceeded
    );
}

#[test]
fn dispose_returns_typed_cancellation_once() {
    let mut session = session();
    start_messages(&mut session);
    let (messages, snapshot) = session.dispose().expect("dispose");
    assert!(messages.iter().all(|message| matches!(
        message,
        HostEffect::AcquireResource { .. }
            | HostEffect::AcquireTile { .. }
            | HostEffect::WaitRetryTimer { .. }
            | HostEffect::FinalizeOutput { .. }
            | HostEffect::CancelWork
            | HostEffect::RequestDecision { .. }
    )));
    assert_eq!(
        snapshot.terminal,
        Some(dezoomify_protocol::dto::SnapshotTerminalDto::Cancelled)
    );
    let (repeat_messages, _repeat_snapshot) = session.dispose().expect("repeat dispose");
    assert!(repeat_messages.is_empty());
}

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The largest level is a real 2x2 grid.
const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

/// Drive one session through discovery and selection of the largest level.
/// Returns the live session plus `(tile, request)` pairs in effect order.
fn session_acquiring_tiles() -> (Session, Vec<(u32, u32)>) {
    let mut session = session();
    let (messages, _snapshot) = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .expect("typed start");
    let request = messages
        .iter()
        .find_map(|message| match message {
            HostEffect::AcquireResource { request } => Some(request.id),
            _ => None,
        })
        .expect("discovery request");
    // Discovery bodies cross directly in the command; nothing is retained.
    let (_messages, _snapshot) = session
        .dispatch(JobCommand::ProvideResource {
            request,
            bytes: DZI.to_vec(),
            final_uri: None,
        })
        .expect("metadata bytes");
    assert!(
        _snapshot.selection.catalog.is_some(),
        "metadata resolves a kept catalog"
    );
    session
        .dispatch(JobCommand::SelectImage { image: 0 })
        .expect("image");
    // Levels ascend by size; the last position is the largest (2x2 grid).
    let levels = 10u32;
    let (messages, _snapshot) = session
        .dispatch(JobCommand::SelectLevel { level: levels - 1 })
        .expect("level");
    let mut tiles = Vec::new();
    for message in &messages {
        if let HostEffect::AcquireTile { request, tile, .. } = message {
            tiles.push((*tile, request.id));
        }
    }
    assert_eq!(tiles.len(), 4, "largest DZI level is a 2x2 grid");
    (session, tiles)
}

fn transient_timeout() -> FetchFailureDto {
    FetchFailureDto {
        code: "TRANSPORT_TIMEOUT".into(),
        retryable: true,
        message: "tile fetch timed out".into(),
        recovery: Vec::new(),
        transport: ErrorTransport::Direct,
        blocked_reason: None,
        http: None,
        retry_after_ms: None,
        preview: None,
        detail: None,
    }
}

fn timer_of(messages: &[HostEffect]) -> Option<(u32, u32, u64)> {
    messages.iter().find_map(|message| match message {
        HostEffect::WaitRetryTimer {
            tile,
            attempt,
            delay_ms,
        } => Some((*tile, *attempt, *delay_ms)),
        _ => None,
    })
}

fn reacquired_request(messages: &[HostEffect], tile: u32) -> Option<u32> {
    messages.iter().find_map(|message| match message {
        HostEffect::AcquireTile {
            request, tile: id, ..
        } if *id == tile => Some(request.id),
        _ => None,
    })
}

#[test]
fn transient_failure_eventually_succeeds_after_host_wait() {
    let (mut session, tiles) = session_acquiring_tiles();
    let (tile, mut request) = tiles[0];

    // Attempt 1 fails transiently: the engine issues an explicit wait.
    let (messages, _snapshot) = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request,
            error: transient_timeout(),
        })
        .expect("transient failure accepted");
    let wait = timer_of(&messages).expect("retry wait issued");
    assert_eq!((wait.0, wait.1), (tile, 1));
    assert!(wait.2 > 0);
    assert_eq!(reacquired_request(&messages, tile), None);

    // The host waits, then answers the timer: the retry succeeds.
    let (messages, _snapshot) = session
        .dispatch(JobCommand::RetryTimerElapsed { tile, attempt: 1 })
        .expect("timer elapsed");
    request = reacquired_request(&messages, tile).expect("second attempt issued");

    // The retried tile plus its siblings complete the acquisition.
    let (mut messages, _snapshot) = session
        .dispatch(JobCommand::TileAcquired { request })
        .expect("retry acquired");
    for (_, sibling) in tiles.iter().skip(1) {
        let (next, _snapshot) = session
            .dispatch(JobCommand::TileAcquired { request: *sibling })
            .expect("sibling acquired");
        messages = next;
    }
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostEffect::FinalizeOutput { .. })));
}

#[test]
fn acquired_tiles_complete_without_body_bytes() {
    let (mut session, tiles) = session_acquiring_tiles();
    // Readable acquisition: the host fetched, decoded, and placed each
    // tile, so the acknowledgment carries no body, only the typed outcome.
    let mut finalized = false;
    for (_, request) in &tiles {
        let (messages, _snapshot) = session
            .dispatch(JobCommand::TileAcquired { request: *request })
            .expect("acquired outcome");
        finalized |= messages
            .iter()
            .any(|message| matches!(message, HostEffect::FinalizeOutput { .. }));
    }
    assert!(finalized, "readable acquisition finalizes");
}

#[test]
fn provide_resource_for_tile_request_is_rejected() {
    let (mut session, tiles) = session_acquiring_tiles();
    let (_, request) = tiles[0];
    // Tile bytes never enter the adapter: tile requests are answered with
    // acquired/display outcomes or fetch failures, never provide-resource.
    let error = session
        .dispatch(JobCommand::ProvideResource {
            request,
            bytes: vec![1, 2, 3, 4],
            final_uri: None,
        })
        .unwrap_err();
    assert_eq!(error.code(), dezoomify_wasm::AdapterErrorCode::WrongState);
}
