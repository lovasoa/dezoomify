//! Golden vectors: every variant encodes to canonical bytes and decodes back.
//! Canonical payloads live under `testdata/scenarios/protocol-v1/<id>/`.

use dezoomify_protocol::codec;
use dezoomify_protocol::dto::*;

fn job_id() -> JobId {
    "job:test-1".parse().unwrap()
}

#[test]
fn ids_reject_wrong_kind() {
    assert!("job:test-1".parse::<JobId>().is_ok());
    assert!("sess:test-1".parse::<JobId>().is_err());
    assert!("job:test-1".parse::<SessionId>().is_err());
    assert!("job:".parse::<JobId>().is_err());
}

#[test]
fn bounds_reject_overflow() {
    assert!(BoundedU64::new(10, 100).is_ok());
    assert!(BoundedU64::new(101, 100).is_err());
    assert!(BoundedU64::new(u64::MAX, MAX_DIMENSION).is_err());
}

#[test]
fn version_negotiation() {
    assert!(negotiate_version("1.0").is_ok());
    assert!(negotiate_version("1").is_ok());
    let err = negotiate_version("2.0").unwrap_err();
    assert_eq!(err.code, "protocol.incompatible");
}

#[test]
fn handoff_rejects_secrets() {
    let mut handoff = HandoffDto {
        id: "hand:test".parse().unwrap(),
        source_url: "https://example.com/item/1".into(),
        candidate: None,
        selection: None,
        output_intent: None,
        required_capabilities: vec!["direct".into()],
        provenance_label: "web".into(),
        expiry_hint: None,
        opaque_ref: None,
    };
    assert!(handoff.validate().is_ok());
    handoff.source_url = "https://user:pass@example.com/item".into();
    assert!(handoff.validate().is_err());
    handoff.source_url = "https://example.com/item?token=secret".into();
    // Query tokens are caught as forbidden handoff content.
    assert!(handoff.validate().is_err());
}

#[test]
fn error_text_redaction() {
    let redacted = redact_error_text("fetch https://h/?apiKey=CANARY failed");
    assert!(!redacted.contains("CANARY"));
    assert!(redacted.contains("REDACTED"));
}

#[test]
fn every_variant_round_trips_canonically() {
    let job = job_id();
    for command in all_commands(&job) {
        let envelope =
            ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Command(command)).unwrap();
        let bytes = codec::encode(&envelope).unwrap();
        assert!(bytes.ends_with(b"\n"));
        let back: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(codec::encode(&back).unwrap(), bytes);
    }
    for event in all_events(&job) {
        let envelope =
            ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Event(event)).unwrap();
        let bytes = codec::encode(&envelope).unwrap();
        assert!(bytes.ends_with(b"\n"));
        let back: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(codec::encode(&back).unwrap(), bytes);
    }
}

// Exhaustive matches: adding a variant without a round-trip vector is a
// compile error, so "every variant" stays true as the protocol grows.
fn all_commands(job: &JobId) -> Vec<JobCommand> {
    let commands = vec![
        JobCommand::Start {
            job: job.clone(),
            input_url: "https://example.com/item".into(),
        },
        JobCommand::ProvideResource {
            job: job.clone(),
            request: "req:1".parse().unwrap(),
            buffer: BufferHandle {
                id: "buf:1".parse().unwrap(),
                generation: 1,
                length: 16,
                checksum: None,
            },
        },
        JobCommand::ProvideFetchFailure {
            job: job.clone(),
            request: "req:1".parse().unwrap(),
            error: ErrorDto::new("fetch.failed", ErrorPhase::Acquisition, "gone"),
        },
        JobCommand::SelectImage {
            job: job.clone(),
            image: "img:1".parse().unwrap(),
        },
        JobCommand::SelectLevel {
            job: job.clone(),
            level: "lvl:1".parse().unwrap(),
        },
        JobCommand::ProvideDecodeOutcome {
            job: job.clone(),
            tile: "tile:1".parse().unwrap(),
            ok: true,
        },
        JobCommand::ProvideProcessOutcome {
            job: job.clone(),
            tile: "tile:1".parse().unwrap(),
            ok: true,
        },
        JobCommand::ProvideWriteOutcome {
            job: job.clone(),
            tile: "tile:1".parse().unwrap(),
            ok: true,
        },
        JobCommand::ProvideEncodeOutcome {
            job: job.clone(),
            ok: true,
        },
        JobCommand::ProvideFinalizeOutcome {
            job: job.clone(),
            output: "out:1".parse().unwrap(),
            ok: true,
        },
        JobCommand::ProvidePublicationOutcome {
            job: job.clone(),
            output: "out:1".parse().unwrap(),
            ok: true,
        },
        JobCommand::RetryReady {
            job: job.clone(),
            attempt: "att:1".parse().unwrap(),
        },
        JobCommand::PartialChoice {
            job: job.clone(),
            recovery: "rec:1".parse().unwrap(),
            keep_partial: true,
        },
        JobCommand::DestinationResponse {
            job: job.clone(),
            destination: "dst:1".parse().unwrap(),
            granted: true,
        },
        JobCommand::Cancel { job: job.clone() },
    ];
    for command in &commands {
        match command {
            JobCommand::Start { .. }
            | JobCommand::ProvideResource { .. }
            | JobCommand::ProvideFetchFailure { .. }
            | JobCommand::SelectImage { .. }
            | JobCommand::SelectLevel { .. }
            | JobCommand::ProvideDecodeOutcome { .. }
            | JobCommand::ProvideProcessOutcome { .. }
            | JobCommand::ProvideWriteOutcome { .. }
            | JobCommand::ProvideEncodeOutcome { .. }
            | JobCommand::ProvideFinalizeOutcome { .. }
            | JobCommand::ProvidePublicationOutcome { .. }
            | JobCommand::RetryReady { .. }
            | JobCommand::PartialChoice { .. }
            | JobCommand::DestinationResponse { .. }
            | JobCommand::Cancel { .. } => {}
        }
    }
    commands
}

fn all_events(job: &JobId) -> Vec<JobEvent> {
    let scan = ScanId::new("scan:1").unwrap();
    let candidate = CandidateDto {
        id: "cand:1".parse().unwrap(),
        url: "https://example.com/item".into(),
        format_hint: "Zoomify".into(),
        confidence: 90,
        reason: "fixture".into(),
        dedup_key: "d1".into(),
        source_frame: "main".into(),
    };
    let catalog = CatalogDto {
        images: vec![ImageDto {
            id: "img:1".parse().unwrap(),
            label: "One".into(),
            format: "Zoomify".into(),
            width: 256,
            height: 256,
            readiness: Readiness::Ready,
            source_kind: "fixed-grid".into(),
            levels: vec![LevelDto {
                id: "lvl:1".parse().unwrap(),
                width: 256,
                height: 256,
                tile_width: 256,
                tile_height: 256,
            }],
        }],
    };
    let events = vec![
        JobEvent::ScanSnapshot {
            job: job.clone(),
            snapshot: ScanSnapshot {
                scan: scan.clone(),
                candidates: vec![candidate],
                complete: true,
            },
        },
        JobEvent::JobState {
            job: job.clone(),
            state: "downloading".into(),
        },
        JobEvent::Catalog {
            job: job.clone(),
            catalog,
        },
        JobEvent::Progress {
            job: job.clone(),
            acquired: 3,
            total: 4,
        },
        JobEvent::Warning {
            job: job.clone(),
            error: ErrorDto::new("w.x", ErrorPhase::Discovery, "w"),
        },
        JobEvent::RecoveryRequest {
            job: job.clone(),
            recovery: "rec:1".parse().unwrap(),
            actions: vec![RecoveryAction {
                id: "retry".into(),
                kind: RecoveryKind::Retry,
                scope: "tile".into(),
                rationale: "transient".into(),
            }],
        },
        JobEvent::OutputReady {
            job: job.clone(),
            output: "out:1".parse().unwrap(),
        },
        JobEvent::Completed {
            job: job.clone(),
            output: "out:1".parse().unwrap(),
        },
        JobEvent::PartialCompleted {
            job: job.clone(),
            output: "out:1".parse().unwrap(),
        },
        JobEvent::Failed {
            job: job.clone(),
            error: ErrorDto::new("fetch.failed", ErrorPhase::Acquisition, "gone"),
        },
        JobEvent::Cancelled { job: job.clone() },
    ];
    for event in &events {
        match event {
            JobEvent::ScanSnapshot { .. }
            | JobEvent::JobState { .. }
            | JobEvent::Catalog { .. }
            | JobEvent::Progress { .. }
            | JobEvent::Warning { .. }
            | JobEvent::RecoveryRequest { .. }
            | JobEvent::OutputReady { .. }
            | JobEvent::Completed { .. }
            | JobEvent::PartialCompleted { .. }
            | JobEvent::Failed { .. }
            | JobEvent::Cancelled { .. } => {}
        }
    }
    events
}

#[test]
fn malformed_inputs_are_rejected() {
    assert!(codec::decode::<ControlEnvelope>(b"").is_err());
    assert!(codec::decode::<ControlEnvelope>(b"{not json}\n").is_err());
    // Trailing garbage after a valid envelope is rejected.
    let envelope = ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Error(
        ErrorDto::new("x.y", ErrorPhase::Validation, "m"),
    ))
    .unwrap();
    let mut bytes = codec::encode(&envelope).unwrap();
    bytes.extend_from_slice(b"GARBAGE");
    assert!(codec::decode::<ControlEnvelope>(&bytes).is_err());
}
#[test]
fn terminal_events_classified() {
    let job = job_id();
    let terminal = JobEvent::Completed {
        job: job.clone(),
        output: "out:o1".parse().unwrap(),
    };
    assert!(terminal.is_terminal());
    let transient = JobEvent::Warning {
        job,
        error: ErrorDto::new("w.x", ErrorPhase::Discovery, "w"),
    };
    assert!(!transient.is_terminal());
}

#[test]
fn canonical_vectors_match_checked_in_files() {
    for id in ["handshake-ok", "handoff-ok", "error-terminal"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/protocol-v1")
            .join(id)
            .join("expected/canonical.json");
        let bytes = std::fs::read(&path).expect("read golden vector");
        // Files store canonical bytes with trailing LF.
        let envelope: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(
            codec::encode(&envelope).unwrap(),
            bytes,
            "vector {id} not canonical"
        );
        check_version(&envelope);
        assert_vector_semantics(id, &envelope);
    }
}

// Canonical round-tripping alone would accept a checked-in vector whose
// content drifted (e.g. a corrupted handshake). Pin what each vector means.
fn assert_vector_semantics(id: &str, envelope: &ControlEnvelope) {
    match (&envelope.body, id) {
        (ControlBody::Command(JobCommand::Start { job, input_url }), "handshake-ok") => {
            assert_eq!(job.as_str(), "job:golden-1");
            assert_eq!(input_url, "https://example.com/item/1");
        }
        (ControlBody::Handoff(handoff), "handoff-ok") => {
            assert_eq!(handoff.id.as_str(), "hand:golden-1");
            assert_eq!(handoff.source_url, "https://example.com/item/1");
            assert_eq!(handoff.provenance_label, "web");
            assert_eq!(handoff.required_capabilities, vec!["direct".to_string()]);
        }
        (ControlBody::Event(event @ JobEvent::Failed { job, error }), "error-terminal") => {
            assert_eq!(job.as_str(), "job:golden-1");
            assert_eq!(error.code, "fetch.failed");
            assert_eq!(event.kind(), EventKind::Terminal);
        }
        _ => panic!("vector {id} has unexpected body shape: {:?}", envelope.body),
    }
}

fn check_version(envelope: &ControlEnvelope) {
    assert!(
        envelope.protocol == "1.0" || envelope.protocol == "1",
        "vector has wrong protocol version"
    );
    dezoomify_protocol::codec::check_envelope_version(envelope).expect("version check");
}
