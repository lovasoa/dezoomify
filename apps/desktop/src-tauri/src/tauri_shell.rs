// Real Tauri window shell (behind the `tauri` feature).
//
// One local window (`main`), strict navigation policy from
// tauri.conf.json (no remote IPC access, strict CSP), and the exact five
// commands of the generated capability documents wired to the pure job
// table. No tile bytes cross IPC, only protocol progress and events.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::{self, CommandError};
use crate::jobs::JobTable;

/// Command registry, mirrored from the pure layer for compile-time checks.
const COMMANDS: &[&str] = commands::COMMANDS;

#[derive(Serialize)]
struct CommandFailure {
    code: String,
    message: String,
}

impl From<CommandError> for CommandFailure {
    fn from(err: CommandError) -> Self {
        Self {
            code: err.code,
            message: err.message,
        }
    }
}

#[derive(Serialize)]
struct Dispatched {
    job: String,
    seq: u64,
    event: String,
}

#[derive(Serialize)]
struct DestinationResult {
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Serialize)]
struct CapabilitySnapshot {
    native_available: bool,
    encoders: Vec<String>,
    protocol_min: String,
    protocol_max: String,
    commands: Vec<&'static str>,
}

#[derive(Serialize, Clone)]
struct JobEventPayload {
    job: String,
    seq: u64,
    kind: String,
    detail: String,
}

fn run_dispatch(
    state: &State<'_, Mutex<JobTable>>,
    command: &str,
    job: Option<&str>,
    arg: Option<&str>,
) -> Result<Dispatched, CommandFailure> {
    let mut table = state.lock().map_err(|_| CommandFailure {
        code: "shell.lock".into(),
        message: "job table poisoned".into(),
    })?;
    let outcome = commands::dispatch(&mut table, command, job, arg)?;
    Ok(Dispatched {
        job: outcome.job,
        seq: outcome.seq,
        event: outcome.event,
    })
}

/// Ordered per-job event emission on the shared-UI channels. The shell only
/// produces job-state events; the native runtime owns progress/output/error
/// payloads with the same redaction guarantees.
fn emit_job_state(app: &AppHandle, job: &str, seq: u64, kind: &str, detail: &str) {
    let payload = JobEventPayload {
        job: job.to_string(),
        seq,
        kind: kind.to_string(),
        detail: detail.to_string(),
    };
    let _ = app.emit("dezoomify://job-state", payload);
}

#[tauri::command]
fn start_job(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    input_url: String,
) -> Result<Dispatched, CommandFailure> {
    let dispatched = run_dispatch(&state, "start_job", None, Some(&input_url))?;
    emit_job_state(
        &app,
        &dispatched.job,
        dispatched.seq,
        "job-state",
        "discovering",
    );
    Ok(dispatched)
}

#[tauri::command]
fn cancel_job(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
) -> Result<Dispatched, CommandFailure> {
    let dispatched = run_dispatch(&state, "cancel_job", Some(&job), None)?;
    emit_job_state(&app, &job, dispatched.seq, "cancelled", "cancelled by user");
    Ok(dispatched)
}

#[tauri::command]
fn answer_choice(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
    choice: String,
) -> Result<Dispatched, CommandFailure> {
    let dispatched = run_dispatch(&state, "answer_choice", Some(&job), Some(&choice))?;
    emit_job_state(&app, &job, dispatched.seq, "job-state", "running");
    Ok(dispatched)
}

#[tauri::command]
fn query_capabilities(
    state: State<'_, Mutex<JobTable>>,
) -> Result<CapabilitySnapshot, CommandFailure> {
    run_dispatch(&state, "query_capabilities", None, None)?;
    Ok(CapabilitySnapshot {
        native_available: true,
        encoders: commands::SUPPORTED_FORMATS
            .iter()
            .map(|s| (*s).to_string())
            .collect(),
        protocol_min: "1.0".into(),
        protocol_max: "1.0".into(),
        commands: COMMANDS.to_vec(),
    })
}

/// Native save dialog: shows the real OS dialog off the main thread
/// (async command), then grants the destination through the same validated
/// dispatch as every other command. The chosen path stays native; only the
/// opaque destination handle crosses IPC.
#[tauri::command]
async fn request_destination(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
    format: String,
    suggested_name: String,
) -> Result<DestinationResult, CommandFailure> {
    // Validate before showing any dialog.
    run_dispatch(&state, "request_destination", Some(&job), Some(&format))?;
    let (filter_name, extension): (&str, &str) = match format.as_str() {
        "png" => ("PNG image", "png"),
        "jpeg" => ("JPEG image", "jpg"),
        "tiff" => ("TIFF image", "tif"),
        other => {
            return Err(CommandFailure {
                code: "command.invalid-input".into(),
                message: format!("format must be one of png, jpeg, tiff; got {other}"),
            })
        }
    };
    if suggested_name.contains('\0') || suggested_name.contains("..") {
        return Err(CommandFailure {
            code: "command.invalid-input".into(),
            message: "invalid suggested file name".into(),
        });
    }
    // blocking dialogs must not run on the main thread; async commands run
    // on the async runtime, so this is the sanctioned shape.
    let chosen = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter(filter_name, &[extension])
        .blocking_save_file();
    let Some(path) = chosen else {
        return Ok(DestinationResult {
            outcome: "cancelled",
            destination_id: None,
            reason: Some("user-cancelled".into()),
        });
    };
    let path = path.into_path().map_err(|e| CommandFailure {
        code: "command.invalid-input".into(),
        message: format!("invalid destination path: {e}"),
    })?;
    if path.as_os_str().is_empty() {
        return Ok(DestinationResult {
            outcome: "cancelled",
            destination_id: None,
            reason: Some("user-cancelled".into()),
        });
    }
    // Grant the destination through the validated dispatch; the native
    // runtime reports completion only after atomic output finalization.
    let dispatched = run_dispatch(&state, "request_destination", Some(&job), Some(&format))?;
    emit_job_state(&app, &job, dispatched.seq, "destination", &format);
    Ok(DestinationResult {
        outcome: "granted",
        destination_id: Some(dispatched.event),
        reason: None,
    })
}

/// Run the desktop shell. Exits the process on failure.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The generated capability document grants updater:allow-check; the
        // policy layer (src/updater.rs) validates every candidate against the
        // allowlist, the release key, and anti-rollback before staging.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(JobTable::new()))
        .invoke_handler(tauri::generate_handler![
            start_job,
            cancel_job,
            answer_choice,
            request_destination,
            query_capabilities,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Dezoomify desktop shell");
}
