// Desktop Tauri command registry (lean shell, standard library only).
//
// Allowed commands: start_job, cancel_job, answer_choice,
// request_destination, query_capabilities. Every job-scoped command carries a
// typed job id; unknown or stale job ids are rejected before any effect.
// Events are ordered per job with a monotonic seq; terminal events appear
// exactly once. No tile bytes cross IPC, only protocol progress and events.

use crate::jobs::JobTable;
use crate::settings::parse_settings;

macro_rules! command_names {
    ($($command:ident),* $(,)?) => {
        &[$(stringify!($command)),*]
    };
}

/// Exact command registry, derived from `desktop_commands.rs`.
pub const COMMANDS: &[&str] = desktop_commands!(command_names);

/// Supported output formats for request_destination: the five single-file
/// native encoders plus the `iiif-dir` tile-tree destination (todo 5.1
/// desktop GUI encoder parity with the CLI/native output layer).
pub const SUPPORTED_FORMATS: &[&str] = &["png", "jpeg", "tiff", "zif", "webp", "iiif-dir"];

/// Explicit window-E2E flag. The real-window harness (`cargo xtask test
/// desktop --e2e-window`) sets this to `"1"` alongside
/// `DEZOOMIFY_E2E_FIXED_DESTINATION`; production never sets it, so the
/// native save dialog always shows there.
pub const E2E_WINDOW_FLAG: &str = "DEZOOMIFY_E2E_WINDOW";

/// Fixed save destination for the real-window harness. Honored only together
/// with [`E2E_WINDOW_FLAG`], so `request_destination` can grant without the
/// native save dialog, which WebDriver cannot operate.
pub const E2E_FIXED_DESTINATION: &str = "DEZOOMIFY_E2E_FIXED_DESTINATION";

/// Window-E2E fixed destination from explicit values (pure, for testability).
/// Returns the fixed path only when the explicit E2E flag is `"1"` and the
/// destination is non-empty; `None` otherwise, so callers always fall back
/// to the native save dialog unless both are set.
pub fn e2e_fixed_destination_from(
    flag: Option<&str>,
    destination: Option<&str>,
) -> Option<std::path::PathBuf> {
    if flag != Some("1") {
        return None;
    }
    let raw = destination.filter(|raw| !raw.is_empty())?;
    Some(std::path::PathBuf::from(raw))
}

/// Window-E2E fixed destination from the process environment. Fail-closed:
/// `None` unless both [`E2E_WINDOW_FLAG`] (`"1"`) and
/// [`E2E_FIXED_DESTINATION`] (non-empty path) are set, so production
/// behavior is unchanged when either is unset.
pub fn e2e_fixed_destination() -> Option<std::path::PathBuf> {
    e2e_fixed_destination_from(
        std::env::var(E2E_WINDOW_FLAG).ok().as_deref(),
        std::env::var(E2E_FIXED_DESTINATION).ok().as_deref(),
    )
}

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

/// Outcome of a validated dispatch; `events` are already ordered by seq.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub job: String,
    pub seq: u64,
    pub event: String,
}

/// Validate and dispatch one command against the job table.
///
/// - Unknown command names are rejected before touching job state.
/// - Job-scoped commands reject unknown job ids (never created or closed
///   window) and stale job ids (already terminal) without new effects.
/// - `seq` ordering is owned by the job table; this layer only forwards the
///   ordered event for the creating window/session scope.
/// - Settings-aware `start_job` goes through
///   [`dispatch_start_job_with_settings`]; plain `dispatch` keeps
///   CLI-matching defaults.
pub fn dispatch(
    table: &mut JobTable,
    command: &str,
    job: Option<&str>,
    arg: Option<&str>,
) -> Result<DispatchOutcome, CommandError> {
    if !is_known_command(command) {
        return Err(CommandError::unknown_command(command));
    }
    match command {
        "query_capabilities" => {
            let seq = table.capability_seq();
            Ok(DispatchOutcome {
                job: String::new(),
                seq,
                event: "capabilities".to_string(),
            })
        }
        "start_job" => {
            let input_url =
                arg.ok_or_else(|| CommandError::invalid_input("start_job needs an input_url"))?;
            if !is_valid_input_url(input_url) {
                return Err(CommandError::invalid_input(
                    "input_url must be an http(s) URL up to 2048 bytes without userinfo",
                ));
            }
            let id = table
                .start_job(input_url)
                .map_err(|e| CommandError::invalid_input(&e))?;
            let seq = table.last_seq(&id).unwrap_or(1);
            Ok(DispatchOutcome {
                job: id,
                seq,
                event: "job-state:discovering".to_string(),
            })
        }
        "cancel_job" => {
            let id = job.ok_or_else(|| CommandError::invalid_input("cancel_job needs a job id"))?;
            if !is_valid_job_id(id) {
                return Err(CommandError::invalid_input(
                    "job id must look like job:<suffix>",
                ));
            }
            match table.cancel_job(id) {
                Ok(seq) => Ok(DispatchOutcome {
                    job: id.to_string(),
                    seq,
                    event: "cancelled".to_string(),
                }),
                Err(kind) if kind == "unknown" => Err(CommandError::unknown_job(id)),
                Err(kind) if kind == "stale" => Err(CommandError::stale_job(id)),
                Err(other) => Err(CommandError::invalid_input(&other)),
            }
        }
        "answer_choice" => {
            let id =
                job.ok_or_else(|| CommandError::invalid_input("answer_choice needs a job id"))?;
            let choice =
                arg.ok_or_else(|| CommandError::invalid_input("answer_choice needs a choice"))?;
            if !is_valid_job_id(id) {
                return Err(CommandError::invalid_input(
                    "job id must look like job:<suffix>",
                ));
            }
            if choice.is_empty() || choice.len() > 128 {
                return Err(CommandError::invalid_input("choice must be 1..128 bytes"));
            }
            match table.answer_choice(id, choice) {
                Ok((seq, event)) => Ok(DispatchOutcome {
                    job: id.to_string(),
                    seq,
                    event,
                }),
                Err(kind) if kind == "unknown" => Err(CommandError::unknown_job(id)),
                Err(kind) if kind == "stale" => Err(CommandError::stale_job(id)),
                Err(other) => Err(CommandError::invalid_input(&other)),
            }
        }
        "request_destination" => {
            let id = job
                .ok_or_else(|| CommandError::invalid_input("request_destination needs a job id"))?;
            let format = arg
                .ok_or_else(|| CommandError::invalid_input("request_destination needs a format"))?;
            if !is_valid_job_id(id) {
                return Err(CommandError::invalid_input(
                    "job id must look like job:<suffix>",
                ));
            }
            if !SUPPORTED_FORMATS.contains(&format) {
                return Err(CommandError::invalid_input(
                    "format must be one of png, jpeg, tiff, zif, webp, iiif-dir",
                ));
            }
            // Real destination ONLY: grants need the dialog-chosen file path
            // plus the overwrite policy, which do not fit the generic
            // `(command, job, arg)` shape. Callers grant through
            // `dispatch_destination`; this arm keeps the commands-layer
            // format check and fails closed without effects.
            Err(CommandError::invalid_input(
                "request_destination needs a file path (grant through the save dialog)",
            ))
        }
        other => Err(CommandError::unknown_command(other)),
    }
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
) -> Result<DispatchOutcome, CommandError> {
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
        Ok((seq, event)) => Ok(DispatchOutcome {
            job: job.to_string(),
            seq,
            event,
        }),
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
) -> Result<DispatchOutcome, CommandError> {
    if !is_valid_input_url(input_url) {
        return Err(CommandError::invalid_input(
            "input_url must be an http(s) URL up to 2048 bytes without userinfo",
        ));
    }
    let id = match settings_json {
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
    let seq = table.last_seq(&id).unwrap_or(1);
    Ok(DispatchOutcome {
        job: id,
        seq,
        event: "job-state:discovering".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn unknown_command_rejected_before_state() {
        let mut table = JobTable::new();
        let err = dispatch(&mut table, "read_file", None, None).unwrap_err();
        assert_eq!(err.code, "command.unknown");
    }

    #[test]
    fn unknown_job_rejected() {
        let mut table = JobTable::new();
        let err = dispatch(&mut table, "cancel_job", Some("job:nope"), None).unwrap_err();
        assert_eq!(err.code, "job.unknown");
    }

    #[test]
    fn stale_job_rejected_after_terminal() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        // Second cancel targets a terminal job: stale, not unknown.
        let err = dispatch(&mut table, "cancel_job", Some(&id), None).unwrap_err();
        assert_eq!(err.code, "job.stale");
    }

    #[test]
    fn duplicate_cancellation_is_stale_not_new_effect() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        let first = table.cancel_job(&id).unwrap();
        let events_after_first = table.events_for(&id).len();
        let err = table.cancel_job(&id).unwrap_err();
        assert_eq!(err, "stale");
        assert_eq!(table.events_for(&id).len(), events_after_first);
        assert!(first >= 1);
    }

    #[test]
    fn invalid_input_rejected() {
        let mut table = JobTable::new();
        assert!(dispatch(&mut table, "start_job", None, Some("file:///etc/passwd")).is_err());
        assert!(dispatch(
            &mut table,
            "start_job",
            None,
            Some("https://user:pass@example.com/x")
        )
        .is_err());
        assert!(dispatch(
            &mut table,
            "request_destination",
            Some("job:x"),
            Some("exe")
        )
        .is_err());
    }

    #[test]
    fn event_seq_is_monotonic() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        let s1 = table.last_seq(&id).unwrap();
        table.answer_choice(&id, "img:0").unwrap();
        let s2 = table.last_seq(&id).unwrap();
        assert!(s2 > s1, "seq must increase: {s1} -> {s2}");
    }

    #[test]
    fn destination_grant_needs_a_real_path() {
        use std::path::PathBuf;
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        // The generic shape keeps the format check but cannot grant: real
        // grants go through `dispatch_destination` with the dialog path.
        let err = dispatch(&mut table, "request_destination", Some(&id), Some("png")).unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert!(table.destination_for(&id).is_none());
        // A real path grants an opaque id with no raw path in it.
        let path = PathBuf::from(format!("/tmp/dz-cmd-{}.png", std::process::id()));
        let outcome = dispatch_destination(&mut table, &id, "png", &path, false).unwrap();
        assert_eq!(outcome.job, id);
        assert_eq!(table.destination_for(&id).unwrap(), path);
        assert!(!outcome.event.contains("tmp") && !outcome.event.contains('/'));
        // Unknown and stale jobs are rejected before any effect.
        let err = dispatch_destination(&mut table, "job:nope", "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        table.cancel_job(&id).unwrap();
        let err = dispatch_destination(&mut table, &id, "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.stale");
    }

    #[test]
    fn settings_start_validates_bounds_fail_closed() {
        let mut table = JobTable::new();
        let ok = dispatch_start_job_with_settings(
            &mut table,
            "https://example.com/item",
            Some(r#"{"compression": 9, "retries": 0}"#),
        )
        .unwrap();
        let config = table.config_for(&ok.job).unwrap();
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
        let with_defaults =
            dispatch_start_job_with_settings(&mut table, "https://example.com/d", None).unwrap();
        let config = table.config_for(&with_defaults.job).unwrap();
        assert_eq!(config.compression, 5);
        assert_eq!(config.max_retries, 3);
    }

    /// Task 6.1: unknown job ids map to `job.unknown` with no effects.
    #[test]
    fn unknown_job_maps_to_job_unknown_without_effects() {
        let mut table = JobTable::new();
        let pending_before = table.drain_pending().len();
        assert_eq!(pending_before, 0);
        let err = dispatch(&mut table, "cancel_job", Some("job:nope"), None).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        let err =
            dispatch(&mut table, "answer_choice", Some("job:nope"), Some("img:0")).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        let path = std::path::PathBuf::from("/tmp/dz-unknown-out.png");
        let err = dispatch_destination(&mut table, "job:nope", "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        assert!(table.is_empty());
        assert!(table.drain_pending().is_empty());
    }

    /// Task 6.1: a terminal job's second cancel/choice maps to `job.stale`
    /// with no new effect or event.
    #[test]
    fn terminal_second_cancel_and_choice_map_to_job_stale_without_new_events() {
        let mut table = JobTable::new();
        let started = dispatch(
            &mut table,
            "start_job",
            None,
            Some("https://example.com/item"),
        )
        .unwrap();
        let id = started.job.clone();
        dispatch(&mut table, "cancel_job", Some(&id), None).unwrap();
        let events_before = table.events_for(&id).len();
        let seq_before = table.last_seq(&id).unwrap();
        let _ = table.drain_pending();
        let err = dispatch(&mut table, "cancel_job", Some(&id), None).unwrap_err();
        assert_eq!(err.code, "job.stale");
        let err = dispatch(&mut table, "answer_choice", Some(&id), Some("img:1")).unwrap_err();
        assert_eq!(err.code, "job.stale");
        assert_eq!(table.events_for(&id).len(), events_before);
        assert_eq!(table.last_seq(&id), Some(seq_before));
        assert!(table.drain_pending().is_empty());
        // Destination grants after terminal are stale too.
        let path = std::path::PathBuf::from("/tmp/dz-stale-out.png");
        let err = dispatch_destination(&mut table, &id, "png", &path, false).unwrap_err();
        assert_eq!(err.code, "job.stale");
        assert!(table.destination_for(&id).is_none());
    }

    /// Task 6.1: every post-terminal dispatch is `job.stale` with no work.
    #[test]
    fn post_terminal_dispatch_rejected_without_work() {
        // Cancelled terminal.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        let events_before = table.events_for(&id).len();
        let seq_before = table.last_seq(&id).unwrap();
        assert_eq!(
            dispatch(&mut table, "cancel_job", Some(&id), None)
                .unwrap_err()
                .code,
            "job.stale"
        );
        assert_eq!(
            dispatch(&mut table, "answer_choice", Some(&id), Some("img:0"))
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
        assert_eq!(table.events_for(&id).len(), events_before);
        assert_eq!(table.last_seq(&id), Some(seq_before));
        // Failed terminal stays single-terminal through dispatch.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table
            .fail_test_job(&id, "tile.download-failed", "boom")
            .unwrap();
        let failed_count = table
            .events_for(&id)
            .iter()
            .filter(|e| e.kind == "failed")
            .count();
        assert_eq!(failed_count, 1);
        assert_eq!(
            dispatch(&mut table, "cancel_job", Some(&id), None)
                .unwrap_err()
                .code,
            "job.stale"
        );
        assert_eq!(
            table
                .events_for(&id)
                .iter()
                .filter(|e| e.kind == "failed")
                .count(),
            1
        );
        // Completed terminal: choice after completion is stale.
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.complete_job(&id).unwrap();
        assert_eq!(
            dispatch(&mut table, "answer_choice", Some(&id), Some("lvl:0"))
                .unwrap_err()
                .code,
            "job.stale"
        );
    }

    /// Task 6.1: duplicate stale dispatches are safe no-ops (no state change).
    #[test]
    fn duplicate_stale_dispatch_has_no_state_change() {
        let mut table = JobTable::new();
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        let events_before = table.events_for(&id).len();
        let seq_before = table.last_seq(&id).unwrap();
        let _ = table.drain_pending();
        for _ in 0..3 {
            let err = dispatch(&mut table, "cancel_job", Some(&id), None).unwrap_err();
            assert_eq!(err.code, "job.stale");
            let err = dispatch(&mut table, "answer_choice", Some(&id), Some("img:0")).unwrap_err();
            assert_eq!(err.code, "job.stale");
        }
        assert_eq!(table.events_for(&id).len(), events_before);
        assert_eq!(table.last_seq(&id), Some(seq_before));
        assert!(table.drain_pending().is_empty());
    }

    /// Task 6.1: dispatch seq is monotonic increasing.
    #[test]
    fn dispatch_seq_monotonic_increasing() {
        let mut table = JobTable::new();
        let started = dispatch(
            &mut table,
            "start_job",
            None,
            Some("https://example.com/item"),
        )
        .unwrap();
        assert_eq!(started.seq, 1);
        let id = started.job.clone();
        let answered = dispatch(&mut table, "answer_choice", Some(&id), Some("img:0")).unwrap();
        assert!(answered.seq > started.seq, "choice must bump seq");
        let answered2 = dispatch(&mut table, "answer_choice", Some(&id), Some("lvl:0")).unwrap();
        assert!(answered2.seq > answered.seq, "second choice must bump seq");
        assert_eq!(table.last_seq(&id), Some(answered2.seq));
    }

    /// Task 6.1: terminal appears exactly once through dispatch + table.
    #[test]
    fn dispatch_terminal_exactly_once() {
        for terminal in ["cancelled", "completed", "failed", "partial"] {
            let mut table = JobTable::new();
            let started = dispatch(
                &mut table,
                "start_job",
                None,
                Some("https://example.com/item"),
            )
            .unwrap();
            let id = started.job.clone();
            match terminal {
                "cancelled" => {
                    let outcome = dispatch(&mut table, "cancel_job", Some(&id), None).unwrap();
                    assert_eq!(outcome.event, "cancelled");
                }
                "completed" => {
                    table.complete_job(&id).unwrap();
                }
                "failed" => {
                    table
                        .fail_test_job(&id, "tile.download-failed", "boom")
                        .unwrap();
                }
                _ => {
                    table
                        .complete_partial_test_output(&id, "sha256:abc", "png", 2, 2, 1)
                        .unwrap();
                }
            }
            let events = table.events_for(&id);
            let terminals: Vec<_> = events
                .iter()
                .filter(|e| {
                    matches!(
                        e.kind.as_str(),
                        "completed"
                            | "partial-completed"
                            | "partial_completed"
                            | "cancelled"
                            | "failed"
                    )
                })
                .collect();
            assert_eq!(terminals.len(), 1, "{terminal} must terminate once");
            // Any further dispatch stays stale with no second terminal.
            let err = dispatch(&mut table, "cancel_job", Some(&id), None).unwrap_err();
            assert_eq!(err.code, "job.stale", "{terminal}");
            let events = table.events_for(&id);
            let again: Vec<_> = events
                .iter()
                .filter(|e| {
                    matches!(
                        e.kind.as_str(),
                        "completed"
                            | "partial-completed"
                            | "partial_completed"
                            | "cancelled"
                            | "failed"
                    )
                })
                .collect();
            assert_eq!(again.len(), 1, "{terminal} stays single");
        }
    }

    /// Task 6.1: wrong-job / wrong-state / bad-id are rejected without effects.
    #[test]
    fn wrong_job_wrong_state_bad_id_rejected_at_dispatch() {
        let mut table = JobTable::new();
        // Unknown command never touches job state.
        let err = dispatch(&mut table, "read_file", None, None).unwrap_err();
        assert_eq!(err.code, "command.unknown");
        assert!(table.is_empty());
        // Malformed job ids are invalid-input before lookup.
        for bad in ["bad-id", "job:", "job:x/y", "job:x y", ""] {
            let err = dispatch(&mut table, "cancel_job", Some(bad), None).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "bad id {bad:?}");
            let err = dispatch(&mut table, "answer_choice", Some(bad), Some("img:0")).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "bad id {bad:?}");
        }
        let overlong = format!("job:{}", "a".repeat(200));
        assert!(overlong.len() > 128);
        let err = dispatch(&mut table, "cancel_job", Some(&overlong), None).unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        assert!(table.is_empty());
        // Well-formed but unknown ids are job.unknown.
        let err = dispatch(&mut table, "cancel_job", Some("job:ghost"), None).unwrap_err();
        assert_eq!(err.code, "job.unknown");
        // Missing job/arg is invalid-input.
        assert_eq!(
            dispatch(&mut table, "cancel_job", None, None)
                .unwrap_err()
                .code,
            "job.invalid-input"
        );
        assert_eq!(
            dispatch(&mut table, "answer_choice", Some("job:ghost"), None)
                .unwrap_err()
                .code,
            "job.invalid-input"
        );
        // Stale (wrong-state post-terminal) is job.stale.
        let id = table.start_job("https://example.com/item").unwrap();
        table.cancel_job(&id).unwrap();
        assert_eq!(
            dispatch(&mut table, "cancel_job", Some(&id), None)
                .unwrap_err()
                .code,
            "job.stale"
        );
    }

    /// Task 6.1: validation rejects userinfo, oversize, bad format, and empty
    /// choice with `job.invalid-input` and no new job or event.
    #[test]
    fn validation_userinfo_oversize_bad_format_empty_choice() {
        let mut table = JobTable::new();
        // Userinfo credentials are rejected.
        for url in [
            "https://user@example.com/item",
            "https://user:pass@example.com/x",
        ] {
            let err = dispatch(&mut table, "start_job", None, Some(url)).unwrap_err();
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
            let err = dispatch(&mut table, "start_job", None, Some(url)).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "url {url:?}");
        }
        assert!(table.is_empty(), "failed starts create no jobs");
        let id = table.start_job("https://example.com/item").unwrap();
        let events_before = table.events_for(&id).len();
        // Bad formats are rejected before effects.
        let err = dispatch(&mut table, "request_destination", Some(&id), Some("exe")).unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
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
        assert_eq!(table.events_for(&id).len(), events_before);
        // Empty and oversize choices are rejected without events.
        for choice in ["", "x".repeat(129).as_str()] {
            let err = dispatch(&mut table, "answer_choice", Some(&id), Some(choice)).unwrap_err();
            assert_eq!(err.code, "job.invalid-input", "choice len {}", choice.len());
        }
        assert_eq!(table.events_for(&id).len(), events_before);
        // Missing choice arg is invalid-input.
        let err = dispatch(&mut table, "answer_choice", Some(&id), None).unwrap_err();
        assert_eq!(err.code, "job.invalid-input");
        table.cancel_job(&id).unwrap();
    }

    /// Window-E2E fixed destination engages only with the explicit flag
    /// plus a non-empty destination; every other combination falls back to
    /// the native save dialog (`None`), so production never changes.
    #[test]
    fn e2e_fixed_destination_needs_flag_and_path() {
        use std::path::PathBuf;
        assert_eq!(
            e2e_fixed_destination_from(Some("1"), Some("/tmp/dz-e2e-out.png")),
            Some(PathBuf::from("/tmp/dz-e2e-out.png"))
        );
        assert_eq!(
            e2e_fixed_destination_from(None, Some("/tmp/dz-e2e-out.png")),
            None
        );
        assert_eq!(
            e2e_fixed_destination_from(Some("0"), Some("/tmp/dz-e2e-out.png")),
            None
        );
        assert_eq!(
            e2e_fixed_destination_from(Some("yes"), Some("/tmp/dz-e2e-out.png")),
            None
        );
        assert_eq!(e2e_fixed_destination_from(Some("1"), None), None);
        assert_eq!(e2e_fixed_destination_from(Some("1"), Some("")), None);
        assert_eq!(e2e_fixed_destination_from(None, None), None);
    }
}
