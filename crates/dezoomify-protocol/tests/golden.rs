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
fn envelope_version_alias_accepted() {
    // Task 6.5: mutually supported 1.0 accepts the "1" alias; anything else
    // is incompatible before any work.
    let ok = ControlEnvelope::new(ControlBody::Error(ErrorDto::new(
        "x.y",
        ErrorPhase::Validation,
        "m",
    )))
    .unwrap();
    assert!(codec::check_envelope_version(&ok).is_ok());
    let mut alias = ok.clone();
    alias.protocol = "1".to_string();
    assert!(codec::check_envelope_version(&alias).is_ok());
    let mut bad = ok.clone();
    bad.protocol = "2.0".to_string();
    assert!(codec::check_envelope_version(&bad).is_err());
}

#[test]
fn native_baseline_matches_desktop_contract() {
    // Task 6.5: capabilities negotiation declaration. The native baseline is
    // the single source the desktop handshake/capability documents project:
    // http(s) input, native fetch, png/jpeg/tiff codecs, file + iiif-dir
    // destinations, cache storage, max_concurrency 16, sequential bulk queue,
    // handoff supported. The UI gates controls from this declaration and the
    // engine re-validates the final request. Todo 5.3: website single-queue
    // plus desktop multi-job queue flip bulk_supported true on browser and
    // native baselines.
    let caps = CapabilitiesDto::native_baseline();
    assert_eq!(
        caps.input_schemes,
        vec!["https".to_string(), "http".to_string()]
    );
    assert_eq!(caps.fetch_modes, vec!["native".to_string()]);
    assert_eq!(
        caps.decoders,
        vec!["png".to_string(), "jpeg".to_string(), "tiff".to_string()]
    );
    assert_eq!(
        caps.encoders,
        vec![
            "png".to_string(),
            "jpeg".to_string(),
            "tiff".to_string(),
            "zif".to_string(),
            "webp".to_string(),
        ]
    );
    assert_eq!(
        caps.destination_modes,
        vec!["file".to_string(), "iiif-dir".to_string()]
    );
    assert_eq!(caps.storage_modes, vec!["cache".to_string()]);
    assert_eq!(caps.max_concurrency, 16);
    assert!(caps.bulk_supported);
    assert!(caps.supports_bulk_queue());
    assert!(caps.handoff_supported);
    // Todo 5.7: Pause v1 flips paused_supported true on both baselines.
    assert!(caps.paused_supported);
    assert!(caps.supports_pause());
    assert!(CapabilitiesDto::browser_baseline().supports_pause());
    assert!(caps.keys().contains(&"pause".to_string()));
}

#[test]
fn bulk_capability_negotiation_with_n_minus_1_compat() {
    // Todo 5.3: queue availability is capability-negotiated. Website
    // single-queue plus desktop multi-job queue flip bulk_supported true on
    // browser and native baselines. Both peers must agree; an N-1 peer
    // (bulk_supported false, or a payload omitting the field) disables queue
    // controls without breaking the 1.0 handshake. Current and N-1 are both
    // 1.0 per release/compatibility.toml.
    let browser = CapabilitiesDto::browser_baseline();
    let native = CapabilitiesDto::native_baseline();
    assert!(browser.bulk_supported);
    assert!(native.bulk_supported);
    assert!(browser.supports_bulk_queue());
    assert!(native.supports_bulk_queue());
    assert!(CapabilitiesDto::negotiated_bulk(&browser, &native));
    assert!(CapabilitiesDto::negotiated_bulk(&native, &browser));
    // N-1 compat: a current peer talking to an N-1 peer (bulk false)
    // negotiates the queue off but keeps the 1.0 version handshake.
    let mut n_minus_1 = CapabilitiesDto::native_baseline();
    n_minus_1.bulk_supported = false;
    assert!(!CapabilitiesDto::negotiated_bulk(&native, &n_minus_1));
    assert!(negotiate_version("1.0").is_ok());
    assert!(negotiate_version("1").is_ok());
    // Missing bulk_supported (pre-queue N-1 payload) defaults to false, so
    // old documents still decode and gate the queue off.
    let legacy = serde_json::json!({
        "input_schemes": ["https", "http"],
        "fetch_modes": ["native"],
        "decoders": ["png"],
        "processing_ops": [],
        "encoders": ["png"],
        "destination_modes": ["file"],
        "storage_modes": ["cache"],
        "max_concurrency": 16,
        "max_tile_bytes": 8388608
    });
    let decoded: CapabilitiesDto = serde_json::from_value(legacy).expect("N-1 decodes");
    assert!(!decoded.bulk_supported);
    assert!(!decoded.supports_bulk_queue());
    assert!(decoded.handoff_supported);
    assert!(!CapabilitiesDto::negotiated_bulk(&native, &decoded));
}

#[test]
fn pause_capability_negotiation_with_n_minus_1_compat() {
    // Todo 5.7: Pause v1 (suspend-acquisition) is capability-negotiated.
    // Browser and native baselines flip paused_supported true. Both peers
    // must agree; an N-1 peer (paused false, or a payload omitting the
    // field) disables pause controls without breaking the 1.0 handshake.
    // Current and N-1 are both 1.0 per release/compatibility.toml.
    let browser = CapabilitiesDto::browser_baseline();
    let native = CapabilitiesDto::native_baseline();
    assert!(browser.paused_supported);
    assert!(native.paused_supported);
    assert!(browser.supports_pause());
    assert!(native.supports_pause());
    assert!(CapabilitiesDto::negotiated_pause(&browser, &native));
    assert!(CapabilitiesDto::negotiated_pause(&native, &browser));
    // N-1 compat: a current peer talking to an N-1 peer (paused false)
    // negotiates pause off but keeps the 1.0 version handshake.
    let mut n_minus_1 = CapabilitiesDto::native_baseline();
    n_minus_1.paused_supported = false;
    assert!(!CapabilitiesDto::negotiated_pause(&native, &n_minus_1));
    assert!(negotiate_version("1.0").is_ok());
    assert!(negotiate_version("1").is_ok());
    // Missing paused_supported (pre-pause N-1 payload) defaults to false, so
    // old documents still decode and gate pause off.
    let legacy = serde_json::json!({
        "input_schemes": ["https", "http"],
        "fetch_modes": ["native"],
        "decoders": ["png"],
        "processing_ops": [],
        "encoders": ["png"],
        "destination_modes": ["file"],
        "storage_modes": ["cache"],
        "max_concurrency": 16,
        "max_tile_bytes": 8388608,
        "bulk_supported": true
    });
    let decoded: CapabilitiesDto = serde_json::from_value(legacy).expect("N-1 decodes");
    assert!(!decoded.paused_supported);
    assert!(!decoded.supports_pause());
    assert!(!CapabilitiesDto::negotiated_pause(&native, &decoded));
    // Pause/resume commands and paused/resumed events round-trip.
    let job: JobId = "job:pause-1".parse().unwrap();
    for command in [
        JobCommand::Pause { job: job.clone() },
        JobCommand::Resume { job: job.clone() },
    ] {
        let envelope =
            ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Command(command)).unwrap();
        let bytes = codec::encode(&envelope).unwrap();
        let back: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(codec::encode(&back).unwrap(), bytes);
    }
    for event in [
        JobEvent::Paused { job: job.clone() },
        JobEvent::Resumed { job: job.clone() },
    ] {
        assert_eq!(event.kind(), EventKind::Replayable);
        assert!(!event.is_terminal());
        let envelope =
            ControlEnvelope::new(dezoomify_protocol::dto::ControlBody::Event(event)).unwrap();
        let bytes = codec::encode(&envelope).unwrap();
        let back: ControlEnvelope = codec::decode(&bytes).unwrap();
        assert_eq!(codec::encode(&back).unwrap(), bytes);
    }
}

#[test]
fn limits_grid_transports_single_generation() {
    // Task 6.4: one limit/grid/capability generation via protocol generate.
    // Limits mirror the website browser bound (16384 squared), the native
    // 8 GiB canvas cap, the 2 MiB metadata proxy cap, and the 1500 ms
    // direct-first metadata window.
    assert_eq!(MAX_BROWSER_AREA, 268_435_456);
    assert_eq!(MAX_BROWSER_AREA, 16_384 * 16_384);
    assert_eq!(NATIVE_MAX_BYTES, 8_589_934_592);
    assert_eq!(NATIVE_MAX_BYTES, 8 << 30);
    assert_eq!(PROXY_MAX_BYTES, 2_097_152);
    assert_eq!(PROXY_MAX_BYTES, 2 * 1024 * 1024);
    assert_eq!(METADATA_WINDOW_MS, 1_500);
    // Transport labels stay single-sourced with browser-runtime types.ts.
    assert_eq!(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
    assert_eq!(PROXY_TRANSPORT_LABEL, "Metadata proxy");
    // Format grid mirrors registry.rs BUILTINS snapshot: 19 entries in
    // precedence order, with custom and bulk_text as power-user entries.
    assert_eq!(FORMAT_GRID.len(), 19);
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
            "gigapan",
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
fn limits_fingerprint_covers_generation_deterministically() {
    use dezoomify_protocol::generate::{dto_fingerprint, limits_fingerprint, typescript};
    // Dto fingerprint stays stable so existing capability documents match;
    // the extended limits fingerprint covers the new generation.
    assert_eq!(dto_fingerprint(), "b4bad92b24615c58");
    let first = limits_fingerprint();
    assert_eq!(first.len(), 16);
    assert_eq!(limits_fingerprint(), first);
    let ts = typescript();
    assert!(ts.contains(&format!("LIMITS_FINGERPRINT = \"{first}\"")));
    assert!(ts.contains("MAX_BROWSER_AREA = 268435456"));
    assert!(ts.contains("NATIVE_MAX_BYTES = 8589934592"));
    assert!(ts.contains("PROXY_MAX_BYTES = 2097152"));
    assert!(ts.contains("METADATA_WINDOW_MS = 1500"));
    assert!(ts.contains("Direct from your browser"));
    assert!(ts.contains("Metadata proxy"));
    assert!(ts.contains("FORMAT_GRID"));
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
        JobCommand::Pause { job: job.clone() },
        JobCommand::Resume { job: job.clone() },
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
            | JobCommand::Cancel { .. }
            | JobCommand::Pause { .. }
            | JobCommand::Resume { .. } => {}
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
        JobEvent::Paused { job: job.clone() },
        JobEvent::Resumed { job: job.clone() },
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
            | JobEvent::Cancelled { .. }
            | JobEvent::Paused { .. }
            | JobEvent::Resumed { .. } => {}
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
