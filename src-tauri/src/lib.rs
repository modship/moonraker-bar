mod camera;
mod commands;
mod discovery;
mod manager;
mod moonraker;
mod tray;

use tauri::{Manager as _, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            // Menu bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let mgr = manager::Manager::new(app.handle().clone());
            app.manage(mgr.clone());
            tray::setup(app.handle())?;
            tauri::async_runtime::spawn(async move { mgr.load().await });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                tray::popover_blurred(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_printers,
            commands::get_snapshots,
            commands::add_printer,
            commands::update_printer,
            commands::remove_printer,
            commands::set_pinned_macros,
            commands::set_shown_temps,
            commands::get_layout,
            commands::get_thumbnail,
            commands::discover_printers,
            commands::set_layout,
            commands::get_active_printer,
            commands::set_active_printer,
            commands::printer_action,
            commands::test_connection,
            commands::hide_popover,
            commands::camera_start,
            commands::camera_stop,
            commands::quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Moonraker Bar")
        .run(|_app, event| {
            // Keep running when the last window is hidden/closed: we live in the tray.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
