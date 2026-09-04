//! Canary redaction: no secret in events, logs, cache, or output paths.

use dezoomify_native::JobRequest;
use dezoomify_native::NativeRuntime;

#[test]
fn canaries_never_appear_in_events() {
    let runtime = NativeRuntime::new(1 << 30);
    let mut handle = runtime
        .start(JobRequest {
            input_url: "https://fixtures.test/item?token=CANARY-TOKEN".into(),
            output_path: "out.png".into(),
            overwrite: false,
        })
        .unwrap();
    handle.emit("started");
    let result = handle.finish("hash-1".into());
    let text = format!("{:?}{:?}", handle.events(), result);
    assert!(!text.contains("CANARY-TOKEN"));
}

#[test]
fn auth_debug_redacts_values() {
    use dezoomify_native::auth::{AuthorizationScope, EphemeralAuthorization};
    use std::collections::HashMap;
    let auth = EphemeralAuthorization::new(
        AuthorizationScope {
            scheme: "https".into(),
            host: "h".into(),
            port: None,
            path_prefix: "/".into(),
            job_id: None,
        },
        HashMap::from([("session".to_string(), "CANARY-VALUE".to_string())]),
    )
    .unwrap();
    assert!(!format!("{auth:?}").contains("CANARY-VALUE"));
}
