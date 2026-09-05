//! Phase-07 adapter conformance: buffer lifecycle, dispatch, drain,
//! processing, isolation, disposal, redaction, and the `P07-WORKFLOWS`
//! transcript golden (`testdata/scenarios/wasm/replay/expected/wasm.json`).
//!
//! Representation note: [`Session`] delegates its lifecycle to
//! `dezoomify-job`; the golden pins the delegated basic-success transcript —
//! canonical `ControlEnvelope` messages projected from engine effects and
//! events in engine `seq` order. Engine resources beyond the lean model are
//! engine limits, not adapter limits. Empty buffers and mismatched request
//! IDs fail or are rejected without fabricating success (see negative tests).

use dezoomify_protocol::codec;
use dezoomify_protocol::dto::{
    ControlBody, ControlEnvelope, ErrorDto, ErrorPhase, HostEffect, JobCommand, JobEvent,
    RequestPurpose,
};
use dezoomify_wasm::{
    protocol_version, AdapterErrorCode, ArenaHandle, CropGeometry, Session, PROCESSING_OPERATION,
};

const JOB_A: &str = "job:wasm-basic-1";
/// Golden transcript, anchored to the crate manifest so the test passes
/// regardless of the cargo invocation directory.
const GOLDEN_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/scenarios/wasm/replay/expected/wasm.json"
);

fn new_session() -> Session {
    Session::new("1.0", "{}").expect("default session constructs")
}

fn envelope_bytes(body: ControlBody) -> Vec<u8> {
    let envelope = ControlEnvelope::new(body).expect("envelope constructs");
    codec::encode(&envelope).expect("envelope encodes")
}

fn start_bytes(job: &str) -> Vec<u8> {
    envelope_bytes(ControlBody::Command(JobCommand::Start {
        job: job.parse().expect("job id"),
        input_url: "https://example.com/item/1".to_string(),
    }))
}

fn cancel_bytes(job: &str) -> Vec<u8> {
    envelope_bytes(ControlBody::Command(JobCommand::Cancel {
        job: job.parse().expect("job id"),
    }))
}

fn provide_resource_bytes(
    session: &Session,
    job: &str,
    handle: ArenaHandle,
    request: &dezoomify_protocol::dto::RequestId,
) -> Vec<u8> {
    let buffer = session
        .protocol_handle(handle)
        .expect("live handle projects");
    envelope_bytes(ControlBody::Command(JobCommand::ProvideResource {
        job: job.parse().expect("job id"),
        request: request.clone(),
        buffer,
    }))
}

/// Extract the outstanding discovery request id from drained messages.
fn discovery_request(messages: &[Vec<u8>]) -> dezoomify_protocol::dto::RequestId {
    for envelope in decode_all(messages) {
        if let ControlBody::Effect(HostEffect::AcquireResource { request, .. }) = envelope.body {
            return request.id;
        }
    }
    panic!("no acquire-resource effect in transcript");
}

fn command_bytes(body: JobCommand) -> Vec<u8> {
    envelope_bytes(ControlBody::Command(body))
}

/// Commit `bytes` into the session arena and return the sealed handle.
fn seal(session: &mut Session, bytes: &[u8]) -> ArenaHandle {
    let length = u64::try_from(bytes.len()).expect("test bytes fit");
    let handle = session.allocate_buffer(length).expect("allocate");
    session.write_buffer(handle, 0, bytes).expect("write");
    session.commit_buffer(handle, length).expect("commit");
    handle
}

fn decode_all(messages: &[Vec<u8>]) -> Vec<ControlEnvelope> {
    messages
        .iter()
        .map(|bytes| {
            assert!(bytes.ends_with(b"\n"), "canonical messages end with LF");
            codec::decode(bytes).expect("drained message decodes")
        })
        .collect()
}

#[test]
fn version_export_and_constructor_gates() {
    assert_eq!(protocol_version(), "1.0");
    assert!(Session::new("1", "{}").is_ok());
    assert_eq!(
        Session::new("2.0", "{}").unwrap_err().code(),
        AdapterErrorCode::VersionUnsupported
    );
    assert_eq!(
        Session::new("1.0", "{oops}").unwrap_err().code(),
        AdapterErrorCode::Malformed
    );
    assert_eq!(
        Session::new("1.0", r#"{"max_buffer_bytes": 99999999999}"#)
            .unwrap_err()
            .code(),
        AdapterErrorCode::LimitExceeded
    );
}

#[test]
fn buffer_lifecycle_allocate_write_commit_take_free() {
    let mut session = new_session();
    let handle = seal(&mut session, b"tile-bytes");
    let reference = session.protocol_handle(handle).expect("projects");
    assert_eq!(reference.length, 10);
    assert!(reference.id.as_str().starts_with("buf:"));
    assert_eq!(reference.generation, handle.generation);
    let taken = session.take_buffer(handle).expect("exactly-once take");
    assert_eq!(taken, b"tile-bytes");
    // Double consume is a typed stale-buffer error, never a panic or alias.
    assert_eq!(
        session.take_buffer(handle).unwrap_err().code(),
        AdapterErrorCode::StaleBuffer
    );
    // Free is idempotent, including after consumption.
    session.free_buffer(handle).expect("free after take");
    session.free_buffer(handle).expect("double free");
}

#[test]
fn stale_handle_reuse_is_rejected() {
    let mut session = new_session();
    let first = seal(&mut session, b"01234567");
    session.free_buffer(first).expect("free");
    let second = session.allocate_buffer(4).expect("reuse slot");
    assert_eq!(second.id, first.id, "slot is recycled");
    assert_ne!(second.generation, first.generation, "generation bumps");
    for stale in [
        session.write_buffer(first, 0, b"stale"),
        session.commit_buffer(first, 4),
    ] {
        assert_eq!(stale.unwrap_err().code(), AdapterErrorCode::StaleBuffer);
    }
    assert_eq!(
        session.take_buffer(first).unwrap_err().code(),
        AdapterErrorCode::StaleBuffer
    );
    let forged = ArenaHandle {
        id: 4242,
        generation: 1,
    };
    assert_eq!(
        session.free_buffer(forged).unwrap_err().code(),
        AdapterErrorCode::StaleBuffer,
        "forged handles are rejected, never silently accepted"
    );
}

#[test]
fn buffer_limits_use_checked_arithmetic() {
    let mut session = new_session();
    assert_eq!(
        session.allocate_buffer(u64::MAX).unwrap_err().code(),
        AdapterErrorCode::LimitExceeded,
        "u64::MAX never panics or allocates"
    );
    assert_eq!(
        session.allocate_buffer((8 << 20) + 1).unwrap_err().code(),
        AdapterErrorCode::LimitExceeded,
        "per-buffer cap enforced"
    );
    let handle = session.allocate_buffer(8).expect("small alloc");
    session
        .write_buffer(handle, 0, b"01234567")
        .expect("full write");
    assert_eq!(
        session.write_buffer(handle, 7, b"xy").unwrap_err().code(),
        AdapterErrorCode::LimitExceeded,
        "overrunning write rejected"
    );
    assert_eq!(
        session.commit_buffer(handle, 9).unwrap_err().code(),
        AdapterErrorCode::LimitExceeded,
        "oversized commit rejected"
    );
    session.commit_buffer(handle, 8).expect("exact commit");
    assert_eq!(
        session.commit_buffer(handle, 8).unwrap_err().code(),
        AdapterErrorCode::WrongState,
        "double commit is wrong-state"
    );
    // Session-total quota is enforced before allocation.
    let mut tight = Session::new("1.0", r#"{"max_total_bytes": 16}"#).expect("tight quotas");
    tight.allocate_buffer(16).expect("fills quota");
    assert_eq!(
        tight.allocate_buffer(1).unwrap_err().code(),
        AdapterErrorCode::LimitExceeded
    );
}

#[test]
fn dispatch_rejects_malformed_and_wrong_versions_atomically() {
    let mut session = new_session();
    assert_eq!(
        session.dispatch(b"\x00\x01not-json").unwrap_err().code(),
        AdapterErrorCode::Malformed
    );
    assert_eq!(
        session.dispatch(b"").unwrap_err().code(),
        AdapterErrorCode::Malformed
    );
    // Valid JSON of the wrong shape.
    assert_eq!(
        session
            .dispatch(b"{\"kind\":\"nope\"}\n")
            .unwrap_err()
            .code(),
        AdapterErrorCode::Malformed
    );
    // Correct shape, unsupported version.
    let body = ControlBody::Command(JobCommand::Cancel {
        job: "job:x".parse().unwrap(),
    });
    let mut envelope = ControlEnvelope::new(body).unwrap();
    envelope.protocol = "2.0".to_string();
    let bytes = codec::encode(&envelope).unwrap();
    assert_eq!(
        session.dispatch(&bytes).unwrap_err().code(),
        AdapterErrorCode::VersionUnsupported
    );
    // Non-command bodies are rejected: the adapter only accepts commands.
    let event = ControlBody::Event(JobEvent::Cancelled {
        job: "job:x".parse().unwrap(),
    });
    let bytes = envelope_bytes(event);
    assert_eq!(
        session.dispatch(&bytes).unwrap_err().code(),
        AdapterErrorCode::Malformed
    );
    // Nothing was accepted: state and queue are untouched.
    assert_eq!(session.state().as_str(), "Created");
    assert!(session.drain_messages().is_empty());
}

#[test]
fn start_dispatch_and_drain_are_fifo_and_once_only() {
    let mut session = new_session();
    session.dispatch(&start_bytes(JOB_A)).expect("start");
    assert_eq!(session.state().as_str(), "Discovering");
    // Second start is wrong-state, not a second job.
    assert_eq!(
        session.dispatch(&start_bytes(JOB_A)).unwrap_err().code(),
        AdapterErrorCode::WrongState
    );
    let messages = session.drain_messages();
    assert_eq!(messages.len(), 2);
    let decoded = decode_all(&messages);
    match &decoded[0].body {
        ControlBody::Effect(HostEffect::AcquireResource { job, request, .. }) => {
            assert_eq!(job.as_str(), JOB_A);
            assert_eq!(request.uri, "https://example.com/item/1");
            assert_eq!(request.purpose, RequestPurpose::Metadata);
        }
        other => panic!("first message must be acquire-resource, got {other:?}"),
    }
    match &decoded[1].body {
        ControlBody::Event(JobEvent::JobState { job, state }) => {
            assert_eq!(job.as_str(), JOB_A);
            assert_eq!(state, "Discovering");
        }
        other => panic!("second message must be job-state, got {other:?}"),
    }
    // Draining is exactly-once.
    assert!(session.drain_messages().is_empty());
}

/// The delegated lifecycle: discovery bytes, selections, destination grant,
/// tile bytes for both engine tiles, then the engine's full completion tail.
#[test]
fn delegated_lifecycle_completes_through_tile_bytes() {
    let mut session = new_session();
    session.dispatch(&start_bytes(JOB_A)).expect("start");
    let start_messages = session.drain_messages();
    let request = discovery_request(&start_messages);

    let handle = seal(&mut session, b"metadata-bytes");
    let meta_reference = session
        .protocol_handle(handle)
        .expect("live handle projects");
    session
        .dispatch(&provide_resource_bytes(&session, JOB_A, handle, &request))
        .expect("provide");
    assert_eq!(session.state().as_str(), "AwaitingImageSelection");
    let messages = session.drain_messages();
    match &decode_all(&messages)[0].body {
        ControlBody::Event(JobEvent::Catalog { job, catalog }) => {
            assert_eq!(job.as_str(), JOB_A);
            assert_eq!(catalog.images.len(), 1);
        }
        other => panic!("expected catalog, got {other:?}"),
    }

    session
        .dispatch(&command_bytes(JobCommand::SelectImage {
            job: JOB_A.parse().unwrap(),
            image: "img:0".parse().unwrap(),
        }))
        .expect("select image");
    assert_eq!(session.state().as_str(), "AwaitingLevelSelection");
    session.drain_messages();

    session
        .dispatch(&command_bytes(JobCommand::SelectLevel {
            job: JOB_A.parse().unwrap(),
            level: "lvl:0".parse().unwrap(),
        }))
        .expect("select level");
    assert_eq!(session.state().as_str(), "AwaitingDestination");
    session.drain_messages();

    session
        .dispatch(&command_bytes(JobCommand::DestinationResponse {
            job: JOB_A.parse().unwrap(),
            destination: "dst:0".parse().unwrap(),
            granted: true,
        }))
        .expect("grant destination");
    assert_eq!(session.state().as_str(), "AcquiringTiles");
    let acquisition = session.drain_messages();
    let mut tile_requests = Vec::new();
    for envelope in decode_all(&acquisition) {
        if let ControlBody::Effect(HostEffect::AcquireTile { request, .. }) = envelope.body {
            tile_requests.push(request.id);
        }
    }
    assert_eq!(tile_requests.len(), 2, "lean engine plans two tiles");

    for (index, request) in tile_requests.iter().enumerate() {
        let bytes = format!("tile-bytes-{index}");
        let handle = seal(&mut session, bytes.as_bytes());
        session
            .dispatch(&provide_resource_bytes(&session, JOB_A, handle, request))
            .unwrap_or_else(|e| panic!("tile {index} bytes accepted: {e:?}"));
    }
    assert_eq!(session.state().as_str(), "Completed");
    let messages = session.drain_messages();
    let decoded = decode_all(&messages);
    match &decoded.last().expect("messages").body {
        ControlBody::Event(JobEvent::Completed { job, output }) => {
            assert_eq!(job.as_str(), JOB_A);
            assert_eq!(output.as_str(), "out:0");
        }
        other => panic!("expected completed, got {other:?}"),
    }
    // The engine emitted progress and release effects; tile buffers were
    // released by the adapter on release-bytes.
    assert!(messages
        .iter()
        .any(|m| String::from_utf8_lossy(m).contains("progress")));

    // The consumed discovery buffer cannot be replayed.
    let replay = envelope_bytes(ControlBody::Command(JobCommand::ProvideResource {
        job: JOB_A.parse().unwrap(),
        request: request.clone(),
        buffer: meta_reference,
    }));
    assert_eq!(
        session.dispatch(&replay).unwrap_err().code(),
        AdapterErrorCode::WrongState,
        "terminal state rejects replays"
    );
}

#[test]
fn failure_recovery_and_cancel_paths_follow_the_engine() {
    // One fetch failure enters recovery (bounded retries), not failure.
    let mut failing = new_session();
    failing.dispatch(&start_bytes("job:fail-1")).expect("start");
    let first_request = discovery_request(&failing.drain_messages());
    let failure = envelope_bytes(ControlBody::Command(JobCommand::ProvideFetchFailure {
        job: "job:fail-1".parse().unwrap(),
        request: first_request,
        error: ErrorDto::new("acquisition", ErrorPhase::Acquisition, "boom"),
    }));
    failing.dispatch(&failure).expect("failure accepted");
    assert_eq!(failing.state().as_str(), "AwaitingRecovery");
    let messages = failing.drain_messages();
    match &decode_all(&messages)[0].body {
        ControlBody::Effect(HostEffect::RequestDecision { recovery, .. }) => {
            assert!(recovery.as_str().starts_with("rec:"));
        }
        other => panic!("expected request-decision, got {other:?}"),
    }
    match &decode_all(&messages)[1].body {
        ControlBody::Event(JobEvent::RecoveryRequest { actions, .. }) => {
            assert_eq!(actions.len(), 1);
        }
        other => panic!("expected recovery-requested, got {other:?}"),
    }

    // Retry then exhaust the retries: the engine fails honestly.
    for attempt in 0..3u32 {
        let attempt_id: dezoomify_protocol::dto::AttemptId =
            format!("att:{attempt}").parse().unwrap();
        failing
            .dispatch(&command_bytes(JobCommand::RetryReady {
                job: "job:fail-1".parse().unwrap(),
                attempt: attempt_id,
            }))
            .expect("retry ready");
        assert_eq!(failing.state().as_str(), "Discovering");
        let request = discovery_request(&failing.drain_messages());
        let failure = envelope_bytes(ControlBody::Command(JobCommand::ProvideFetchFailure {
            job: "job:fail-1".parse().unwrap(),
            request,
            error: ErrorDto::new("acquisition", ErrorPhase::Acquisition, "boom again"),
        }));
        failing.dispatch(&failure).expect("failure accepted");
        if attempt < 2 {
            assert_eq!(failing.state().as_str(), "AwaitingRecovery");
            failing.drain_messages();
        }
    }
    assert_eq!(failing.state().as_str(), "Failed");
    let messages = failing.drain_messages();
    match &decode_all(&messages).last().expect("messages").body {
        ControlBody::Event(JobEvent::Failed { error, .. }) => {
            assert_eq!(error.code, "job.fetch-failed");
            assert!(!error.message.contains("CANARY"));
        }
        other => panic!("expected failed, got {other:?}"),
    }

    let mut cancelling = new_session();
    cancelling
        .dispatch(&start_bytes("job:cancel-1"))
        .expect("start");
    cancelling
        .dispatch(&cancel_bytes("job:cancel-1"))
        .expect("cancel");
    assert_eq!(cancelling.state().as_str(), "Cancelled");
    assert_eq!(
        cancelling
            .dispatch(&cancel_bytes("job:cancel-1"))
            .unwrap_err()
            .code(),
        AdapterErrorCode::WrongState,
        "cancel in a terminal state is rejected"
    );
}

#[test]
fn processing_copies_exact_pixels_with_expected_digest() {
    let mut session = new_session();
    // 4x4 RGBA8: pixel (x, y) is [x, y, x ^ y, 255].
    let mut source = Vec::with_capacity(4 * 4 * 4);
    for y in 0u8..4 {
        for x in 0u8..4 {
            source.extend_from_slice(&[x, y, x ^ y, 255]);
        }
    }
    let input = seal(&mut session, &source);
    let output = session.allocate_buffer(2 * 2 * 4).expect("output");
    let geometry = CropGeometry {
        x: 1,
        y: 1,
        w: 2,
        h: 2,
    };
    let digest = session
        .process_crop(PROCESSING_OPERATION, input, output, 4, 4, &geometry)
        .expect("crop");
    // Digest of the exact expected bytes below.
    assert_eq!(digest, "9b49c8758f302b81");
    session
        .commit_buffer(output, 2 * 2 * 4)
        .expect("seal output");
    let pixels = session.take_buffer(output).expect("read output");
    assert_eq!(
        pixels,
        vec![
            1, 1, 0, 255, 2, 1, 3, 255, //
            1, 2, 3, 255, 2, 2, 0, 255, //
        ]
    );
    assert_eq!(
        session
            .process_crop("decode-image", input, output, 4, 4, &geometry)
            .unwrap_err()
            .code(),
        AdapterErrorCode::Malformed,
        "unknown operations are rejected"
    );
}

#[test]
fn processing_bounds_failures_leave_output_untouched() {
    let mut session = new_session();
    let mut source = Vec::with_capacity(4 * 4 * 4);
    for y in 0u8..4 {
        for x in 0u8..4 {
            source.extend_from_slice(&[x, y, x ^ y, 255]);
        }
    }
    let input = seal(&mut session, &source);
    // Region overruns the source edge.
    let output = session.allocate_buffer(2 * 2 * 4).expect("output");
    let bad = CropGeometry {
        x: 3,
        y: 3,
        w: 2,
        h: 2,
    };
    assert_eq!(
        session
            .process_crop(PROCESSING_OPERATION, input, output, 4, 4, &bad)
            .unwrap_err()
            .code(),
        AdapterErrorCode::LimitExceeded
    );
    // Undersized output capacity.
    let small = session.allocate_buffer(4).expect("small output");
    let ok = CropGeometry {
        x: 0,
        y: 0,
        w: 2,
        h: 2,
    };
    assert_eq!(
        session
            .process_crop(PROCESSING_OPERATION, input, small, 4, 4, &ok)
            .unwrap_err()
            .code(),
        AdapterErrorCode::LimitExceeded
    );
    // In-place processing is forbidden (aliasing).
    assert_eq!(
        session
            .process_crop(PROCESSING_OPERATION, input, input, 4, 4, &ok)
            .unwrap_err()
            .code(),
        AdapterErrorCode::WrongState
    );
    // Atomicity: the failed output still holds its zeroed allocation bytes.
    session.commit_buffer(output, 2 * 2 * 4).expect("seal");
    assert_eq!(
        session.take_buffer(output).expect("read"),
        vec![0u8; 2 * 2 * 4]
    );
    session.free_buffer(small).expect("release small");
}

#[test]
fn two_interleaved_sessions_stay_isolated() {
    let mut first = new_session();
    let mut second = new_session();
    first.dispatch(&start_bytes("job:iso-1")).expect("start 1");
    second.dispatch(&start_bytes("job:iso-2")).expect("start 2");
    let handle = seal(&mut first, b"first-session-bytes");
    // The handle is meaningless in the second session.
    assert_eq!(
        second.take_buffer(handle).unwrap_err().code(),
        AdapterErrorCode::StaleBuffer
    );
    let first_start = first.drain_messages();
    assert_eq!(first_start.len(), 2);
    let request = discovery_request(&first_start);
    let provide = provide_resource_bytes(&first, "job:iso-1", handle, &request);
    assert_eq!(
        second.dispatch(&provide).unwrap_err().code(),
        AdapterErrorCode::WrongState,
        "foreign job ids are rejected"
    );
    // Each session drains only its own messages.
    assert!(first.drain_messages().is_empty());
    assert_eq!(second.drain_messages().len(), 2);
    // Disposing one session leaves the other usable.
    first.dispose().expect("dispose first");
    assert_eq!(
        first
            .dispatch(&cancel_bytes("job:iso-1"))
            .unwrap_err()
            .code(),
        AdapterErrorCode::Disposed
    );
    second
        .dispatch(&cancel_bytes("job:iso-2"))
        .expect("second still live");
    assert_eq!(second.state().as_str(), "Cancelled");
}

#[test]
fn dispose_is_idempotent_and_rejects_later_dispatch() {
    let mut session = new_session();
    session.dispatch(&start_bytes("job:disp-1")).expect("start");
    session.drain_messages();
    session.dispose().expect("first dispose");
    assert!(session.is_disposed());
    session.dispose().expect("repeat dispose is safe");
    assert_eq!(
        session
            .dispatch(&cancel_bytes("job:disp-1"))
            .unwrap_err()
            .code(),
        AdapterErrorCode::Disposed
    );
    assert_eq!(
        session.allocate_buffer(4).unwrap_err().code(),
        AdapterErrorCode::Disposed
    );
    // Terminal cleanup is still drainable exactly once: the engine's
    // cancellation lifecycle ends with the cancelled event.
    let drained = session.drain_messages();
    assert!(
        drained.len() >= 2,
        "cancel lifecycle is emitted: {drained:?}"
    );
    match &decode_all(&drained).last().expect("messages").body {
        ControlBody::Event(JobEvent::Cancelled { job }) => {
            assert_eq!(job.as_str(), "job:disp-1");
        }
        other => panic!("expected cancelled cleanup, got {other:?}"),
    }
    assert!(session.drain_messages().is_empty());
}

#[test]
fn host_error_text_never_reaches_transcripts() {
    let mut session = new_session();
    session
        .dispatch(&start_bytes("job:redact-1"))
        .expect("start");
    let request = discovery_request(&session.drain_messages());
    let failure = envelope_bytes(ControlBody::Command(JobCommand::ProvideFetchFailure {
        job: "job:redact-1".parse().unwrap(),
        request,
        error: ErrorDto::new(
            "acquisition",
            ErrorPhase::Acquisition,
            "fetch https://h/?apiKey=CANARY failed",
        ),
    }));
    session.dispatch(&failure).expect("failure accepted");
    // Host-supplied error text is untrusted and is dropped by the engine
    // mapping: nothing in the transcript echoes it.
    for message in session.drain_messages() {
        let text = String::from_utf8_lossy(&message);
        assert!(!text.contains("CANARY"), "canary leaked: {text}");
    }
}

/// P07-WORKFLOWS: the delegated basic-success replay must equal the
/// checked-in golden transcript byte-for-byte (canonical re-encoding of
/// each entry).
#[test]
fn basic_success_transcript_matches_golden() {
    let mut session = new_session();
    let mut transcript = Vec::new();

    session.dispatch(&start_bytes(JOB_A)).expect("start");
    let start_messages = session.drain_messages();
    let request = discovery_request(&start_messages);
    transcript.extend(start_messages);
    let handle = seal(&mut session, b"metadata-bytes");
    session
        .dispatch(&provide_resource_bytes(&session, JOB_A, handle, &request))
        .expect("provide");
    transcript.extend(session.drain_messages());

    session
        .dispatch(&command_bytes(JobCommand::SelectImage {
            job: JOB_A.parse().unwrap(),
            image: "img:0".parse().unwrap(),
        }))
        .expect("select image");
    session
        .dispatch(&command_bytes(JobCommand::SelectLevel {
            job: JOB_A.parse().unwrap(),
            level: "lvl:0".parse().unwrap(),
        }))
        .expect("select level");
    session
        .dispatch(&command_bytes(JobCommand::DestinationResponse {
            job: JOB_A.parse().unwrap(),
            destination: "dst:0".parse().unwrap(),
            granted: true,
        }))
        .expect("grant destination");
    transcript.extend(session.drain_messages());

    let mut tile_requests = Vec::new();
    for envelope in decode_all(&transcript) {
        if let ControlBody::Effect(HostEffect::AcquireTile { request, .. }) = envelope.body {
            tile_requests.push(request.id);
        }
    }
    for (index, request) in tile_requests.iter().enumerate() {
        let bytes = format!("tile-bytes-{index}");
        let handle = seal(&mut session, bytes.as_bytes());
        session
            .dispatch(&provide_resource_bytes(&session, JOB_A, handle, request))
            .expect("tile bytes accepted");
        transcript.extend(session.drain_messages());
    }

    let golden_text = std::fs::read_to_string(GOLDEN_PATH).expect("golden wasm.json is checked in");
    let golden: Vec<serde_json::Value> =
        serde_json::from_str(&golden_text).expect("golden parses as an array");
    assert_eq!(transcript.len(), golden.len());
    for (bytes, expected) in transcript.iter().zip(golden.iter()) {
        let envelope: ControlEnvelope = codec::decode(bytes).expect("message decodes");
        // Canonical re-encoding equals the drained bytes (golden stability).
        assert_eq!(&codec::encode(&envelope).expect("re-encodes"), bytes);
        let actual: serde_json::Value = serde_json::from_slice(bytes).expect("message is JSON");
        assert_eq!(&actual, expected);
    }
}

#[test]
fn empty_resource_fails_the_job_and_wrong_request_is_rejected() {
    let mut session = new_session();
    session.dispatch(&start_bytes(JOB_A)).expect("start");
    let request = discovery_request(&session.drain_messages());
    // Empty discovery resource: the engine fails the job honestly.
    let empty = seal(&mut session, b"");
    let provide_empty = provide_resource_bytes(&session, JOB_A, empty, &request);
    session
        .dispatch(&provide_empty)
        .expect("empty resource is accepted and fails the job");
    assert_eq!(session.state().as_str(), "Failed");
    let messages = session.drain_messages();
    match &decode_all(&messages).last().expect("messages").body {
        ControlBody::Event(JobEvent::Failed { error, .. }) => {
            assert_eq!(error.code, "job.empty-resource");
        }
        other => panic!("expected failed, got {other:?}"),
    }

    // Wrong request ID: rejected without state change.
    let mut other = new_session();
    other.dispatch(&start_bytes(JOB_A)).expect("start");
    other.drain_messages();
    let handle = seal(&mut other, b"metadata-bytes");
    let buffer = other.protocol_handle(handle).expect("projects");
    let wrong = envelope_bytes(ControlBody::Command(JobCommand::ProvideResource {
        job: JOB_A.parse().unwrap(),
        request: "req:wasm-wrong-9".parse().unwrap(),
        buffer,
    }));
    assert_eq!(
        other.dispatch(&wrong).unwrap_err().code(),
        AdapterErrorCode::WrongState
    );
    assert_eq!(other.state().as_str(), "Discovering");
}
