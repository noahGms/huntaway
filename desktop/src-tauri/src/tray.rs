//! Menu bar icon: number of agents waiting, quick access to the window.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Huntaway", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Huntaway", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Huntaway")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Shows the number of waiting agents next to the icon.
pub fn set_count(app: &AppHandle, count: usize) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.set_title(title.as_deref());
        let tooltip = match count {
            0 => "Huntaway".to_string(),
            1 => "Huntaway · 1 agent waiting".to_string(),
            n => format!("Huntaway · {n} agents waiting"),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}
