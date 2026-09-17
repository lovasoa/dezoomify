//! Golden vectors: every variant encodes to canonical bytes and decodes back.
//! Canonical payloads live under `testdata/scenarios/protocol-v2/<id>/`.

use dezoomify_protocol::codec;
use dezoomify_protocol::dto::*;

#[test]
fn version_negotiation() {
    assert!(negotiate_version("2.0").is_ok());
    let err = negotiate_version("1.0").unwrap_err();
    assert_eq!(err.code, "protocol.incompatible");
    // Task 6.5: handshake failures surface at the handshake phase with
    // update guidance (the peer must update), never as silent validation.
    assert_eq!(err.phase, ErrorPhase::Handshake);
    assert!(
        err.message.contains("2.0") && err.message.contains("1.0"),
        "update guidance must name both versions: {}",
        err.message
    );
    assert!(!err.retryable);
}

#[test]
fn legacy_envelope_version_is_rejected() {
    let ok = ControlEnvelope::new(ControlBody::Error(ErrorDto::new(
        "x.y",
        ErrorPhase::Validation,
        "m",
    )))
    .unwrap();
    assert!(codec::check_envelope_version(&ok).is_ok());
    let mut bad = ok.clone();
    bad.protocol = "1.0".to_string();
    assert!(codec::check_envelope_version(&bad).is_err());
}

#[test]
fn limits_grid_transports_single_generation() {
    // Task 6.4: one limit/grid/capability generation via protocol generate.
    // Limits mirror the website browser bound (16384 squared), the native
    // The browser area cap, 2 MiB metadata proxy cap, and 1500 ms direct-first
    // metadata window.
    assert_eq!(MAX_BROWSER_AREA, 268_435_456);
    assert_eq!(MAX_BROWSER_AREA, 16_384 * 16_384);
    assert_eq!(PROXY_MAX_BYTES, 2_097_152);
    assert_eq!(PROXY_MAX_BYTES, 2 * 1024 * 1024);
    assert_eq!(METADATA_WINDOW_MS, 1_500);
    // Transport labels stay single-sourced with browser-runtime types.ts.
    assert_eq!(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
    assert_eq!(PROXY_TRANSPORT_LABEL, "Metadata proxy");
    // Format grid mirrors registry.rs BUILTINS snapshot: 18 entries in
    // precedence order, with custom and bulk_text as power-user entries.
    assert_eq!(FORMAT_GRID.len(), 18);
    assert_eq!(FORMAT_GRID.first(), Some(&("custom", "Custom tiles")));
    assert_eq!(FORMAT_GRID.last(), Some(&("bulk_text", "Bulk text")));
    assert_eq!(POWER_USER_FORMATS, &["custom", "bulk_text"]);
    for id in POWER_USER_FORMATS {
        assert!(
            FORMAT_GRID.iter().any(|(grid_id, _)| grid_id == id),
            "power-user {id} must be in the grid"
        );
    }
    let ids: Vec<&str> = FORMAT_GRID.iter().map(|(id, _)| *id).collect();
    assert_eq!(
        ids,
        vec![
            "custom",
            "google_arts_and_culture",
            "zoomify",
            "iiif",
            "deepzoom",
            "generic",
            "krpano",
            "iipimage",
            "xlimage",
            "topviewer",
            "fsi",
            "lizardtech",
            "vls",
            "hungaricana",
            "wmts",
            "arcgis",
            "pnav",
            "bulk_text",
        ]
    );
}

#[test]
fn error_text_redaction() {
    let redacted = redact_error_text("fetch https://h/?apiKey=CANARY failed");
    assert!(!redacted.contains("CANARY"));
    assert!(redacted.contains("REDACTED"));
}

#[test]
fn every_variant_round_trips_canonically() {
    for command in all_commands() {
        let envelope =
            ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Command(command)).unwrap();
        let bytes = codec::encode(&envelope).unwrap();
        assert!(bytes.ends_with(b"\n"));
        let back: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(codec::encode(&back).unwrap(), bytes);
    }
    for event in all_events() {
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
fn all_commands() -> Vec<JobCommand> {
    let commands = vec![
        JobCommand::Start {
            inputs: vec![dezoomify_protocol::dto::JobInputDto::new(
                "https://example.com/item",
            )],
        },
        JobCommand::ProvideResource {
            request: 1,
            buffer: BufferHandle {
                id: 1,
                generation: 1,
                length: 16,
                checksum: None,
            },
            final_uri: Some("https://example.com/redirected".into()),
        },
        JobCommand::ProvideFetchFailure {
            request: 1,
            error: ErrorDto::new("fetch.failed", ErrorPhase::Acquisition, "gone"),
        },
        JobCommand::SelectImage { image: 1 },
        JobCommand::SelectLevel { level: 1 },
        JobCommand::ProvideProbeOutcome {
            request: 1,
            ok: true,
            width: 256,
            height: 256,
        },
        JobCommand::ProvideDisplayOutcome {
            request: 1,
            width: 256,
            height: 256,
        },
        JobCommand::RecoveryChoice {
            generation: 1,
            choice: RecoveryChoice::Keep,
        },
        JobCommand::FinalizationSucceeded,
        JobCommand::FinalizationFailed {
            error: ErrorDto::new("output.failed", ErrorPhase::Output, "save failed"),
        },
        JobCommand::Cancel,
        JobCommand::Pause,
        JobCommand::Resume,
    ];
    for command in &commands {
        match command {
            JobCommand::Start { .. }
            | JobCommand::ProvideResource { .. }
            | JobCommand::ProvideFetchFailure { .. }
            | JobCommand::SelectImage { .. }
            | JobCommand::SelectLevel { .. }
            | JobCommand::ProvideProbeOutcome { .. }
            | JobCommand::ProvideDisplayOutcome { .. }
            | JobCommand::RecoveryChoice { .. }
            | JobCommand::FinalizationSucceeded
            | JobCommand::FinalizationFailed { .. }
            | JobCommand::Cancel
            | JobCommand::Pause
            | JobCommand::Resume => {}
        }
    }
    commands
}

fn all_events() -> Vec<JobEvent> {
    let catalog = CatalogDto {
        images: vec![ImageDto {
            title: Some("One".into()),
            format: "Zoomify".into(),
            width: 256,
            height: 256,
            readiness: Readiness::Ready,
            source_kind: "fixed-grid".into(),
            levels: vec![LevelDto {
                label: "Level 1".into(),
                width: 256,
                height: 256,
                tile_width: 256,
                tile_height: 256,
            }],
        }],
    };
    let events = vec![
        JobEvent::JobState {
            state: "downloading".into(),
        },
        JobEvent::Catalog { catalog },
        JobEvent::Progress {
            acquired: 3,
            total: 4,
        },
        JobEvent::Warning {
            error: ErrorDto::new("w.x", ErrorPhase::Discovery, "w"),
        },
        JobEvent::RecoveryRequest {
            generation: 1,
            actions: vec![RecoveryAction {
                id: "retry".into(),
                kind: RecoveryKind::Retry,
                scope: "tile".into(),
                rationale: "transient".into(),
            }],
        },
        JobEvent::Completed,
        JobEvent::PartialCompleted,
        JobEvent::Failed {
            error: ErrorDto::new("fetch.failed", ErrorPhase::Acquisition, "gone"),
        },
        JobEvent::Cancelled,
        JobEvent::Paused,
        JobEvent::Resumed,
    ];
    for event in &events {
        match event {
            JobEvent::JobState { .. }
            | JobEvent::Catalog { .. }
            | JobEvent::Progress { .. }
            | JobEvent::Warning { .. }
            | JobEvent::RecoveryRequest { .. }
            | JobEvent::Completed
            | JobEvent::PartialCompleted
            | JobEvent::Failed { .. }
            | JobEvent::Cancelled
            | JobEvent::Paused
            | JobEvent::Resumed => {}
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
    let terminal = JobEvent::Completed;
    assert!(terminal.is_terminal());
    let transient = JobEvent::Warning {
        error: ErrorDto::new("w.x", ErrorPhase::Discovery, "w"),
    };
    assert!(!transient.is_terminal());
}

#[test]
fn canonical_vectors_match_checked_in_files() {
    for id in ["handshake-ok", "error-terminal"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/protocol-v2")
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
        (ControlBody::Command(JobCommand::Start { inputs }), "handshake-ok") => {
            assert_eq!(inputs[0].url, "https://example.com/item/1");
        }
        (ControlBody::Event(event @ JobEvent::Failed { error }), "error-terminal") => {
            assert_eq!(error.code, "fetch.failed");
            assert_eq!(event.kind(), EventKind::Terminal);
        }
        _ => panic!("vector {id} has unexpected body shape: {:?}", envelope.body),
    }
}

fn check_version(envelope: &ControlEnvelope) {
    assert_eq!(
        envelope.protocol, "2.0",
        "vector has wrong protocol version"
    );
    dezoomify_protocol::codec::check_envelope_version(envelope).expect("version check");
}
