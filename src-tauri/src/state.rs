use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_store::StoreExt;

use crate::identity::{
    create_local_device, load_local_device, normalize_display_name, LocalDevice, STATE_VERSION,
};
use crate::paths::{ensure_data_layout, resolve_data_root, state_file_path};
use crate::resume::ResumeKey;
use notify::RecommendedWatcher;
use uuid::Uuid;

const LOCAL_DEVICE_KEY: &str = "local_device";
const STATE_VERSION_KEY: &str = "state_version";
pub const AUTOSTART_DEFAULTED_KEY: &str = "autostart_default_attempted";
pub const AUTOSTART_OPTED_OUT_KEY: &str = "autostart_opted_out";

#[derive(Clone)]
pub struct ReturnSnapshot {
    pub path: PathBuf,
    pub handoff_id: Uuid,
    pub size: u64,
    pub blake3: String,
}

#[derive(Clone)]
pub struct ResultSnapshot {
    pub path: PathBuf,
    pub handoff_id: Uuid,
    pub transfer_id: Uuid,
    pub file_name: String,
    pub size: u64,
    pub blake3: String,
    pub source_path: PathBuf,
}

pub struct ActiveWatch {
    pub _watcher: RecommendedWatcher,
    pub generation: u64,
    pub debounce_token: u64,
}

pub struct AppState {
    pub data_root: PathBuf,
    pub local_device: Mutex<Option<LocalDevice>>,
    pub auth_lock: Mutex<()>,
    pub selections: Mutex<HashMap<Uuid, PathBuf>>,
    pub snapshots: Mutex<HashMap<Uuid, ReturnSnapshot>>,
    pub result_snapshots: Mutex<HashMap<Uuid, ResultSnapshot>>,
    pub resume_inflight: Arc<Mutex<HashSet<ResumeKey>>>,
    pub watches: Mutex<HashMap<Uuid, ActiveWatch>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub local_device: Option<LocalDevice>,
}

pub fn init_app_state<R: Runtime>(app: &AppHandle<R>) -> Result<AppState, String> {
    let data_root = resolve_data_root(app)?;
    ensure_data_layout(&data_root)?;

    // Absolute path so tauri-plugin-store does not resolve against Roaming AppData.
    let store_path = state_file_path(&data_root);
    let store = app.store(store_path).map_err(|err| err.to_string())?;
    let stored_version = store.get(STATE_VERSION_KEY).and_then(|value| value.as_u64());
    let loaded = store
        .get(LOCAL_DEVICE_KEY)
        .and_then(|value| load_local_device(value).ok());
    let local_device = loaded.as_ref().map(|entry| entry.device.clone());
    let needs_rewrite = loaded
        .as_ref()
        .map(|entry| entry.needs_rewrite)
        .unwrap_or(false)
        || (local_device.is_some() && stored_version != Some(u64::from(STATE_VERSION)));

    drop(store);

    if needs_rewrite {
        if let Some(device) = local_device.as_ref() {
            persist_local_device(app, &data_root, device)?;
        }
    }

    let _ = crate::watch::cleanup_orphan_snapshots(&data_root);

    Ok(AppState {
        data_root,
        local_device: Mutex::new(local_device),
        auth_lock: Mutex::new(()),
        selections: Mutex::new(HashMap::new()),
        snapshots: Mutex::new(HashMap::new()),
        result_snapshots: Mutex::new(HashMap::new()),
        resume_inflight: Arc::new(Mutex::new(HashSet::new())),
        watches: Mutex::new(HashMap::new()),
    })
}

fn persist_local_device<R: Runtime>(
    app: &AppHandle<R>,
    data_root: &Path,
    device: &LocalDevice,
) -> Result<(), String> {
    // Absolute path so tauri-plugin-store does not resolve against Roaming AppData.
    let store = app
        .store(state_file_path(data_root))
        .map_err(|err| err.to_string())?;
    let value = serde_json::to_value(device).map_err(|err| err.to_string())?;
    store.set(LOCAL_DEVICE_KEY, value);
    store.set(STATE_VERSION_KEY, serde_json::json!(STATE_VERSION));
    store.save().map_err(|err| err.to_string())
}

pub fn load_flag<R: Runtime>(app: &AppHandle<R>, data_root: &Path, key: &str) -> bool {
    let Ok(store) = app.store(state_file_path(data_root)) else {
        return false;
    };
    store.get(key).and_then(|value| value.as_bool()).unwrap_or(false)
}

pub fn save_flag<R: Runtime>(
    app: &AppHandle<R>,
    data_root: &Path,
    key: &str,
    value: bool,
) -> Result<(), String> {
    let store = app
        .store(state_file_path(data_root))
        .map_err(|err| err.to_string())?;
    store.set(key, serde_json::json!(value));
    store.save().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_snapshot(state: State<AppState>) -> Snapshot {
    Snapshot {
        local_device: state.local_device.lock().expect("local device lock").clone(),
    }
}

#[tauri::command]
pub fn complete_setup(
    app: AppHandle,
    state: State<AppState>,
    display_name: String,
) -> Result<LocalDevice, String> {
    {
        let existing = state.local_device.lock().expect("local device lock");
        if let Some(device) = existing.as_ref() {
            return Ok(device.clone());
        }
    }

    let display_name = normalize_display_name(&display_name)?;
    let device = create_local_device(display_name);
    persist_local_device(&app, &state.data_root, &device).map_err(|_| "save_failed".to_string())?;

    *state.local_device.lock().expect("local device lock") = Some(device.clone());
    Ok(device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn snapshot_json_does_not_include_lan_server_fields_or_tokens() {
        let snapshot = Snapshot {
            local_device: Some(LocalDevice {
                device_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
                display_name: "מאור".into(),
            }),
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        let text = serde_json::to_string(&snapshot).unwrap();
        assert!(json.get("localDevice").is_some());
        assert!(json.get("serverStatus").is_none());
        assert!(json.get("port").is_none());
        assert!(json.get("localAddresses").is_none());
        assert!(json.get("lastErrorCode").is_none());
        assert!(json.get("pairingCode").is_none());
        assert!(json["localDevice"].get("port").is_none());
        assert!(json["localDevice"].get("pairingCode").is_none());
        assert!(!text.contains("access_token"));
        assert!(!text.contains("refresh_token"));
        assert!(!text.contains("pairingCode"));
    }

    #[test]
    fn rewritten_store_payload_keeps_identity_and_drops_lan_fields() {
        let raw = serde_json::json!({
            "deviceId": "11111111-1111-4111-8111-111111111111",
            "displayName": "מאור",
            "pairingCode": "482913",
            "port": 4747
        });
        let loaded = load_local_device(raw).unwrap();
        let rewritten = serde_json::to_value(&loaded.device).unwrap();
        assert_eq!(
            rewritten["deviceId"],
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(rewritten["displayName"], "מאור");
        assert!(rewritten.get("pairingCode").is_none());
        assert!(rewritten.get("port").is_none());
        assert_eq!(STATE_VERSION, 2);
    }

    #[test]
    fn snapshot_registry_is_opaque_to_serde_clients() {
        let snapshot = ReturnSnapshot {
            path: PathBuf::from(
                r"C:\Users\Maor\AppData\Local\com.filerelay.app\files\tmp\return.part",
            ),
            handoff_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            size: 8,
            blake3: "ab".repeat(32),
        };
        assert!(snapshot.path.is_absolute());
        let prepared = crate::watch::PreparedSnapshot {
            return_snapshot_id: snapshot.handoff_id,
            file_size: snapshot.size,
            blake3: snapshot.blake3.clone(),
        };
        let text = serde_json::to_string(&prepared).unwrap();
        assert!(!text.contains("tmp"));
        assert!(!text.contains("return.part"));
        assert!(!text.contains("C:\\\\"));
    }
}
