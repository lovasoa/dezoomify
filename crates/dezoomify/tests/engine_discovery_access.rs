use dezoomify::engine::{
    DiscoveryInput, EffectId, EffectResult, EngineJob, Failure, JobOptions, ResponseMetadata,
    Update, UserCommand,
};
use dezoomify::model::{DiscoveryInputKind, HostEffect, JobState};

const SOURCE: &str = "https://museum.test/viewer";
const BLOCKED: &str = "https://image.test/art.dzi?signature=test-double";
const OTHER: &str = "https://museum.test/other.dzi";
const DZI: &[u8] =
    br#"<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>"#;

fn failure() -> Failure {
    Failure::new("TRANSPORT_POLICY_DENIED")
}

fn fetch(update: &Update, uri: &str) -> EffectId {
    let [HostEffect::AcquireResource { request }] = update.effects.as_slice() else {
        panic!("expected one metadata request: {:?}", update.effects);
    };
    assert_eq!(request.uri, uri);
    EffectId(request.id)
}

fn access(update: &Update, uri: &str) -> EffectId {
    let [
        HostEffect::RequestResourceAccess {
            effect,
            uri: actual,
        },
    ] = update.effects.as_slice()
    else {
        panic!("expected one access request: {:?}", update.effects);
    };
    assert_eq!(actual, uri);
    EffectId(*effect)
}

fn inputs() -> Vec<DiscoveryInput> {
    vec![
        DiscoveryInput::new(BLOCKED),
        DiscoveryInput::new(OTHER).with_kind(DiscoveryInputKind::ObservedResource),
    ]
}

#[test]
fn observations_and_sibling_frames_finish_before_requesting_blocked_access() {
    let page =
        br#"<iframe src="https://analytics.test/opt-out"></iframe><iframe src="/image"></iframe>"#;
    for (inputs, blocked_uri, other_uri) in [
        (inputs(), BLOCKED, OTHER),
        (
            vec![DiscoveryInput::with_contents(SOURCE, page)],
            "https://analytics.test/opt-out",
            "https://museum.test/image",
        ),
    ] {
        let (mut job, update) = EngineJob::start(JobOptions::new(inputs)).unwrap();
        let blocked = fetch(&update, blocked_uri);
        let update = job
            .complete(blocked, EffectResult::MetadataBlocked(failure()))
            .unwrap();
        let update = job
            .provide_metadata(fetch(&update, other_uri), ResponseMetadata::new(), DZI)
            .unwrap();
        assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
        assert!(update.effects.is_empty());
        assert_eq!(
            job.complete(blocked, EffectResult::MetadataBlocked(failure()))
                .unwrap_err()
                .code,
            "job.stale-effect"
        );
    }
}

fn exhaust_alternative() -> (EngineJob, EffectId, EffectId) {
    let (mut job, update) = EngineJob::start(JobOptions::new(inputs())).unwrap();
    let blocked = fetch(&update, BLOCKED);
    let update = job
        .complete(blocked, EffectResult::MetadataBlocked(failure()))
        .unwrap();
    let other = fetch(&update, OTHER);
    let update = job
        .provide_metadata(other, ResponseMetadata::new(), b"invalid")
        .unwrap();
    let recovery = access(&update, BLOCKED);
    (job, blocked, recovery)
}

#[test]
fn grant_resumes_exact_request_with_fresh_correlation_and_preserved_parser() {
    let (mut job, original, recovery) = exhaust_alternative();
    // A wrong-kind completion must preserve the access effect.
    assert_eq!(
        job.complete(recovery, EffectResult::TileAcquired)
            .unwrap_err()
            .code,
        "job.wrong-result-kind"
    );
    let update = job
        .complete(
            recovery,
            EffectResult::ResourceAccessResolved { granted: true },
        )
        .unwrap();
    let resumed = fetch(&update, BLOCKED);
    assert_ne!(original, resumed);
    assert_eq!(
        job.complete(
            recovery,
            EffectResult::ResourceAccessResolved { granted: true }
        )
        .unwrap_err()
        .code,
        "job.stale-effect"
    );
    let update = job
        .provide_metadata(resumed, ResponseMetadata::new(), DZI)
        .unwrap();
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
    assert!(update.effects.is_empty());
}

#[test]
fn denial_and_ineffective_grants_settle_without_reopening_access() {
    for granted in [false, true] {
        let (mut job, _, recovery) = exhaust_alternative();
        let mut update = job
            .complete(recovery, EffectResult::ResourceAccessResolved { granted })
            .unwrap();
        if granted {
            let resumed = fetch(&update, BLOCKED);
            update = job
                .complete(resumed, EffectResult::MetadataBlocked(failure()))
                .unwrap();
        }
        assert_eq!(update.snapshot.lifecycle, JobState::Failed);
        assert!(
            !update
                .effects
                .iter()
                .any(|effect| matches!(effect, HostEffect::RequestResourceAccess { .. }))
        );
    }
}

#[test]
fn cancellation_invalidates_pending_access() {
    let (mut job, _, recovery) = exhaust_alternative();
    let update = job.command(UserCommand::Cancel).unwrap();
    assert_eq!(update.snapshot.lifecycle, JobState::Cancelled);
    assert_eq!(
        job.complete(
            recovery,
            EffectResult::ResourceAccessResolved { granted: true }
        )
        .unwrap_err()
        .code,
        "job.post-terminal"
    );
}

#[test]
fn ordinary_http_refusals_never_become_permission_requests() {
    let (mut job, update) =
        EngineJob::start(JobOptions::new(vec![DiscoveryInput::new(BLOCKED)])).unwrap();
    let mut denied = failure();
    denied.http = Some(403);
    let update = job
        .complete(
            fetch(&update, BLOCKED),
            EffectResult::MetadataFailed(denied),
        )
        .unwrap();
    assert_eq!(update.snapshot.lifecycle, JobState::Failed);
    assert!(
        !update
            .effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::RequestResourceAccess { .. }))
    );
}

#[test]
fn denied_paths_advance_to_the_next_blocked_request_without_duplicate_fetches() {
    let (mut job, update) = EngineJob::start(JobOptions::new(vec![
        DiscoveryInput::new(BLOCKED),
        DiscoveryInput::new(BLOCKED),
        DiscoveryInput::new(OTHER),
    ]))
    .unwrap();
    let update = job
        .complete(
            fetch(&update, BLOCKED),
            EffectResult::MetadataBlocked(failure()),
        )
        .unwrap();
    let update = job
        .complete(
            fetch(&update, OTHER),
            EffectResult::MetadataBlocked(failure()),
        )
        .unwrap();
    let first = access(&update, BLOCKED);
    let update = job
        .complete(
            first,
            EffectResult::ResourceAccessResolved { granted: false },
        )
        .unwrap();
    let second = access(&update, OTHER);
    let update = job
        .complete(
            second,
            EffectResult::ResourceAccessResolved { granted: true },
        )
        .unwrap();
    let update = job
        .provide_metadata(fetch(&update, OTHER), ResponseMetadata::new(), DZI)
        .unwrap();
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
}
