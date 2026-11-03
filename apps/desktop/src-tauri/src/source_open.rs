//! Native source opening converges on one validated, idle-only frontend event.
use crate::{commands, jobs::JobTable};
use dezoomify::core::default_registry;
use dezoomify::model::DesktopSource;
use std::{path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, DragDropEvent, Emitter, Manager, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const OPEN_SOURCE: &str = "open-source";

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let open = MenuItem::with_id(app, OPEN_SOURCE, "Open…", true, Some("CmdOrCtrl+O"))?;
    let file = menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().ok().as_deref() == Some("File"))
            .cloned()
    });
    if let Some(file) = file {
        file.insert(&open, 0)?;
    } else {
        menu.insert(
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            0,
        )?;
    }
    crate::updater::append_menu(app, &menu)?;
    app.set_menu(menu)?;
    Ok(())
}

fn notice(app: &AppHandle, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title("Open image source")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn available(app: &AppHandle) -> bool {
    let jobs = app.state::<Mutex<JobTable>>();
    if jobs.lock().is_ok_and(|jobs| !jobs.is_busy()) {
        true
    } else {
        notice(
            app,
            "Finish or cancel the current save before opening another source.",
        );
        false
    }
}

/// Recheck idle state after a dialog closes; another source may have started meanwhile.
fn open_file(app: &AppHandle, path: PathBuf) {
    if !available(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = path.to_str() else {
            notice(&app, "This file's path cannot be represented as text.");
            return;
        };
        let source = DesktopSource::File {
            path: path.to_owned(),
        };
        match commands::source_input(&source) {
            Ok(_) if available(&app) => {
                if let Err(error) = app.emit_to("main", crate::jobs::CHANNEL_OPEN_SOURCE, source) {
                    notice(&app, format!("Could not open this source: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => notice(&app, error.to_string()),
        }
    });
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() != OPEN_SOURCE {
        crate::updater::on_menu_event(app, event);
        return;
    }
    if !available(app) {
        return;
    }
    let handle = app.clone();
    let registry = default_registry();
    let extensions = registry
        .file_formats()
        .flat_map(|format| format.file_extensions().iter().copied())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    // The macOS backend displays the title as NSOpenPanel's explanatory message.
    let title = if cfg!(target_os = "macos") {
        std::iter::once("Open an image source.")
            .chain(
                registry
                    .file_formats()
                    .filter_map(|format| format.file_help()),
            )
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        "Open image source".to_owned()
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("Image sources", &extensions);
    for format in registry.file_formats() {
        dialog = dialog.add_filter(format.display_name(), format.file_extensions());
    }
    dialog
        .add_filter("All files", &["*"])
        .pick_file(move |file| {
            if let Some(file) = file {
                match file.into_path() {
                    Ok(path) => open_file(&handle, path),
                    Err(error) => notice(&handle, error.to_string()),
                }
            }
        });
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
        match paths.as_slice() {
            [path] => open_file(window.app_handle(), path.clone()),
            [] => {}
            _ => notice(window.app_handle(), "Open one source file at a time."),
        }
    }
}
