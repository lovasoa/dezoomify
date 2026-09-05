//! Native scenario tests: header scope, redirects, cache, limits.

use dezoomify_native::auth::{AuthorizationScope, EphemeralAuthorization};
use dezoomify_native::cache;
use dezoomify_native::client;
use dezoomify_native::download::{Scheduler, SchedulerConfig};
use dezoomify_native::output::{self, OutputFormat};
use std::collections::{BTreeMap, HashMap};

#[test]
fn auth_reaches_only_matching_requests() {
    let scope = AuthorizationScope {
        scheme: "https".into(),
        host: "fixtures.test".into(),
        port: None,
        path_prefix: "/private/".into(),
        job_id: None,
    };
    let auth = EphemeralAuthorization::new(
        scope,
        HashMap::from([("session".to_string(), "CANARY".to_string())]),
    )
    .unwrap();
    let matching = client::build_request(
        "https://fixtures.test/private/item",
        &BTreeMap::new(),
        Some(&auth),
    )
    .unwrap();
    assert!(matching.headers.contains_key("cookie"));
    let sibling = client::build_request(
        "https://other.test/private/item",
        &BTreeMap::new(),
        Some(&auth),
    )
    .unwrap();
    assert!(!sibling.headers.contains_key("cookie"));
    let redirect =
        client::rebuild_for_redirect(&matching, "https://evil.test/private/item", Some(&auth))
            .unwrap();
    assert!(!redirect.headers.contains_key("cookie"));
}

#[test]
fn public_headers_reject_cookie_and_authorization() {
    let mut extra = BTreeMap::new();
    extra.insert("Cookie".to_string(), "x=1".to_string());
    assert!(client::build_request("https://fixtures.test/x", &extra, None).is_err());
}

#[test]
fn scheduler_bounds_concurrency_and_tiles() {
    let mut scheduler = Scheduler::new(SchedulerConfig {
        max_concurrent: 2,
        max_tiles: 3,
        max_retries: 1,
    });
    assert!(scheduler.push("a".into()).is_ok());
    assert!(scheduler.push("b".into()).is_ok());
    assert!(scheduler.push("c".into()).is_ok());
    assert!(scheduler.push("d".into()).is_err());
    let batch = scheduler.next_batch();
    assert_eq!(batch.len(), 2);
    assert_eq!(scheduler.peak_in_flight(), 2);
}

#[test]
fn scheduler_retries_failures_then_gives_up() {
    let mut scheduler = Scheduler::new(SchedulerConfig {
        max_concurrent: 2,
        max_tiles: 3,
        max_retries: 1,
    });
    scheduler.push("a".into()).unwrap();
    let batch = scheduler.next_batch();
    assert_eq!(batch, vec!["a".to_string()]);
    // First failure is retryable (attempts 1 <= max_retries 1).
    assert!(scheduler.fail("a").unwrap());
    assert_eq!(scheduler.next_batch(), vec!["a".to_string()]);
    // Second failure exhausts the retry budget.
    assert!(!scheduler.fail("a").unwrap());
    // No retry is scheduled after exhaustion.
    assert_eq!(scheduler.next_batch(), Vec::<String>::new());
    assert_eq!(scheduler.done_count(), 0);
}

#[test]
fn cache_keys_exclude_query_and_never_persist_secrets() {
    assert_eq!(
        cache::cache_key("https://h/item?token=secret"),
        cache::cache_key("https://h/item?token=other")
    );
    let dir = std::env::temp_dir().join(format!("dz-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // A credential-bearing URL must never leak into the cache path or the
    // stored artifact: only the query-stripped key and the payload itself.
    let path = cache::store(&dir, "job1", "https://h/item?token=CANARY", b"bytes").unwrap();
    assert_eq!(
        cache::load(&dir, "job1", "https://h/item?token=CANARY").unwrap(),
        b"bytes"
    );
    let path_text = path.to_string_lossy();
    assert!(
        !path_text.contains("CANARY"),
        "cache path must exclude the query string: {path_text}"
    );
    let content = std::fs::read(&path).unwrap();
    assert_eq!(
        content, b"bytes",
        "stored artifact must be the payload only"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_refuses_mismatch_and_collision() {
    let dir = std::env::temp_dir().join(format!("dz-out-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("out.png");
    assert!(output::validate_destination(&path, &OutputFormat::Jpeg, false).is_err());
    output::write_atomic(&path, b"png-bytes").unwrap();
    assert!(output::validate_destination(&path, &OutputFormat::Png, false).is_err());
    assert!(output::validate_destination(&path, &OutputFormat::Png, true).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
