mod auth_store;
mod autostart;
mod copy;
mod identity;
mod inbox;
mod panel;
mod paths;
mod resume;
mod state;
mod transfer;
mod tus;
mod watch;

use copy::HE;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        panel::show(&window);
    }
}

fn hide_main_window(window: &tauri::Window) {
    if let Some(webview) = panel::webview(window) {
        panel::hide(&webview);
        return;
    }
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
}

fn with_single_instance(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    #[cfg(not(debug_assertions))]
    {
        // Release: always register. Ignore FILERELAY_DATA_DIR.
        return builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if autostart::should_focus_existing_window(&argv) {
                show_main_window(app);
            }
        }));
    }

    #[cfg(debug_assertions)]
    {
        // Debug: skip only when FILERELAY_DATA_DIR is set and non-empty.
        if paths::should_skip_single_instance(
            true,
            std::env::var("FILERELAY_DATA_DIR").ok().as_deref(),
        ) {
            builder
        } else {
            builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if autostart::should_focus_existing_window(&argv) {
                    show_main_window(app);
                }
            }))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = with_single_instance(tauri::Builder::default())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    builder
        .invoke_handler(tauri::generate_handler![
            state::get_snapshot,
            state::complete_setup,
            auth_store::auth_storage_get,
            auth_store::auth_storage_set,
            auth_store::auth_storage_remove,
            auth_store::auth_storage_clear,
            auth_store::auth_storage_ensure,
            auth_store::auth_storage_health,
            transfer::pick_send_file,
            transfer::cancel_send_selection,
            transfer::tus_upload_v1,
            transfer::prepare_result_snapshot_from_selection,
            transfer::prepare_result_snapshot_from_working_file,
            transfer::tus_upload_initial_v2,
            transfer::tus_upload_result,
            transfer::tus_abort_resume,
            transfer::mark_resume_storage_removed,
            transfer::ack_resume_finalized,
            transfer::ack_resume_aborted,
            transfer::update_resume_reservation_expiry,
            transfer::list_resume_uploads,
            transfer::resume_tus_upload,
            transfer::restore_resume_snapshot_from_selection,
            transfer::download_inbox,
            transfer::open_inbox_file,
            transfer::reveal_inbox_folder,
            transfer::inbox_local_state,
            transfer::notify_new_file,
            transfer::notify_file_returned,
            watch::start_inbox_watch,
            watch::stop_inbox_watch,
            watch::recheck_inbox_file,
            watch::get_pending_local_statuses,
            watch::acknowledge_local_status_sync,
            watch::recheck_all_inbox_files,
            watch::prepare_return_snapshot,
            watch::discard_return_snapshot,
            watch::confirm_return_snapshot,
            watch::tus_upload_v2,
            autostart::get_autostart_state,
            autostart::set_autostart_enabled
        ])
        .setup(|app| {
            let app_state = state::init_app_state(app.handle())?;
            autostart::apply_release_default(app.handle(), &app_state.data_root);
            if autostart::argv_requests_background(std::env::args()) {
                autostart::hide_to_tray(app.handle());
            } else {
                show_main_window(app.handle());
            }
            app.manage(app_state);

            let show_item =
                MenuItem::with_id(app, "show", HE.tray_open, true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", HE.tray_quit, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "missing default window icon".to_string())?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip(HE.brand)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        hide_main_window(window);
                    }
                }
                WindowEvent::Moved(_) => {
                    if window.label() == "main" {
                        if let Some(webview) = panel::webview(window) {
                            panel::snap(&webview);
                        }
                    }
                }
                WindowEvent::Focused(true) => {
                    watch::recheck_on_focus(window.app_handle());
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
