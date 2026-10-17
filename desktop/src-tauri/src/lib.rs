//! Huntaway Desktop: native side. Connections to the `huntawayd` daemons,
//! secrets, notifications and the menu bar icon live here; the React front
//! end only displays (`PRD-desktop.md` §8).

mod commands;
mod local;
mod machines;
mod notify;
mod storage;
mod tray;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::machines::{Machines, Shared};
use crate::storage::Storage;

/// Forwards `huntaway://pair/…` links to the front end (pairing dialog).
fn forward_links(app: &tauri::AppHandle, urls: Vec<String>) {
    for url in urls {
        if url.starts_with(huntaway_api::PAIR_LINK_PREFIX) {
            tray::show_window(app);
            app.emit("pair-link", url).ok();
        }
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "huntaway_desktop_lib=info".into()))
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            tray::show_window(app);
            forward_links(app, argv.into_iter().filter(|a| a.starts_with("huntaway://")).collect());
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let machines = Machines::new(app.handle().clone(), Storage::new(dir));
            machines.start();
            app.manage::<Shared>(machines);
            tray::create(app.handle())?;
            // Linux has no install-time registration of `huntaway://` (AppImage).
            #[cfg(target_os = "linux")]
            if let Err(e) = app.deep_link().register_all() {
                tracing::warn!(error = %e, "schéma huntaway:// non enregistré");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                forward_links(&handle, event.urls().iter().map(|u| u.to_string()).collect());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                window.state::<Shared>().set_window_focused(*focused);
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let keep = window.state::<Shared>().settings.lock().unwrap().keep_in_tray;
                if keep {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_machines,
            commands::api_get,
            commands::api_post,
            commands::upload_file,
            commands::upload_data,
            commands::inspect_pairing,
            commands::pair_machine,
            commands::forget_machine,
            commands::rename_machine,
            commands::reconnect_machine,
            commands::local_status,
            commands::start_local_daemon,
            commands::refresh_local,
            commands::set_focus,
            commands::get_settings,
            commands::set_settings,
            commands::open_terminal,
            commands::close_terminal,
            commands::terminal_input,
            commands::test_notification,
        ])
        .build(tauri::generate_context!())
        .expect("démarrage de Huntaway Desktop");

    app.run(|app, event| {
        // Dock icon clicked while the window is hidden.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
            tray::show_window(app);
        }
        let _ = (app, event);
    });
}
