// Real Tauri window shell (behind the `tauri` feature).
//
// One local window (`main`), strict navigation policy from
// tauri.conf.json (no remote IPC access, strict CSP), and the exact
// commands of the generated capability documents wired to the pure job
// table. No tile bytes cross IPC, only protocol progress and events.
//
// All commands are async Tauri commands over `State<Mutex<JobTable>>` +
// `AppHandle`. The mutex is held only inside the synchronous `run_dispatch`
// helper (never across await/dialog); lifecycle, driver threads,
// `poll_drivers`, and the shared `NativeRuntime` stay owned by `jobs.rs`.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::{self, CommandError};
use crate::deep_link;
use crate::jobs::JobTable;
use crate::settings::parse_settings;
use dezoomify_native::output::{validate_destination, OutputFormat};

/// Command registry, mirrored from the pure layer for compile-time checks.
const COMMANDS: &[&str] = commands::COMMANDS;

#[cfg(all(test, target_os = "linux"))]
mod output_tests {
    use super::launch_saved_output;
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    #[test]
    fn launcher_child() {
        let Some(root) = std::env::var_os("DEZOOMIFY_TEST_LAUNCH_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let image = root.join("saved image.png");
        launch_saved_output(image.clone(), false).unwrap();
        launch_saved_output(image.clone(), true).unwrap();
        fs::remove_file(&image).unwrap();
        assert_eq!(
            launch_saved_output(image.clone(), false).unwrap_err().code,
            "output.not-found"
        );
        // A moved image does not prevent opening its containing directory.
        launch_saved_output(image, true).unwrap();
        fs::write(root.join("gio"), "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(
            launch_saved_output(root.join("missing.png"), true)
                .unwrap_err()
                .code,
            "output.launch-failed"
        );
    }

    #[test]
    fn checks_launcher_exit_status_and_opens_the_containing_directory() {
        let root =
            std::env::temp_dir().join(format!("dezoomify-launch-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("saved image.png"), b"fixture").unwrap();
        // A failing first launcher must fall through to the next supported
        // desktop handler. Only the child process sees this isolated PATH.
        for (name, script) in [
            ("xdg-open", "#!/bin/sh\nexit 1\n"),
            ("gio", "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$DEZOOMIFY_TEST_LAUNCH_ROOT/calls\"\nexit 0\n"),
        ] {
            let path = root.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tauri_shell::output_tests::launcher_child"])
            .env("PATH", &root)
            .env("DEZOOMIFY_TEST_LAUNCH_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        let calls = fs::read_to_string(root.join("calls")).unwrap();
        let expected = [root.join("saved image.png"), root.clone(), root.clone()];
        assert_eq!(
            calls
                .lines()
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>(),
            expected
        );
        fs::remove_dir_all(root).unwrap();
    }
}

/// Open only an output published by this app; callers never supply paths.
#[tauri::command]
async fn open_saved_output(
    table: State<'_, Mutex<JobTable>>,
    job: String,
    reveal: bool,
) -> Result<(), CommandFailure> {
    let path = table
        .lock()
        .ok()
        .and_then(|table| table.saved_output_for(&job))
        .ok_or_else(|| CommandFailure {
            code: "output.unavailable".into(),
            message: "The saved image is unavailable.".into(),
        })?;
    // Launch off the async executor and check the launcher's result. The
    // opener plugin's detached path reports success before the launcher exits;
    // its Linux reveal API also requires a FileManager1/portal D-Bus service.
    // Opening the parent uses the user's default folder handler instead.
    tauri::async_runtime::spawn_blocking(move || launch_saved_output(path, reveal))
        .await
        .map_err(|_| CommandFailure {
            code: "output.launch-task-failed".into(),
            message: "The file-opening task could not finish.".into(),
        })?
}

fn launch_saved_output(path: std::path::PathBuf, reveal: bool) -> Result<(), CommandFailure> {
    let target = if reveal {
        path.parent()
            .ok_or_else(|| CommandFailure {
                code: "output.no-parent".into(),
                message: "The saved image has no containing folder.".into(),
            })?
            .to_path_buf()
    } else {
        path
    };
    std::fs::metadata(&target).map_err(|error| CommandFailure {
        code: if error.kind() == std::io::ErrorKind::NotFound {
            "output.not-found"
        } else {
            "output.not-accessible"
        }
        .into(),
        message: "The saved image or folder is not accessible.".into(),
    })?;
    // `open::that` stops after an installed launcher exits unsuccessfully.
    // Try the remaining platform launchers on both spawn and exit failures.
    for mut command in open::commands(&target) {
        let result = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if result.is_ok_and(|status| status.success()) {
            return Ok(());
        }
    }
    Err(CommandFailure {
        code: "output.launch-failed".into(),
        message: "The system could not launch the default application.".into(),
    })
}

#[derive(Debug, Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

#[derive(Serialize)]
struct CapabilitySnapshot {
    native_available: bool,
    encoders: Vec<String>,
    protocol_min: String,
    protocol_max: String,
    commands: Vec<&'static str>,
}

/// Projected IPC payload shapes. Every job emit carries both `job` and
/// `jobId` aliases plus `seq` so the frontend stale-job and stale-seq guards
/// keep working, alongside the typed fields each channel documents:
/// - `job-state`: `{job,jobId,seq,kind,state,detail,origin}`
/// - `job-progress`: `{job,jobId,seq,kind,state,acquired,total,detail,origin}`
/// - `job-output`: `{job,jobId,seq,kind,state,outputHash,format,width,height,tileCount,detail,origin}`
/// - `job-error`: `{job,jobId,seq,kind,state,code,phase,retryable,recovery,message,detail,origin,transport,resource-kind}`
///
/// Only counts, hashes, codes, and the redacted origin cross IPC; tile
/// bytes, paths, full URLs, and secrets never do. `resource-kind` is emitted
/// alongside the `resource_kind` alias for frontend compatibility.
fn emit_projected(app: &AppHandle, emit: crate::jobs::ProjectedEmit) {
    debug_assert!(!crate::jobs::payload_has_forbidden_keys(&emit.payload));
    let _ = app.emit(emit.channel, emit.payload);
}

/// Drain the table's projected emits and emit each on its channel.
/// Per-job seq stays monotonic (`saturating_add` in `jobs.rs`); terminals
/// were enqueued exactly once and post-terminal messages were ignored, so
/// draining preserves exactly-once terminal delivery.
fn drain_and_emit(app: &AppHandle, table: &mut crate::jobs::JobTable) {
    for emit in table.drain_pending() {
        emit_projected(app, emit);
    }
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

#[tauri::command]
async fn start_job(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    input_url: String,
    settings: Option<serde_json::Value>,
) -> Result<Dispatched, CommandFailure> {
    // Validates `input_url` plus the minimal settings JSON (validated
    // bounds, fail closed on invalid), then spawns the driver via
    // `jobs.rs start_job_with_settings` (CLI-parity transport). Emits the
    // `dezoomify://job-state` discovering event for the new job. Header
    // values never enter logs or error strings.
    if !commands::is_valid_input_url(&input_url) {
        return Err(CommandError::invalid_input(
            "input_url must be an http(s) URL up to 2048 bytes without userinfo",
        )
        .into());
    }
    let dispatched = {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        let id = match settings.as_ref() {
            None => table
                .start_job(&input_url)
                .map_err(|e| CommandError::invalid_input(&e))?,
            Some(value) => {
                let parsed = parse_settings(value).map_err(|e| CommandError::invalid_input(&e))?;
                table
                    .start_job_with_settings(&input_url, &parsed)
                    .map_err(|e| CommandError::invalid_input(&e))?
            }
        };
        let seq = table.last_seq(&id).unwrap_or(1);
        Dispatched {
            job: id,
            seq,
            event: "job-state:discovering".to_string(),
        }
    };
    {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        drain_and_emit(&app, &mut table);
    }
    Ok(dispatched)
}

#[tauri::command]
async fn cancel_job(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
) -> Result<Dispatched, CommandFailure> {
    // Signals `cancel_flag` + the engine `Cancel` transition inside
    // `jobs.rs cancel_job` (via `dispatch`); the `Cancelling`/`CleaningUp`/
    // `Cancelled` chain was enqueued as projected `job-state` emits.
    let dispatched = run_dispatch(&state, "cancel_job", Some(&job), None)?;
    {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        drain_and_emit(&app, &mut table);
    }
    Ok(dispatched)
}

#[tauri::command]
async fn answer_choice(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
    choice: String,
) -> Result<Dispatched, CommandFailure> {
    // Maps `img:`/`lvl:`/`keep`/`discard`/`att:` onto `pipeline_config`
    // inside `jobs.rs answer_choice` (via `dispatch`); the precise
    // `Awaiting*`/`Running` state was enqueued as a projected `job-state`
    // emit with the redacted origin.
    let dispatched = run_dispatch(&state, "answer_choice", Some(&job), Some(&choice))?;
    {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        drain_and_emit(&app, &mut table);
    }
    Ok(dispatched)
}

#[tauri::command]
async fn query_capabilities(
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
/// (async command), validates the chosen path, then grants the real
/// destination through the validated commands-layer dispatch. The chosen
/// path stays native; only the opaque destination handle crosses IPC (never
/// raw paths in events).
#[tauri::command]
async fn request_destination(
    state: State<'_, Mutex<JobTable>>,
    app: AppHandle,
    job: String,
    format: String,
    suggested_name: String,
) -> Result<DestinationResult, CommandFailure> {
    // Format-only validation here with no table side effects (no dialog yet).
    // Path validation after the dialog uses the output layer
    // (`infer_from_path` + `validate_destination`); the grant below
    // re-validates under the lock and preserves
    // unknown/stale/invalid-input codes.
    if !commands::SUPPORTED_FORMATS.contains(&format.as_str()) {
        return Err(CommandError::invalid_input(
            "format must be one of png, jpeg, tiff, zif, webp, iiif-dir",
        )
        .into());
    }
    let (filter_name, extension): (&str, &str) = match format.as_str() {
        "png" => ("PNG image", "png"),
        "jpeg" => ("JPEG image", "jpg"),
        "tiff" => ("TIFF image", "tif"),
        "zif" => ("ZIF pyramid", "zif"),
        "webp" => ("WebP image", "webp"),
        "iiif-dir" | "iiif" => ("IIIF tile tree", "iiif"),
        _ => {
            return Err(CommandError::invalid_input(
                "format must be one of png, jpeg, tiff, zif, webp, iiif-dir",
            )
            .into())
        }
    };
    // Settings-selected output dir seeds the dialog's initial directory; the
    // user still picks the exact file. Read without holding the lock across
    // the blocking dialog.
    let output_dir = {
        let table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        table.output_dir_for(&job)
    };
    // Blocking dialogs must not run on the main thread; async commands run on
    // the async runtime, so this is the sanctioned shape.
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter(filter_name, &[extension]);
    if let Some(dir) = output_dir.as_deref() {
        dialog = dialog.set_directory(dir);
    }
    let chosen = dialog.blocking_save_file();
    let Some(path) = chosen else {
        return Ok(DestinationResult {
            outcome: "cancelled",
            destination_id: None,
            reason: Some("user-cancelled".into()),
            code: None,
        });
    };
    let path = path.into_path().map_err(|_| CommandFailure {
        code: "command.invalid-input".into(),
        message: "invalid destination path".into(),
    })?;
    if path.as_os_str().is_empty() {
        return Ok(DestinationResult {
            outcome: "cancelled",
            destination_id: None,
            reason: Some("user-cancelled".into()),
            code: None,
        });
    }
    // Real-destination validation before any work: infer the format from the
    // dialog path extension (`.png` -> PNG, `.jpg`/`.jpeg` -> JPEG,
    // `.tif`/`.tiff` -> TIFF, `.zif` -> ZIF pyramid, `.webp` -> lossless
    // WebP, `.iiif`/extensionless/existing directory -> `iiif-dir`, anything
    // else a typed error), then enforce the extension/format match with
    // overwrite=false. No overwrite confirmation UI exists yet, so an
    // existing destination is denied for choose-output recovery instead of
    // replaced. Denials carry the typed output-layer reason with no table
    // side effects; the raw path never leaves the host.
    let requested = match format.as_str() {
        "png" => OutputFormat::Png,
        "jpeg" => OutputFormat::Jpeg,
        "tiff" => OutputFormat::Tiff,
        "zif" => OutputFormat::Zif,
        "webp" => OutputFormat::Webp,
        "iiif-dir" | "iiif" => OutputFormat::IiifDir,
        _ => {
            return Err(CommandError::invalid_input(
                "format must be one of png, jpeg, tiff, zif, webp, iiif-dir",
            )
            .into())
        }
    };
    let denied = OutputFormat::infer_from_path(&path)
        .map(|_| ())
        .and_then(|()| validate_destination(&path, &requested, false))
        .err();
    if let Some(error) = denied {
        return Ok(DestinationResult {
            outcome: "denied",
            destination_id: None,
            reason: Some(error.message.clone()),
            code: Some(error.code.clone()),
        });
    }
    // Grant the real destination through the validated dispatch; the native
    // runtime reports completion only after atomic output finalization.
    // Only the opaque destination id crosses IPC; the raw path stays native.
    // Overwrite stays false until an explicit overwrite confirmation exists.
    let dispatched = {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        let outcome = commands::dispatch_destination(&mut table, &job, &format, &path, false)?;
        Dispatched {
            job: outcome.job,
            seq: outcome.seq,
            event: outcome.event,
        }
    };
    {
        let mut table = state.lock().map_err(|_| CommandFailure {
            code: "shell.lock".into(),
            message: "job table poisoned".into(),
        })?;
        drain_and_emit(&app, &mut table);
    }
    Ok(DestinationResult {
        outcome: "granted",
        destination_id: Some(dispatched.event),
        reason: None,
        code: None,
    })
}

#[derive(Serialize, Clone)]
struct DeepLinkPendingPayload {
    source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    version: u32,
}

/// Bring the main window forward for a (second-instance) deep link.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Validate one raw deep-link candidate and, only on success, emit
/// `dezoomify://deep-link-pending` with the redacted
/// `{source_url, hint, version}` triple.
///
/// Rejected links are logged to stderr with no effect. Accepted links still
/// require explicit frontend confirmation before any `start_job` effect: the
/// confirmation gate (`apply_after_confirmation` with `confirmed = false`)
/// must refuse here, and only the frontend confirm path may re-apply with
/// `confirmed = true`.
fn handle_deep_link_url(app: &AppHandle, raw: &str) {
    match deep_link::parse_deep_link(raw) {
        Ok(link) => {
            debug_assert!(deep_link::requires_confirmation(&link));
            if deep_link::apply_after_confirmation(link.clone(), false).is_ok() {
                eprintln!("deep-link rejected: confirmation gate broken");
                return;
            }
            // Validated fields are non-secret by construction: the parser
            // rejects userinfo and secret keys, enforces v1-2, the 2048-byte
            // bound, and strict percent-decoding. Only this redacted triple
            // crosses the event boundary, never the raw link.
            let payload = DeepLinkPendingPayload {
                source_url: link.source_url.clone(),
                hint: link.hint.clone(),
                version: link.version,
            };
            let _ = app.emit("dezoomify://deep-link-pending", payload);
        }
        Err(err) => {
            eprintln!("deep-link rejected: {err}");
        }
    }
}

/// Scan second-instance (or initial-launch) argv for a deep link and forward
/// it to the main window. No effect is performed before frontend confirmation.
fn handle_deep_link_argv(app: &AppHandle, argv: &[String]) {
    if let Some(candidate) = deep_link::find_deep_link_in_argv(argv) {
        handle_deep_link_url(app, &candidate);
    }
}

/// Background driver poller: folds worker progress and terminal outcomes
/// into the transcript and emits each projected event on its channel.
/// Polls every 100 ms without blocking commands; the table lock is held
/// only for the synchronous pump+drain, never across await/dialog.
/// Terminals were enqueued exactly once and post-terminal messages ignored,
/// so the poller preserves exactly-once delivery. No tile bytes cross IPC;
/// payloads are already redacted in `jobs.rs`.
fn spawn_driver_poller(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("dezoomify-driver-poll".to_string())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let pending: Vec<crate::jobs::ProjectedEmit> = {
                let state = app.state::<Mutex<JobTable>>();
                let mut table = match state.lock() {
                    Ok(table) => table,
                    Err(_) => break,
                };
                table.poll_drivers();
                table.drain_pending()
            };
            for emit in pending {
                emit_projected(&app, emit);
            }
        });
}

/// Run the desktop shell. Exits the process on failure.
pub fn run() {
    let builder = tauri::Builder::default()
        // Single-instance first: second launches forward their argv
        // (`dezoomify://open?v=..&src=..`) to this window instead of
        // opening a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_deep_link_argv(app, &argv);
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Test-only embedded WebDriver server for the real-window E2E. The plugin
    // starts its server unconditionally, so it is compiled in only for the
    // non-default `testing-webdriver` feature and never reaches a release bundle.
    #[cfg(feature = "testing-webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    // Updater (todo 5.8 decision): automatic updates are disabled.
    // No update host or key is deployed; users check GitHub Releases
    // manually. The capability document sets `updater.enabled: false`
    // with an empty allowlist, `tauri.conf.json` ships empty
    // `plugins.updater.endpoints`, and `UPDATER_PUBKEY` stays empty so
    // the plugin never validates (fail closed). The retained
    // `src/updater.rs` policy (`validate_candidate`) stays unit-tested
    // for a future self-hosted updater; production `validate_update`
    // rejects every candidate with `updater.disabled` and the app keeps
    // working.
    // Registration gate (interim): the updater plugin is registered only
    // once a real public key exists. While `UPDATER_PUBKEY` is empty no
    // signature could validate, so skipping registration keeps the updater
    // fully inert (no endpoint is ever polled) until the key ceremony
    // lands. No host or key is invented here.
    let builder = if crate::updater::UPDATER_PUBKEY.is_empty() {
        builder
    } else {
        builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(crate::updater::UPDATER_PUBKEY)
                .build(),
        )
    };
    macro_rules! command_handler {
        ($($command:ident),* $(,)?) => {
            tauri::generate_handler![$($command),*]
        };
    }
    builder
        .manage(Mutex::new(JobTable::new()))
        .invoke_handler(desktop_commands!(command_handler))
        .setup(|app| {
            // Initial launch may itself carry a deep link
            // (`dezoomify-desktop dezoomify://open?...`).
            let argv: Vec<String> = std::env::args().collect();
            handle_deep_link_argv(app.handle(), &argv);
            // Real-time projection: driver progress/output/error reach the
            // frontend on their channels without waiting for the next command.
            spawn_driver_poller(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Startup-only: without a built shell there is no window to
            // report into, so fail closed with a clean message and a
            // non-zero exit instead of panicking (6.1 unwrap policy).
            eprintln!("error: cannot start the Dezoomify desktop shell: {e}");
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            // macOS open-url delivery: the OS hands `dezoomify://` URLs to
            // the running instance instead of spawning a second one.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    handle_deep_link_url(app_handle, url.as_str());
                }
                focus_main_window(app_handle);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app_handle, event);
        });
}
