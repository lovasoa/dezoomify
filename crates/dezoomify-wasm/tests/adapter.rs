//! Typed session boundary tests. These exercise the Rust methods exported
//! through `Ts<JobCommand>`/`Ts<DispatchResult>` by wasm-bindgen.

use dezoomify_protocol::dto::{
    BlockedReason, ErrorPhase, ErrorTransport, FetchFailureDto, HostMessage, JobCommand, JobEvent,
    JobInputDto, SessionConfig,
};
use dezoomify_wasm::Session;

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
        retry_after_ms: None,
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
    start(&mut session);
    let messages = session.dispose().expect("dispose");
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Cancelled))));
    assert!(session.dispose().expect("repeat dispose").is_empty());
}

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The largest level is a real 2x2 grid.
const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn tile_failure(code: &str, http: Option<u16>) -> FetchFailureDto {
    FetchFailureDto {
        code: code.into(),
        retryable: false,
        message: format!("tile refused: {code}"),
        recovery: Vec::new(),
        transport: ErrorTransport::Direct,
        blocked_reason: None,
        http,
        retry_after_ms: None,
        preview: None,
        detail: None,
    }
}

/// Drive one session through discovery and selection of the largest level.
/// Returns the live session plus `(tile, request)` pairs in effect order.
fn session_acquiring_tiles() -> (Session, Vec<(u32, u32)>) {
    use dezoomify_protocol::dto::HostEffect;
    let mut session = session();
    let messages = session
        .dispatch(JobCommand::Start {
            inputs: vec![JobInputDto::new("https://example.com/image.dzi")],
        })
        .expect("typed start");
    let request = messages
        .iter()
        .find_map(|message| match message {
            HostMessage::Effect(HostEffect::AcquireResource { request }) => Some(request.id),
            _ => None,
        })
        .expect("discovery request");
    // Discovery bodies cross directly in the command; nothing is retained.
    let messages = session
        .dispatch(JobCommand::ProvideResource {
            request,
            bytes: DZI.to_vec(),
            final_uri: None,
        })
        .expect("metadata bytes");
    assert!(messages
        .iter()
        .any(|message| matches!(message, HostMessage::Event(JobEvent::Catalog { .. }))));
    session
        .dispatch(JobCommand::SelectImage { image: 0 })
        .expect("image");
    // Levels ascend by size; the last position is the largest (2x2 grid).
    let levels = 10u32;
    let messages = session
        .dispatch(JobCommand::SelectLevel { level: levels - 1 })
        .expect("level");
    let mut tiles = Vec::new();
    for message in &messages {
        if let HostMessage::Effect(HostEffect::AcquireTile { request, tile, .. }) = message {
            tiles.push((*tile, request.id));
        }
    }
    assert_eq!(tiles.len(), 4, "largest DZI level is a 2x2 grid");
    (session, tiles)
}

#[test]
fn tile_403_failure_forwards_http_and_settles_after_single_attempt() {
    use dezoomify_protocol::dto::HostEffect;
    let (mut session, tiles) = session_acquiring_tiles();
    // A 403 refusal on the first tile: the bridge forwards the observed
    // HTTP status into a typed engine failure, so the tile settles after
    // exactly one attempt with no re-acquisition.
    let messages = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request: tiles[0].1,
            error: tile_failure("TRANSPORT_HTTP_ERROR", Some(403)),
        })
        .expect("403 accepted");
    let reacquired = messages.iter().filter(|message| match message {
        HostMessage::Effect(HostEffect::AcquireTile { tile, .. }) => *tile == tiles[0].0,
        _ => false,
    });
    assert_eq!(reacquired.count(), 0, "403 must not be retried");
    // Siblings still complete (display-only: body-free acknowledgements)
    // and only then does the partial decision arrive carrying the refusal.
    let mut decided = false;
    for (_, request) in tiles.iter().skip(1) {
        let messages = session
            .dispatch(JobCommand::ProvideDisplayOutcome { request: *request })
            .expect("display outcome");
        decided |= messages.iter().any(|message| {
            matches!(
                message,
                HostMessage::Effect(HostEffect::RequestDecision { .. })
            )
        });
    }
    assert!(
        decided,
        "settle-first partial decision after siblings complete"
    );
    let messages = session
        .dispatch(JobCommand::ProvideDisplayOutcome {
            request: tiles[0].1,
        })
        .unwrap_err();
    // The 403 request is already settled: a duplicate completion is a
    // wrong-state rejection, never a second attempt.
    assert_eq!(
        messages.code(),
        dezoomify_wasm::AdapterErrorCode::WrongState
    );
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

fn timer_of(messages: &[HostMessage]) -> Option<(u32, u32, u64)> {
    use dezoomify_protocol::dto::HostEffect;
    messages.iter().find_map(|message| match message {
        HostMessage::Effect(HostEffect::WaitRetryTimer {
            tile,
            attempt,
            delay_ms,
        }) => Some((*tile, *attempt, *delay_ms)),
        _ => None,
    })
}

fn reacquired_request(messages: &[HostMessage], tile: u32) -> Option<u32> {
    use dezoomify_protocol::dto::HostEffect;
    messages.iter().find_map(|message| match message {
        HostMessage::Effect(HostEffect::AcquireTile {
            request, tile: id, ..
        }) if *id == tile => Some(request.id),
        _ => None,
    })
}

#[test]
fn transient_failure_waits_then_retries_with_backoff() {
    let (mut session, tiles) = session_acquiring_tiles();
    let (tile, mut request) = tiles[0];

    // Attempt 1 fails transiently: one explicit wait, no re-acquisition yet.
    let messages = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request,
            error: transient_timeout(),
        })
        .expect("transient failure accepted");
    assert_eq!(timer_of(&messages), Some((tile, 1, 1_000)));
    assert_eq!(reacquired_request(&messages, tile), None);

    // The host waits, then answers the timer: exactly one re-acquisition.
    let messages = session
        .dispatch(JobCommand::RetryTimerElapsed { tile, attempt: 1 })
        .expect("timer elapsed");
    request = reacquired_request(&messages, tile).expect("second attempt issued");

    // Attempt 2 fails: backoff doubles to 2s.
    let messages = session
        .dispatch(JobCommand::ProvideFetchFailure {
            request,
            error: transient_timeout(),
        })
        .expect("second failure accepted");
    assert_eq!(timer_of(&messages), Some((tile, 2, 2_000)));

    // A stale timer completion (unknown attempt) settles nothing.
    let messages = session
        .dispatch(JobCommand::RetryTimerElapsed { tile, attempt: 9 })
        .expect("stale timer tolerated");
    assert!(messages.is_empty());
}

#[test]
fn retry_after_hint_sets_the_explicit_wait() {
    let (mut session, tiles) = session_acquiring_tiles();
    let (tile, request) = tiles[0];
    let mut error = transient_timeout();
    error.code = "TRANSPORT_HTTP_ERROR".into();
    error.http = Some(503);
    error.retry_after_ms = Some(5_000);
    let messages = session
        .dispatch(JobCommand::ProvideFetchFailure { request, error })
        .expect("503 with retry-after accepted");
    assert_eq!(timer_of(&messages), Some((tile, 1, 5_000)));
}

#[test]
fn ordinary_tile_ack_carries_no_body_bytes() {
    use dezoomify_protocol::dto::HostEffect;
    let (mut session, tiles) = session_acquiring_tiles();
    // Ordinary image display: the host holds `<img>` elements with no
    // readable bytes, so tile acknowledgements are body-free.
    let mut message_count = 0;
    let mut finalized = false;
    for (_, request) in &tiles {
        let messages = session
            .dispatch(JobCommand::ProvideDisplayOutcome { request: *request })
            .expect("display outcome");
        message_count += messages.len();
        finalized |= messages.iter().any(|message| {
            matches!(
                message,
                HostMessage::Effect(HostEffect::FinalizeOutput { .. })
            )
        });
    }
    assert!(finalized, "display-only acquisition still finalizes");
    eprintln!("display-only completion: {message_count} host messages, 0 retained body bytes");
}

#[test]
fn display_only_tiles_complete_without_body_bytes() {
    use dezoomify_protocol::dto::HostEffect;
    let (mut session, tiles) = session_acquiring_tiles();
    // Ordinary image display: the host holds `<img>` elements with no
    // readable bytes, so tile acknowledgements are body-free.
    let mut finalized = false;
    for (_, request) in &tiles {
        let messages = session
            .dispatch(JobCommand::ProvideDisplayOutcome { request: *request })
            .expect("display outcome");
        finalized |= messages.iter().any(|message| {
            matches!(
                message,
                HostMessage::Effect(HostEffect::FinalizeOutput { .. })
            )
        });
    }
    assert!(finalized, "display-only acquisition still finalizes");
}

#[test]
fn acquired_tiles_complete_without_body_bytes() {
    use dezoomify_protocol::dto::HostEffect;
    let (mut session, tiles) = session_acquiring_tiles();
    // Readable acquisition: the host fetched, decoded, and placed each
    // tile, so the acknowledgment carries no body, only the typed outcome.
    let mut finalized = false;
    for (_, request) in &tiles {
        let messages = session
            .dispatch(JobCommand::TileAcquired { request: *request })
            .expect("acquired outcome");
        finalized |= messages.iter().any(|message| {
            matches!(
                message,
                HostMessage::Effect(HostEffect::FinalizeOutput { .. })
            )
        });
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
