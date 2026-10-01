//! Cross-boundary error raising: the same `Error` shapes round-trip both
//! directions across the Rust/TypeScript frontier. Hosts throw plain
//! objects; serde round-trips them through the tagged `kind` contract.

use dezoomify::model::{Error, ErrorTransport, Failure, ResourceKind};

#[test]
fn rust_errors_serialize_to_the_tagged_wire_shape() {
    let error = Error::HttpError {
        status: 429,
        retry_after_ms: Some(3_000),
        preview: Some("Too Many Requests".into()),
        transport: ErrorTransport::MetadataProxy,
        failure: Failure {
            request: Some("https://example.test/info.json".into()),
            detail: Some("proxy failure: PROXY_RATE_LIMITED".into()),
        },
    };
    let value = serde_json::to_value(&error).expect("serializes");
    assert_eq!(value["kind"], "http-error");
    assert_eq!(value["status"], 429);
    assert_eq!(value["request"], "https://example.test/info.json");
    assert_eq!(value["retry_after_ms"], 3_000);
    assert_eq!(value["transport"], "metadata-proxy");
    // Absent optional facts are omitted, never nulled.
    assert!(value.get("detail").is_some());
    let wrapped = Error::NoImageFound {
        failure: Failure::default(),
    }
    .resource("https://example.test/viewer", ResourceKind::Metadata);
    let value = serde_json::to_value(&wrapped).expect("serializes");
    assert_eq!(value["kind"], "resource");
    assert_eq!(value["request"], "https://example.test/viewer");
    assert_eq!(value["resource_kind"], "metadata");
    assert_eq!(value["source"]["kind"], "no-image-found");
    assert!(value["source"].get("detail").is_none());
}

#[test]
fn host_thrown_objects_deserialize_into_the_same_enum() {
    // Exactly what browser hosts throw across the boundary.
    let thrown = serde_json::json!({
        "kind": "policy-denied",
        "blocked_reason": "access-required",
        "transport": "browser-session",
        "detail": "access to https://example.test is required",
    });
    let error: Error = serde_json::from_value(thrown).expect("deserializes");
    assert_eq!(
        error,
        Error::PolicyDenied {
            blocked_reason: dezoomify::model::BlockedReason::AccessRequired,
            transport: ErrorTransport::BrowserSession,
            failure: "access to https://example.test is required"
                .to_string()
                .into(),
        }
    );
    // Aggregates carry their derived verdict and largest hint; the settled
    // evidence lives in the job's `missing[]` collection and the diagnostics
    // report, never one nested error per failed attempt.
    let thrown = serde_json::json!({
        "kind": "no-usable-tiles",
        "transient": true,
        "retry_after_ms": 3_000,
    });
    let error: Error = serde_json::from_value(thrown).expect("deserializes");
    assert!(error.retryable(), "a transient aggregate invites retry");
    assert_eq!(error.retry_after_ms(), Some(3_000));
    // Round-trip: what one side raises, the other side reads unchanged.
    let round_tripped: Error =
        serde_json::from_value(serde_json::to_value(&error).expect("serializes"))
            .expect("round trip");
    assert_eq!(round_tripped, error);
}

#[test]
fn the_kind_tag_is_the_single_stable_identifier() {
    // The serialized tag and `kind()` can never disagree.
    for (error, kind) in [
        (Error::Cancelled, "cancelled"),
        (Error::PlanEmpty, "plan-empty"),
        (
            Error::LimitExceeded {
                limit: dezoomify::model::LimitContext {
                    reason: dezoomify::model::LimitReason::JpegSide,
                    dimensions: None,
                    bytes_required: None,
                    bytes_available: None,
                },
            },
            "limit-exceeded",
        ),
        (
            Error::Resource {
                request: "https://example.test".into(),
                resource_kind: ResourceKind::Tile,
                source: Box::new(Error::DecodeFailed {
                    failure: "broken".to_string().into(),
                }),
            },
            "resource",
        ),
    ] {
        let value = serde_json::to_value(&error).expect("serializes");
        assert_eq!(error.kind(), value["kind"], "{kind}");
        assert_eq!(value["kind"], kind);
    }
    // Unknown kinds are refused at the boundary instead of mistranslated.
    assert!(serde_json::from_value::<Error>(serde_json::json!({ "kind": "made-up" })).is_err());
}
