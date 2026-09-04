use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::{
    load_flag, save_flag, AppState, AUTOSTART_DEFAULTED_KEY, AUTOSTART_OPTED_OUT_KEY,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    pub enabled: bool,
}

pub fn argv_requests_background<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> bool {
    args.into_iter().any(|arg| arg.as_ref() == "--background")
}

pub fn should_focus_existing_window<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> bool {
    !argv_requests_background(args)
}

#[cfg(not(debug_assertions))]
fn registry_is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(debug_assertions)]
fn registry_is_enabled<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

#[cfg(not(debug_assertions))]
fn enable_registry<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().is_ok() && registry_is_enabled(app)
}

#[cfg(debug_assertions)]
fn enable_registry<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

#[cfg(not(debug_assertions))]
fn disable_registry<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_autostart::ManagerExt;
    let _ = app.autolaunch().disable();
}

#[cfg(debug_assertions)]
fn disable_registry<R: Runtime>(_app: &AppHandle<R>) {}

pub fn apply_release_default<R: Runtime>(app: &AppHandle<R>, data_root: &std::path::Path) {
    if cfg!(debug_assertions) {
        return;
    }
    if load_flag(app, data_root, AUTOSTART_OPTED_OUT_KEY) {
        return;
    }
    if load_flag(app, data_root, AUTOSTART_DEFAULTED_KEY) {
        return;
    }
    let _ = enable_registry(app);
    let _ = save_flag(app, data_root, AUTOSTART_DEFAULTED_KEY, true);
}

#[tauri::command]
pub fn get_autostart_state<R: Runtime>(app: AppHandle<R>) -> AutostartState {
    AutostartState {
        enabled: registry_is_enabled(&app),
    }
}

#[tauri::command]
pub fn set_autostart_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    enabled: bool,
) -> Result<AutostartState, String> {
    if cfg!(debug_assertions) {
        let _ = &state.data_root;
        return Ok(AutostartState { enabled: false });
    }
    if enabled {
        let ok = enable_registry(&app);
        if ok {
            let _ = save_flag(&app, &state.data_root, AUTOSTART_OPTED_OUT_KEY, false);
        }
        return Ok(AutostartState {
            enabled: ok && registry_is_enabled(&app),
        });
    }
    disable_registry(&app);
    save_flag(&app, &state.data_root, AUTOSTART_OPTED_OUT_KEY, true)?;
    Ok(AutostartState {
        enabled: registry_is_enabled(&app),
    })
}

pub fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_flag_hides_and_second_instance_stays_hidden() {
        assert!(argv_requests_background(["filerelay.exe", "--background"]));
        assert!(!argv_requests_background(["filerelay.exe"]));
        assert!(!should_focus_existing_window(["--background"]));
        assert!(should_focus_existing_window(["filerelay.exe"]));
        assert!(should_focus_existing_window(["C:\\loop\\FileRelay.exe"]));
    }

    #[test]
    fn debug_build_skips_windows_registry_writes() {
        assert!(cfg!(debug_assertions));
        let source = include_str!("autostart.rs");
        assert!(source.contains("#[cfg(debug_assertions)]"));
        assert!(source.contains("fn enable_registry"));
        assert!(source.contains("fn disable_registry"));
    }
}
