use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, HELP_SUBMENU_ID},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::jobs::JobTable;

const CHECK_UPDATES: &str = "check-updates";

pub(crate) fn setup(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    if let Some(help) = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned())
    {
        help.append(&MenuItem::with_id(
            app,
            CHECK_UPDATES,
            "Check for updates…",
            true,
            None::<&str>,
        )?)?;
    }
    app.set_menu(menu)?;
    app.manage(Arc::new(AtomicBool::new(false)));
    Ok(())
}

pub(crate) fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() != CHECK_UPDATES {
        return;
    }
    let busy = Arc::clone(&app.state::<Arc<AtomicBool>>());
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check_and_install(&app).await {
            app.dialog()
                .message(error)
                .title("Update failed")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
        busy.store(false, Ordering::SeqCst);
    });
}

async fn check_and_install(app: &AppHandle) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|error| error.to_string())? else {
        app.dialog()
            .message("You are using the latest version of Dezoomify.")
            .title("Dezoomify updates")
            .show(|_| {});
        return Ok(());
    };
    let (answer, response) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Install Dezoomify {} and restart the app? Finish or cancel any current save first.",
            update.version
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = answer.send(confirmed);
        });
    if !response.await.unwrap_or(false) {
        return Ok(());
    }
    // The check timeout is not inherited by downloads. Bound the transfer so
    // a stalled update reaches end_update() and allows saves again.
    update.timeout = Some(std::time::Duration::from_secs(10 * 60));
    let jobs = app.state::<Mutex<JobTable>>();
    jobs.lock()
        .map_err(|error| error.to_string())?
        .begin_update()
        .map_err(|error| error.to_string())?;
    let result = update.download_and_install(|_, _| {}, || {}).await;
    if let Err(error) = result {
        jobs.lock().map_err(|error| error.to_string())?.end_update();
        return Err(error.to_string());
    }
    app.restart();
}
