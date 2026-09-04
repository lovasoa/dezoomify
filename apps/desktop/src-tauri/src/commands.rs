// Desktop Tauri command registry (lean shell, standard library only).
//
// Allowed commands: start_job, cancel_job, answer_choice,
// request_destination, query_capabilities. Every job-scoped command carries a
// typed job id; unknown or stale job ids are rejected before any effect.
// Events are ordered per job with a monotonic seq; terminal events appear
// exactly once. No tile bytes cross IPC, only protocol progress and events.

use crate::jobs::JobTable;

/// Exact command registry. Must match the TypeScript integration
/// DESKTOP_COMMANDS and both generated capability documents.
pub const COMMANDS: &[&str] = &[
    "start_job",
    "cancel_job",
    "answer_choice",
    "request_destination",
    "query_capabilities",
];

/// Supported output formats for request_destination.
pub const SUPPORTED_FORMATS: &[&str] = &["png", "jpeg", "tiff"];

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
            &format!("unknown command {name}; allowed: start_job, cancel_job, answer_choice, request_destination, query_capabilities"),
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
            let input_url = arg.ok_or_else(|| CommandError::invalid_input("start_job needs an input_url"))?;
            if !is_valid_input_url(input_url) {
                return Err(CommandError::invalid_input(
                    "input_url must be an http(s) URL up to 2048 bytes without userinfo",
                ));
            }
            let id = table.start_job(input_url).map_err(|e| CommandError::invalid_input(&e))?;
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
                return Err(CommandError::invalid_input("job id must look like job:<suffix>"));
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
            let id = job.ok_or_else(|| CommandError::invalid_input("answer_choice needs a job id"))?;
            let choice = arg.ok_or_else(|| CommandError::invalid_input("answer_choice needs a choice"))?;
            if !is_valid_job_id(id) {
                return Err(CommandError::invalid_input("job id must look like job:<suffix>"));
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
            let id = job.ok_or_else(|| CommandError::invalid_input("request_destination needs a job id"))?;
            let format = arg.ok_or_else(|| CommandError::invalid_input("request_destination needs a format"))?;
            if !is_valid_job_id(id) {
                return Err(CommandError::invalid_input("job id must look like job:<suffix>"));
            }
            if !SUPPORTED_FORMATS.contains(&format) {
                return Err(CommandError::invalid_input(
                    "format must be one of png, jpeg, tiff",
                ));
            }
            match table.request_destination(id, format) {
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
        other => Err(CommandError::unknown_command(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_exact_commands() {
        assert_eq!(COMMANDS.len(), 5);
        for name in ["start_job", "cancel_job", "answer_choice", "request_destination", "query_capabilities"] {
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
        assert!(dispatch(&mut table, "start_job", None, Some("https://user:pass@example.com/x")).is_err());
        assert!(dispatch(&mut table, "request_destination", Some("job:x"), Some("exe")).is_err());
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
}
