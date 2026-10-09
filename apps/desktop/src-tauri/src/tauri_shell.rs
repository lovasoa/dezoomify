use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands;
use crate::jobs::JobTable;
use crate::saved_outputs::SavedOutputs;
use crate::settings::parse_settings;
use dezoomify::model::{DesktopOutput, Error, Failure, SavedOutputState};
use dezoomify_native::{NativeHost, OutputTarget};

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
            launch_saved_output(image.clone(), false).unwrap_err(),
            dezoomify::model::Error::OutputNotFound
        );
        // A moved image does not prevent opening its containing directory.
        launch_saved_output(image, true).unwrap();
        fs::write(root.join("gio"), "#!/bin/sh\nexit 1\n").unwrap();
        assert!(matches!(
            launch_saved_output(root.join("missing.png"), true).unwrap_err(),
            dezoomify::model::Error::LaunchFailed { .. }
        ));
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
            (
                "gio",
                "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$DEZOOMIFY_TEST_LAUNCH_ROOT/calls\"\nexit 0\n",
            ),
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
/// The retry policy of `Error::retryable()`, exposed at the boundary.
#[tauri::command]
fn is_retryable(error: dezoomify::model::Error) -> bool {
    error.retryable()
}

/// Validate raw settings without starting a job: `parse_settings` is the
/// single validator, so the webview persists an edit only after the shell
/// accepts it and holds none of its rules.
#[tauri::command]
fn validate_settings(settings: serde_json::Value) -> Result<(), Error> {
    parse_settings(&settings)
        .map(|_| ())
        .map_err(|message| Error::InvalidSettings(message.into()))
}

#[tauri::command]
async fn open_saved_output(
    table: State<'_, Mutex<JobTable>>,
    job: String,
    reveal: bool,
) -> Result<(), Error> {
    let path = table
        .lock()
        .ok()
        .and_then(|table| table.saved_output_for(&job))
        .ok_or_else(|| Error::OutputUnavailable(Failure::default()))?;
    // Launch off the async executor and check the launcher's result. The
    // opener plugin's detached path reports success before the launcher exits;
    // its Linux reveal API also requires a FileManager1/portal D-Bus service.
    // Opening the parent uses the user's default folder handler instead.
    tauri::async_runtime::spawn_blocking(move || launch_saved_output(path, reveal))
        .await
        .map_err(|_| {
            Error::LaunchFailed("the file-opening task could not finish".to_string().into())
        })?
}

fn launch_saved_output(path: std::path::PathBuf, reveal: bool) -> Result<(), Error> {
    let target = if reveal {
        path.parent().ok_or(Error::OutputNoParent)?.to_path_buf()
    } else {
        path
    };
    std::fs::metadata(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::OutputNotFound
        } else {
            Error::OutputUnavailable(dezoomify::model::chain_text(&error).into())
        }
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
    Err(Error::LaunchFailed(
        "the system could not launch the default application"
            .to_string()
            .into(),
    ))
}

#[tauri::command]
async fn inspect_saved_output(
    outputs: State<'_, Arc<SavedOutputs>>,
    id: String,
) -> Result<SavedOutputState, Error> {
    let outputs = Arc::clone(&outputs);
    tauri::async_runtime::spawn_blocking(move || outputs.inspect(&id))
        .await
        .map_err(|error| Error::Internal(error.to_string().into()))?
}

#[tauri::command]
async fn open_history_output(
    outputs: State<'_, Arc<SavedOutputs>>,
    id: String,
) -> Result<(), Error> {
    let outputs = Arc::clone(&outputs);
    tauri::async_runtime::spawn_blocking(move || launch_saved_output(outputs.resolve(&id)?, false))
        .await
        .map_err(|error| Error::LaunchFailed(error.to_string().into()))?
}

#[tauri::command]
async fn forget_saved_output(
    outputs: State<'_, Arc<SavedOutputs>>,
    id: String,
) -> Result<(), Error> {
    let outputs = Arc::clone(&outputs);
    tauri::async_runtime::spawn_blocking(move || outputs.forget(&id))
        .await
        .map_err(|error| Error::Internal(error.to_string().into()))?
}

fn lock_table<'a>(
    state: &'a State<'_, Mutex<JobTable>>,
) -> Result<std::sync::MutexGuard<'a, JobTable>, Error> {
    state.lock().map_err(|_| Error::ShellLock)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC payload fields + injected handles
async fn dezoomify(
    state: State<'_, Mutex<JobTable>>,
    saved_outputs: State<'_, Arc<SavedOutputs>>,
    app: AppHandle,
    job: String,
    input_url: String,
    settings: Option<serde_json::Value>,
) -> Result<DesktopOutput, Error> {
    if !commands::is_valid_input_url(&input_url) {
        return Err(Error::InvalidInput(
            "input_url must be an http(s) URL up to 2048 bytes without userinfo"
                .to_string()
                .into(),
        ));
    }
    let settings = settings
        .map(|value| parse_settings(&value))
        .transpose()
        .map_err(|message| Error::InvalidSettings(message.into()))?
        .unwrap_or_else(crate::settings::DesktopSettings::with_defaults);
    let registration = lock_table(&state)?.insert(&job)?;
    if let Err(error) = app.emit(
        crate::jobs::CHANNEL_REGISTERED,
        serde_json::json!({"job": job}),
    ) {
        lock_table(&state)?.release_job(&job);
        return Err(Error::RegistrationFailed(
            format!("the native invocation could not be acknowledged: {error}").into(),
        ));
    }
    let mut options = crate::settings::job_options_for(&settings);
    options.input_url = input_url;
    let dir = settings.output_dir.unwrap_or_else(std::env::temp_dir);
    options.output = match settings.output_format.format() {
        None => OutputTarget::AutoImageDir { dir },
        Some(format) => OutputTarget::AutoDir { dir, format },
    };
    let saved_outputs = Arc::clone(&saved_outputs);
    tauri::async_runtime::spawn_blocking(move || {
        let mut host = match NativeHost::with_diagnostics(options, registration.diagnostics.clone())
        {
            Ok(host) => host,
            Err(error) => {
                registration.finish(None);
                registration
                    .diagnostics
                    .finish("failed", serde_json::json!({ "error": error }));
                return Err(error);
            }
        };
        host.controls = registration.controls.clone();
        host.on_progress(|progress| {
            let _ = app.emit(
                crate::jobs::CHANNEL_PROGRESS,
                serde_json::json!({"job": job, "progress": progress}),
            );
        });
        host.on_retry(|request| {
            let (question, answer) = registration.request_retry();
            let _ = app.emit(
                crate::jobs::CHANNEL_RETRY,
                serde_json::json!({"job": job, "question": question, "request": request}),
            );
            Box::pin(async move { answer.await.map_err(|_| Error::InteractionExpired) })
        });
        let result = host.transport.block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ));
        let path = host.publication().map(|output| output.path);
        registration.finish(path.clone());
        let saved_output = path
            .filter(|_| result.is_ok())
            .and_then(|path| saved_outputs.register(path, &job).ok());
        if let Some(saved) = &saved_output {
            let id = saved.id.clone();
            // History persistence is best effort and does not hold up completion.
            tauri::async_runtime::spawn_blocking(move || saved_outputs.persist(&id));
        }
        if let Err(error) = &result {
            registration.diagnostics.finish(
                if matches!(error.cause(), Error::Cancelled) {
                    "cancelled"
                } else {
                    "failed"
                },
                serde_json::json!({ "error": error }),
            );
        }
        result.map(|output| DesktopOutput {
            output,
            saved_output,
        })
    })
    .await
    .map_err(|_| Error::Internal("native task failed".to_string().into()))?
}

#[tauri::command]
async fn cancel_job(state: State<'_, Mutex<JobTable>>, job: String) -> Result<(), Error> {
    lock_table(&state)?.live(&job)?.controls.cancel();
    Ok(())
}
#[tauri::command]
async fn pause_job(state: State<'_, Mutex<JobTable>>, job: String) -> Result<(), Error> {
    lock_table(&state)?.live(&job)?.controls.pause();
    Ok(())
}
#[tauri::command]
async fn resume_job(state: State<'_, Mutex<JobTable>>, job: String) -> Result<(), Error> {
    lock_table(&state)?.live(&job)?.controls.resume();
    Ok(())
}
#[tauri::command]
async fn answer_retry(
    state: State<'_, Mutex<JobTable>>,
    job: String,
    question: u64,
    answer: dezoomify::model::RetryChoice,
) -> Result<(), Error> {
    lock_table(&state)?
        .live(&job)?
        .answer_retry(question, answer)?;
    Ok(())
}
#[tauri::command]
async fn release_job(state: State<'_, Mutex<JobTable>>, job: String) -> Result<(), Error> {
    lock_table(&state)?.release_job(&job);
    Ok(())
}
#[tauri::command]
async fn get_job_diagnostics(
    state: State<'_, Mutex<JobTable>>,
    job: String,
) -> Result<dezoomify::model::DiagnosticReport, Error> {
    lock_table(&state)?
        .diagnostic_report(&job)
        .ok_or_else(|| crate::jobs::unknown_job(&job))
}
/// Bring the main window forward when a launch focuses this instance.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Run the desktop shell. Exits the process on failure.
pub fn run() {
    let builder = tauri::Builder::default()
        // Single-instance: a second launch focuses the existing window
        // instead of opening a second one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Test-only embedded WebDriver server for the real-window E2E. The plugin
    // starts its server unconditionally, so it is compiled in only for the
    // non-default `testing-webdriver` feature and never reaches a release bundle.
    #[cfg(feature = "testing-webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    macro_rules! command_handler {
        ($($command:ident),* $(,)?) => {
            tauri::generate_handler![$($command),*]
        };
    }
    builder
        .manage(Mutex::new(JobTable::new()))
        .setup(|app| {
            app.manage(Arc::new(SavedOutputs::new(
                app.path().app_data_dir()?.join("saved-outputs"),
            )));
            Ok(())
        })
        .invoke_handler(desktop_commands!(command_handler))
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Startup-only: without a built shell there is no window to
            // report into, so fail closed with a clean message and a
            // non-zero exit instead of panicking.
            eprintln!("error: cannot start the Dezoomify desktop shell: {e}");
            std::process::exit(1);
        })
        .run(|_app_handle, _event| {});
}
