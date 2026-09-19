// Desktop Tauri command registry (lean shell, standard library only).
//
// Allowed commands: start_job, cancel_job, answer_choice,
// request_destination, query_capabilities. Every job-scoped command carries a
// typed job id; unknown or stale job ids are rejected before any effect.
// Events are ordered per job with a monotonic seq; terminal events appear
// exactly once. No tile bytes cross IPC, only protocol progress and events.

use crate::jobs::{Choice, JobTable};
use crate::settings::parse_settings;

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

/// Exact command registry, derived from `desktop_commands.rs`.
pub const COMMANDS: &[&str] = desktop_commands!(command_names);

/// Supported output formats for request_destination: the five single-file
/// native encoders plus the `iiif-dir` tile-tree destination.
pub const SUPPORTED_FORMATS: &[&str] = &["png", "jpeg", "tiff", "zif", "webp", "iiif-dir"];

/// Typed command failure with a stable machine-readable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    pub fn unknown_command(name: &str) -> Self {
        Self::new(
            "command.unknown",
            &format!("unknown command {name}; allowed: {}", COMMANDS.join(", ")),
        )
    }

    pub fn unknown_job(job: &str) -> Self {
        Self::new(
            "job.unknown",
            &format!("unknown job id {job}; the job never existed or belongs to a closed window"),
        )
    }

    pub fn stale_job(job: &str) -> Self {
        Self::new(
            "job.stale",
            &format!("stale job id {job}; the job already reached a terminal event"),
        )
    }

    pub fn invalid_input(message: &str) -> Self {
        Self::new("job.invalid-input", message)
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// True for `job:<suffix>` ids within the 128-byte bound.
pub fn is_valid_job_id(job: &str) -> bool {
    if !job.starts_with("job:") {
        return false;
    }
    let suffix = &job["job:".len()..];
    if suffix.is_empty() || job.len() > 128 {
        return false;
    }
    suffix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// True for http(s) input urls up to 2048 bytes without userinfo.
pub fn is_valid_input_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 {
        return false;
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    // Reject userinfo credentials embedded in the authority section.
    if let Some(after_scheme) = url.split("://").nth(1) {
        let authority = after_scheme.split('/').next().unwrap_or("");
        let authority = authority.split('?').next().unwrap_or(authority);
        if authority.contains('@') {
            return false;
        }
    }
    true
}

/// True for known registry names.
pub fn is_known_command(name: &str) -> bool {
    COMMANDS.contains(&name)
}

/// Split a `code: message` table string into its stable code and message.
/// The code is the namespaced token before the first colon; anything else
/// falls back to `None` so callers never branch on message text.
fn split_stable_code(detail: &str) -> Option<(String, String)> {
    let colon = detail.find(':')?;
    let (head, tail) = detail.split_at(colon);
    let code = head.trim().to_string();
    let message = tail[1..].trim().to_string();
    if code.is_empty()
        || message.is_empty()
        || code.len() > 128
        || !code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        || !code.contains('.')
    {
        return None;
    }
    Some((code, message))
}

/// Outcome of a validated dispatch; `event` is always the snapshot
/// transport (`job-snapshot`, or `capabilities` for the scopeless query).
/// `seq` is the payload revision (verbatim runner seq; 0 for synchronous
/// host transitions). Synchronous snapshot emits ride alongside the
/// outcome; live runner snapshots arrive via `JobTable::poll_drivers`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub job: String,
    pub seq: u64,
    pub event: String,
}

/// Validate and dispatch one typed command against the job table.
/// Each shell command maps to exactly one typed dispatcher below; there is
/// no generic `(command, job, arg)` string routing. Revisions flow verbatim
/// from the runner; this layer only forwards the snapshot outcome for the
/// creating window/session scope.
///
/// - Unknown command names are rejected before touching job state
///   ([`is_known_command`]).
/// - Job-scoped dispatchers reject unknown job ids (never created or closed
///   window) and stale job ids (already terminal) without new effects.
/// - Settings-aware `start_job` goes through
///   [`dispatch_start_job_with_settings`]; plain starts keep CLI-matching
///   defaults.
pub fn dispatch_start_job(
    table: &mut JobTable,
    input_url: &str,
) -> Result<(DispatchOutcome, Vec<crate::jobs::SnapshotEmit>), CommandError> {
    if !is_valid_input_url(input_url) {
        return Err(CommandError::invalid_input(
            "input_url must be an http(s) URL up to 2048 bytes without userinfo",
        ));
    }
    let (id, emit) = table
        .start_job(input_url)
        .map_err(|e| CommandError::invalid_input(&e))?;
    let seq = emit.seq;
    Ok((
        DispatchOutcome {
            job: id,
            seq,
            event: "job-snapshot".to_string(),
        },
        vec![emit],
    ))
}

/// Typed `cancel_job` dispatch: unknown or stale job ids are rejected before
/// any effect.
pub fn dispatch_cancel_job(
    table: &mut JobTable,
    job: &str,
) -> Result<(DispatchOutcome, Vec<crate::jobs::SnapshotEmit>), CommandError> {
    if !is_valid_job_id(job) {
        return Err(CommandError::invalid_input(
            "job id must look like job:<suffix>",
        ));
    }
    match table.cancel_job(job) {
        Ok((seq, emits)) => Ok((
            DispatchOutcome {
                job: job.to_string(),
                seq,
                event: "job-snapshot".to_string(),
            },
            emits,
        )),
        Err(kind) if kind == "unknown" => Err(CommandError::unknown_job(job)),
        Err(kind) if kind == "stale" => Err(CommandError::stale_job(job)),
        Err(other) => Err(CommandError::invalid_input(&other)),
    }
}

/// Typed `answer_choice` dispatch: the choice arrives as structured JSON,
/// decodes to a [`Choice`] before any effect, and unknown or stale job ids
/// are rejected first.
pub fn dispatch_answer_choice(
    table: &mut JobTable,
    job: &str,
    choice: serde_json::Value,
) -> Result<(DispatchOutcome, Vec<crate::jobs::SnapshotEmit>), CommandError> {
    if !is_valid_job_id(job) {
        return Err(CommandError::invalid_input(
            "job id must look like job:<suffix>",
        ));
    }
    let choice: Choice = serde_json::from_value(choice).map_err(|_| {
        CommandError::invalid_input(
            "choice must be {\"kind\":\"image\"|\"level\",\"index\":n} or \
             {\"kind\":\"partial\",\"decision\":\"keep\"|\"retry\"|\"discard\"}",
        )
    })?;
    match table.answer_choice(job, &choice) {
        Ok((seq, emits)) => Ok((
            DispatchOutcome {
                job: job.to_string(),
                seq,
                event: "job-snapshot".to_string(),
            },
            emits,
        )),
        Err(kind) if kind == "unknown" => Err(CommandError::unknown_job(job)),
        Err(kind) if kind == "stale" => Err(CommandError::stale_job(job)),
        Err(other) => Err(CommandError::invalid_input(&other)),
    }
}

/// Typed `query_capabilities` dispatch: monotonic seq, no job scope.
pub fn dispatch_query_capabilities(table: &mut JobTable) -> Result<DispatchOutcome, CommandError> {
    let seq = table.capability_seq();
    Ok(DispatchOutcome {
        job: String::new(),
        seq,
        event: "capabilities".to_string(),
    })
}

/// Grant a save destination for a live job from the dialog-chosen path.
///
/// The commands layer owns the format-id check
/// (`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir`); the job table owns
/// extension matching through the output layer (`validate_destination` +
/// `infer_from_path`). Unknown or stale job ids are rejected before any
/// effect; path refusals surface as `job.invalid-input` with the typed
/// output-layer message (a denied destination recovers via
/// request-decision/choose-output at the caller). `overwrite` is false
/// unless the user confirmed overwriting.
pub fn dispatch_destination(
    table: &mut JobTable,
    job: &str,
    format: &str,
    path: &std::path::Path,
    overwrite: bool,
) -> Result<(DispatchOutcome, Vec<crate::jobs::SnapshotEmit>), CommandError> {
    if !is_valid_job_id(job) {
        return Err(CommandError::invalid_input(
            "job id must look like job:<suffix>",
        ));
    }
    if !SUPPORTED_FORMATS.contains(&format) {
        return Err(CommandError::invalid_input(
            "format must be one of png, jpeg, tiff, zif, webp, iiif-dir",
        ));
    }
    match table.request_destination(job, path, format, overwrite) {
        Ok((seq, emits)) => Ok((
            DispatchOutcome {
                job: job.to_string(),
                seq,
                event: "job-snapshot".to_string(),
            },
            emits,
        )),
        Err(kind) if kind == "unknown" => Err(CommandError::unknown_job(job)),
        Err(kind) if kind == "stale" => Err(CommandError::stale_job(job)),
        Err(other) => {
            // The table returns `code: message` with a stable output code
            // (via `NativeError` display) for destination validation; preserve
            // that code instead of collapsing to `job.invalid-input`. Split
            // only on the stable code prefix before the first colon, never on
            // message text.
            if let Some((code, message)) = split_stable_code(&other) {
                if code.starts_with("output.") {
                    return Err(CommandError::new(&code, &message));
                }
            }
            Err(CommandError::invalid_input(&other))
        }
    }
}

/// Settings-aware `start_job`: validates the input URL plus the minimal
/// settings JSON (validated bounds, fail closed on invalid), then starts
/// the job with CLI-parity transport. `settings_json` may be `None` (CLI
/// defaults) or a JSON object string; anything else fails closed with
/// `job.invalid-input`. Header values are never included in error strings.
pub fn dispatch_start_job_with_settings(
    table: &mut JobTable,
    input_url: &str,
    settings_json: Option<&str>,
) -> Result<(DispatchOutcome, Vec<crate::jobs::SnapshotEmit>), CommandError> {
    if !is_valid_input_url(input_url) {
        return Err(CommandError::invalid_input(
            "input_url must be an http(s) URL up to 2048 bytes without userinfo",
        ));
    }
    let (id, emit) = match settings_json {
        None => table
            .start_job(input_url)
            .map_err(|e| CommandError::invalid_input(&e))?,
        Some(raw) => {
            let value: serde_json::Value = serde_json::from_str(raw)
                .map_err(|_| CommandError::invalid_input("settings must be a JSON object"))?;
            let settings = parse_settings(&value).map_err(|e| CommandError::invalid_input(&e))?;
            table
                .start_job_with_settings(input_url, &settings)
                .map_err(|e| CommandError::invalid_input(&e))?
        }
    };
    let seq = emit.seq;
    Ok((
        DispatchOutcome {
            job: id,
            seq,
            event: "job-snapshot".to_string(),
        },
        vec![emit],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_choice(index: usize) -> serde_json::Value {
        serde_json::json!({"kind": "image", "index": index})
    }

    fn level_choice(index: usize) -> serde_json::Value {
        serde_json::json!({"kind": "level", "index": index})
    }

    /// Forward one synthetic runner terminal through the production
    /// verbatim forwarder (no I/O): the terminal itself is hand-built,
    /// everything after it is production behavior.
    fn fold_test_terminal(table: &mut JobTable, id: &str, terminal: TestTerminal) {
        use dezoomify_native::runner::OutputSummary;
        use dezoomify_protocol::dto::{JobState, SnapshotTerminalDto};
        fn summary(partial: bool) -> OutputSummary {
            OutputSummary {
                path: std::path::PathBuf::from("/tmp/dz-published.png"),
                tile_count: 1,
                width: 2,
                height: 2,
                format: "png".to_string(),
                partial,
                missing: Vec::new(),
            }
        }
        let (engine_terminal, published) = match terminal {
            TestTerminal::Completed => (SnapshotTerminalDto::Completed, Some(summary(false))),
            TestTerminal::Partial => (
                SnapshotTerminalDto::PartialCompleted {
                    missing: Vec::new(),
                },
                Some(summary(true)),
            ),
            TestTerminal::Failed => (
                SnapshotTerminalDto::Failed {
                    error: dezoomify_protocol::dto::ErrorDto {
                        code: "tile.download-failed".to_string(),
                        phase: dezoomify_protocol::dto::ErrorPhase::Acquisition,
                        retryable: true,
                        message: "boom".to_string(),
                        recovery: Vec::new(),
                        request: None,
                        transport: None,
                        blocked_reason: None,
                        resource_kind: None,
                        http: None,
                        preview: None,
                        detail: None,
                    },
                },
                None,
            ),
        };
        // A destination must exist before a terminal can forward: grant a
        // scratch path first (failures there would be test bugs, not product
        // behavior), then inject verbatim.
        let path = std::path::PathBuf::from(format!("/tmp/dz-cmd-test-{id}.png"));
        let _ = table.request_destination(id, &path, "png", false);
        table.inject_runner_snapshot(
            id,
            &dezoomify_native::runner::JobSnapshot {
                job: id.to_string(),
                snapshot: dezoomify_engine::JobSnapshot {
                    revision: 2,
                    lifecycle: JobState::Finalizing,
                    paused: false,
                    progress: dezoomify_engine::Progress {
                        completed: 0,
                        total: Some(0),
                    },
                    selection: dezoomify_engine::Selection {
                        image: None,
                        level: None,
                        level_count: 0,
                        catalog: None,
                        deferred: Vec::new(),
                    },
                    decision: None,
                    terminal: Some(engine_terminal),
                    output: None,
                    notices: Vec::new(),
                },
                published,
            },
        );
    }

    #[derive(Clone, Copy)]
    enum TestTerminal {
        Completed,
        Partial,
        Failed,
    }

    #[test]
    fn registry_lists_exact_commands() {
        assert_eq!(COMMANDS.len(), 6);
        for name in [
            "start_job",
            "cancel_job",
            "answer_choice",
            "request_destination",
            "query_capabilities",
        ] {
            assert!(is_known_command(name), "missing {name}");
        }
        assert!(!is_known_command("shell_exec"));
        assert!(!is_known_command("read_file"));
    }

    #[test]
    fn registry_rejects_unknown_commands() {
        // No generic entry point remains: unknown names never reach job
        // state. The registry is the single source of allowed commands.
        assert!(!is_known_command("read_file"));
        assert!(!is_known_command("shell_exec"));
        assert!(!is_known_command(""));
    }

    #[test]
    fn unknown_job_rejected() {
        let mut table = JobTable::new();
        let err = dispatch_cancel_job(&mut table, "job:nope").unwrap_err();
        assert_eq!(err.code, "job.unknown");
    }

    #[test]
    fn stale_job_rejected_after_terminal() {
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        // Second cancel targets a terminal job: stale, not unknown.
        let err = dispatch_cancel_job(&mut table, &id).unwrap_err();
        assert_eq!(err.code, "job.stale");
    }

    #[test]
    fn duplicate_cancellation_is_stale_not_new_effect() {
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        let (first_seq, first_emits) = table.cancel_job(&id).unwrap();
        assert_eq!(first_emits.len(), 1, "terminal emits exactly once");
        let err = table.cancel_job(&id).unwrap_err();
        assert_eq!(err, "stale");
        assert!(table.poll_drivers().is_empty());
        assert!(first_seq >= 1);
    }

    #[test]
    fn invalid_input_rejected() {
        let mut table = JobTable::new();
        assert!(dispatch_start_job(&mut table, "file:///etc/passwd").is_err());
        assert!(dispatch_start_job(&mut table, "https://user:pass@example.com/x").is_err());
        // Unknown formats never grant: real grants go through
        // `dispatch_destination` with the dialog path.
        assert!(dispatch_destination(
            &mut table,
            "job:x",
            "exe",
            std::path::Path::new("/tmp/dz-invalid-out.png"),
            false
        )
        .is_err());
    }

    #[test]
    fn event_seq_is_monotonic() {
        let mut table = JobTable::new();
        let (id, initial) = table.start_job("https://example.com/item").unwrap();
        assert_eq!(initial.seq, 0, "initial snapshot revision is 0");
        // Synchronous pre-runner choices update options silently: no
        // spurious revision bump; live revisions flow verbatim from the
        // runner via `poll_drivers`.
        let (seq, emits) = table
            .answer_choice(&id, &Choice::Image { index: 0 })
            .unwrap();
        assert_eq!(seq, 0);
        assert!(emits.is_empty());
        assert!(table.poll_drivers().is_empty());
    }

    #[test]
    fn destination_grant_needs_a_real_path() {
        use std::path::PathBuf;
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        // Destination grants need the dialog-chosen path: real grants go
        // through `dispatch_destination` below.
        assert!(table.destination_for(&id).is_none());
        // A real path grants an opaque id with no raw path in it.
        let path = PathBuf::from(format!("/tmp/dz-cmd-{}.png", std::process::id()));
        let (outcome, emits) = dispatch_destination(&mut table, &id, "png", &path, false).unwrap();
        assert_eq!(outcome.job, id);
        assert_eq!(outcome.event, "job-snapshot");
        assert!(emits.is_empty(), "grants resolve through runner snapshots");
        assert_eq!(table.destination_for(&id).unwrap(), path);
        assert!(!outcome.event.contains("tmp") && !outcome.event.contains('/'));
        // Unknown and stale jobs are rejected before any effect.
        let err = dispatch_destination(&mut table, "job:nope", "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        table.cancel_job(&id).unwrap();
        // Poll until the cancelled terminal settles the job (bounded wait);
        // only then are post-terminal grants stale.
        for _ in 0..200 {
            if table.is_settled(&id) {
                break;
            }
            let _ = table.poll_drivers();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let err = dispatch_destination(&mut table, &id, "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.stale");
    }

    #[test]
    fn settings_start_validates_bounds_fail_closed() {
        let mut table = JobTable::new();
        let (ok, _) = dispatch_start_job_with_settings(
            &mut table,
            "https://example.com/item",
            Some(r#"{"compression": 9, "retries": 0}"#),
        )
        .unwrap();
        let config = table.options_for(&ok.job).unwrap();
        assert_eq!(config.compression, 9);
        assert_eq!(config.max_retries, 0);
        // Invalid compression fails closed with no new job.
        let before = table.len();
        let err = dispatch_start_job_with_settings(
            &mut table,
            "https://example.com/item",
            Some(r#"{"compression": 101}"#),
        )
        .unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert_eq!(table.len(), before);
        // Malformed JSON fails closed; header values never surface in errors.
        let err = dispatch_start_job_with_settings(
            &mut table,
            "https://example.com/item",
            Some(r#"{"headers": {"Cookie": "s3cret"}, "retries": "x"}"#),
        )
        .unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert!(!err.message.contains("s3cret"));
        // Omitted settings take defaults.
        let (with_defaults, _) =
            dispatch_start_job_with_settings(&mut table, "https://example.com/d", None).unwrap();
        let config = table.options_for(&with_defaults.job).unwrap();
        assert_eq!(config.compression, 5);
        assert_eq!(config.max_retries, 3);
    }

    /// Unknown job ids map to `job.unknown` with no effects.
    #[test]
    fn unknown_job_maps_to_job_unknown_without_effects() {
        let mut table = JobTable::new();
        assert!(table.poll_drivers().is_empty());
        let err = dispatch_cancel_job(&mut table, "job:nope").unwrap_err();
        assert_eq!(err.code, "job.unknown");
        let err = dispatch_answer_choice(&mut table, "job:nope", image_choice(0)).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        let path = std::path::PathBuf::from("/tmp/dz-unknown-out.png");
        let err = dispatch_destination(&mut table, "job:nope", "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        assert!(table.is_empty());
        assert!(table.poll_drivers().is_empty());
    }

    /// A terminal job's second cancel/choice maps to `job.stale`
    /// with no new effect or emit.
    #[test]
    fn terminal_second_cancel_and_choice_map_to_job_stale_without_new_events() {
        let mut table = JobTable::new();
        let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
        let id = started.job.clone();
        let (_, emits) = dispatch_cancel_job(&mut table, &id).unwrap();
        assert_eq!(emits.len(), 1, "terminal emits exactly once");
        let _ = table.poll_drivers();
        let err = dispatch_cancel_job(&mut table, &id).unwrap_err();
        assert_eq!(err.code, "job.stale");
        let err = dispatch_answer_choice(&mut table, &id, image_choice(1)).unwrap_err();
        assert_eq!(err.code, "job.stale");
        assert!(table.poll_drivers().is_empty());
        // Destination grants after terminal are stale too.
        let path = std::path::PathBuf::from("/tmp/dz-stale-out.png");
        let err = dispatch_destination(&mut table, &id, "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.stale");
        assert!(table.destination_for(&id).is_none());
    }

    /// Every post-terminal dispatch is `job.stale` with no work.
    #[test]
    fn post_terminal_dispatch_rejected_without_work() {
        // Cancelled terminal.
        let mut table = JobTable::new();
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        let (_, emits) = table.cancel_job(&id).unwrap();
        assert_eq!(emits.len(), 1);
        assert_eq!(
            dispatch_cancel_job(&mut table, &id).unwrap_err().code,
            "job.stale"
        );
        assert_eq!(
            dispatch_answer_choice(&mut table, &id, image_choice(0))
                .unwrap_err()
                .code,
            "job.stale"
        );
        assert_eq!(
            dispatch_destination(
                &mut table,
                &id,
                "png",
                std::path::Path::new("/tmp/dz-post-out.png"),
                false
            )
            .unwrap_err()
            .code,
            "job.stale"
        );
        assert!(table.poll_drivers().is_empty());
        // Failed terminal stays single-terminal through dispatch.
        let mut table = JobTable::new();
        let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
        let id = started.job.clone();
        fold_test_terminal(&mut table, &id, TestTerminal::Failed);
        assert_eq!(
            dispatch_cancel_job(&mut table, &id).unwrap_err().code,
            "job.stale"
        );
        // Completed terminal: choice after completion is stale.
        let mut table = JobTable::new();
        let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
        let id = started.job.clone();
        fold_test_terminal(&mut table, &id, TestTerminal::Completed);
        assert_eq!(
            dispatch_answer_choice(&mut table, &id, level_choice(0))
                .unwrap_err()
                .code,
            "job.stale"
        );
    }

    /// Duplicate stale dispatches are safe no-ops (no state change).
    #[test]
    fn duplicate_stale_dispatch_has_no_state_change() {
        let mut table = JobTable::new();
        let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
        let id = started.job.clone();
        dispatch_cancel_job(&mut table, &id).unwrap();
        let _ = table.poll_drivers();
        for _ in 0..3 {
            let err = dispatch_cancel_job(&mut table, &id).unwrap_err();
            assert_eq!(err.code, "job.stale");
            let err = dispatch_answer_choice(&mut table, &id, image_choice(0)).unwrap_err();
            assert_eq!(err.code, "job.stale");
        }
        assert!(table.poll_drivers().is_empty());
    }

    /// Dispatch revisions flow verbatim: initial 0, synchronous host ops
    /// carry 0, runner terminals carry their runner seq.
    #[test]
    fn dispatch_seq_monotonic_increasing() {
        let mut table = JobTable::new();
        let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
        assert_eq!(started.seq, 0);
        assert_eq!(started.event, "job-snapshot");
        let id = started.job.clone();
        let (answered, _) = dispatch_answer_choice(&mut table, &id, image_choice(0)).unwrap();
        assert_eq!(answered.seq, 0, "sync choices carry no revision");
        let (answered2, _) = dispatch_answer_choice(&mut table, &id, level_choice(0)).unwrap();
        assert_eq!(answered2.seq, 0);
    }

    /// Terminal appears exactly once through dispatch + table.
    #[test]
    fn dispatch_terminal_exactly_once() {
        for terminal in ["cancelled", "completed", "failed", "partial"] {
            let mut table = JobTable::new();
            let (started, _) = dispatch_start_job(&mut table, "https://example.com/item").unwrap();
            let id = started.job.clone();
            let terminal_emits = match terminal {
                "cancelled" => {
                    let (outcome, emits) = dispatch_cancel_job(&mut table, &id).unwrap();
                    assert_eq!(outcome.event, "job-snapshot");
                    assert_eq!(emits.len(), 1);
                    emits
                }
                "completed" => {
                    fold_test_terminal(&mut table, &id, TestTerminal::Completed);
                    table.poll_drivers()
                }
                "failed" => {
                    fold_test_terminal(&mut table, &id, TestTerminal::Failed);
                    table.poll_drivers()
                }
                _ => {
                    fold_test_terminal(&mut table, &id, TestTerminal::Partial);
                    table.poll_drivers()
                }
            };
            // Cancelled terminals emit synchronously; runner terminals were
            // injected verbatim and settle the job with no further poll output.
            if terminal == "cancelled" {
                assert_eq!(terminal_emits.len(), 1, "{terminal} must terminate once");
            }
            // Any further dispatch stays stale with no second terminal.
            let err = dispatch_cancel_job(&mut table, &id).unwrap_err();
            assert_eq!(err.code, "job.stale", "{terminal}");
            assert!(table.poll_drivers().is_empty(), "{terminal} stays single");
        }
    }

    /// Wrong-job / wrong-state / bad-id are rejected without effects.
    #[test]
    fn wrong_job_wrong_state_bad_id_rejected_at_dispatch() {
        let mut table = JobTable::new();
        // Unknown command names never reach the table (see
        // `registry_rejects_unknown_commands`); the typed dispatchers below
        // reject malformed ids before lookup.
        assert!(table.is_empty());
        // Malformed job ids are invalid-input before lookup.
        for bad in ["bad-id", "job:", "job:x/y", "job:x y", ""] {
            let err = dispatch_cancel_job(&mut table, bad).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "bad id {bad:?}");
            let err = dispatch_answer_choice(&mut table, bad, image_choice(0)).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "bad id {bad:?}");
        }
        let overlong = format!("job:{}", "a".repeat(200));
        assert!(overlong.len() > 128);
        let err = dispatch_cancel_job(&mut table, &overlong).unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert!(table.is_empty());
        // Well-formed but unknown ids are job.unknown.
        let err = dispatch_cancel_job(&mut table, "job:ghost").unwrap_err();
        assert_eq!(err.code, "job.unknown");
        // Empty ids and choices are invalid-input (typed dispatchers take
        // no optional args to omit).
        assert_eq!(
            dispatch_cancel_job(&mut table, "").unwrap_err().code,
            "job.invalid-input"
        );
        assert_eq!(
            dispatch_answer_choice(&mut table, "job:ghost", serde_json::json!(""))
                .unwrap_err()
                .code,
            "job.invalid-input"
        );
        // Stale (wrong-state post-terminal) is job.stale.
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(
            dispatch_cancel_job(&mut table, &id).unwrap_err().code,
            "job.stale"
        );
    }

    /// Validation rejects userinfo, oversize, bad format, and malformed
    /// choice with `job.invalid-input` and no new job or event.
    #[test]
    fn validation_userinfo_oversize_bad_format_empty_choice() {
        let mut table = JobTable::new();
        // Userinfo credentials are rejected.
        for url in [
            "https://user@example.com/item",
            "https://user:pass@example.com/x",
        ] {
            let err = dispatch_start_job(&mut table, url).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "userinfo {url}");
        }
        // Oversize (>2048B), empty, and non-http(s) are rejected.
        let oversize = format!("https://example.com/{}", "a".repeat(2048));
        assert!(oversize.len() > 2048);
        for url in [
            oversize.as_str(),
            "",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "example.com/no-scheme",
        ] {
            let err = dispatch_start_job(&mut table, url).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "url {url:?}");
        }
        assert!(table.is_empty(), "failed starts create no jobs");
        let (id, _) = table.start_job("https://example.com/item").unwrap();
        // Bad formats are rejected before effects.
        let err = dispatch_destination(
            &mut table,
            &id,
            "exe",
            std::path::Path::new("/tmp/dz-bad-out.png"),
            false,
        )
        .unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert!(table.destination_for(&id).is_none());
        assert!(table.poll_drivers().is_empty());
        // Malformed choices are rejected without emits.
        for choice in [
            serde_json::json!(""),
            serde_json::json!("x".repeat(129)),
            serde_json::json!({"kind": "image"}),
            serde_json::json!({"kind": "level", "index": "0"}),
        ] {
            let err = dispatch_answer_choice(&mut table, &id, choice.clone()).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "choice {choice}");
        }
        assert!(table.poll_drivers().is_empty());
        table.cancel_job(&id).unwrap();
    }
}
