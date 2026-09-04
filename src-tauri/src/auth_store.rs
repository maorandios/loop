use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tauri::State;

use crate::state::AppState;

const AUTH_STORE_FAILED: &str = "auth_store_failed";
const AUTH_STORE_CORRUPT: &str = "auth_store_corrupt";

#[cfg(windows)]
const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
#[cfg(windows)]
const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(
        lp_existing_file_name: *const u16,
        lp_new_file_name: *const u16,
        dw_flags: u32,
    ) -> i32;
}

pub fn auth_file_path(root: &Path) -> PathBuf {
    root.join("state").join("supabase-auth.json")
}

fn tmp_file_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

type AuthMap = BTreeMap<String, String>;

enum LoadedAuth {
    Missing,
    Ready(AuthMap),
}

fn load_map(path: &Path) -> Result<LoadedAuth, String> {
    match fs::read(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(LoadedAuth::Missing),
        Err(_) => Err(AUTH_STORE_FAILED.to_string()),
        Ok(bytes) => match serde_json::from_slice::<AuthMap>(&bytes) {
            Ok(map) => Ok(LoadedAuth::Ready(map)),
            Err(_) => Err(AUTH_STORE_CORRUPT.to_string()),
        },
    }
}

fn map_io(_: io::Error) -> String {
    AUTH_STORE_FAILED.to_string()
}

fn write_tmp_flushed(tmp: &Path, payload: &[u8]) -> Result<(), String> {
    let mut file = File::create(tmp).map_err(map_io)?;
    if file.write_all(payload).is_err() {
        drop(file);
        let _ = fs::remove_file(tmp);
        return Err(AUTH_STORE_FAILED.to_string());
    }
    if file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(tmp);
        return Err(AUTH_STORE_FAILED.to_string());
    }
    drop(file);
    Ok(())
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let src: Vec<u16> = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dest: Vec<u16> = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dest.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

fn save_map_atomic(path: &Path, map: &AuthMap) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| AUTH_STORE_FAILED.to_string())?;
    }
    let tmp = tmp_file_path(path);
    let payload = serde_json::to_vec_pretty(map).map_err(|_| AUTH_STORE_FAILED.to_string())?;
    write_tmp_flushed(&tmp, &payload)?;
    if replace_file(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(AUTH_STORE_FAILED.to_string());
    }
    Ok(())
}

pub fn auth_store_status(root: &Path) -> Result<&'static str, String> {
    match load_map(&auth_file_path(root))? {
        LoadedAuth::Missing => Ok("missing"),
        LoadedAuth::Ready(_) => Ok("ok"),
    }
}

pub fn auth_get(root: &Path, key: &str) -> Result<Option<String>, String> {
    match load_map(&auth_file_path(root))? {
        LoadedAuth::Missing => Ok(None),
        LoadedAuth::Ready(map) => Ok(map.get(key).cloned()),
    }
}

pub fn auth_set(root: &Path, key: &str, value: &str) -> Result<(), String> {
    let path = auth_file_path(root);
    let mut map = match load_map(&path)? {
        LoadedAuth::Missing => AuthMap::new(),
        LoadedAuth::Ready(map) => map,
    };
    map.insert(key.to_string(), value.to_string());
    save_map_atomic(&path, &map)
}

pub fn auth_remove(root: &Path, key: &str) -> Result<(), String> {
    let path = auth_file_path(root);
    let mut map = match load_map(&path)? {
        LoadedAuth::Missing => AuthMap::new(),
        LoadedAuth::Ready(map) => map,
    };
    map.remove(key);
    save_map_atomic(&path, &map)
}

pub fn auth_clear(root: &Path) -> Result<(), String> {
    let path = auth_file_path(root);
    match load_map(&path)? {
        LoadedAuth::Missing | LoadedAuth::Ready(_) => save_map_atomic(&path, &AuthMap::new()),
    }
}

#[tauri::command]
pub fn auth_storage_get(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    auth_get(&state.data_root, &key)
}

#[tauri::command]
pub fn auth_storage_set(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    auth_set(&state.data_root, &key, &value)
}

#[tauri::command]
pub fn auth_storage_remove(state: State<AppState>, key: String) -> Result<(), String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    auth_remove(&state.data_root, &key)
}

#[tauri::command]
pub fn auth_storage_clear(state: State<AppState>) -> Result<(), String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    auth_clear(&state.data_root)
}

#[tauri::command]
pub fn auth_storage_ensure(state: State<AppState>) -> Result<(), String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    let path = auth_file_path(&state.data_root);
    match load_map(&path)? {
        LoadedAuth::Missing => save_map_atomic(&path, &AuthMap::new()),
        LoadedAuth::Ready(_) => Ok(()),
    }
}

#[tauri::command]
pub fn auth_storage_health(state: State<AppState>) -> Result<String, String> {
    let _guard = state.auth_lock.lock().expect("auth store lock");
    auth_store_status(&state.data_root).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("filerelay-auth-{label}-{nanos}"));
        fs::create_dir_all(root.join("state")).unwrap();
        root
    }

    #[test]
    fn missing_auth_file_is_an_empty_valid_state() {
        let root = temp_root("missing");
        let path = auth_file_path(&root);
        assert!(!path.exists());
        assert_eq!(auth_store_status(&root).unwrap(), "missing");
        assert_eq!(auth_get(&root, "session").unwrap(), None);
        assert!(!path.exists());
    }

    #[test]
    fn valid_auth_file_loads() {
        let root = temp_root("valid");
        auth_set(&root, "session", "persist-me").unwrap();
        assert_eq!(auth_store_status(&root).unwrap(), "ok");
        assert_eq!(auth_get(&root, "session").unwrap().as_deref(), Some("persist-me"));
    }

    #[test]
    fn separate_data_roots_keep_separate_sessions() {
        let root_a = temp_root("a");
        let root_b = temp_root("b");
        auth_set(&root_a, "session", "token-a").unwrap();
        auth_set(&root_b, "session", "token-b").unwrap();

        assert_eq!(auth_get(&root_a, "session").unwrap().as_deref(), Some("token-a"));
        assert_eq!(auth_get(&root_b, "session").unwrap().as_deref(), Some("token-b"));
        assert_ne!(auth_file_path(&root_a), auth_file_path(&root_b));
    }

    #[test]
    fn same_data_root_reloads_the_session() {
        let root = temp_root("reload");
        auth_set(&root, "session", "token-persist").unwrap();
        assert_eq!(
            auth_get(&root, "session").unwrap().as_deref(),
            Some("token-persist")
        );
    }

    #[test]
    fn existing_dest_is_replaced_without_deleting_first() {
        let root = temp_root("replace");
        auth_set(&root, "session", "first").unwrap();
        auth_set(&root, "session", "second").unwrap();
        assert_eq!(auth_get(&root, "session").unwrap().as_deref(), Some("second"));
        assert!(auth_file_path(&root).exists());
    }

    #[test]
    fn corrupt_auth_file_returns_stable_code_without_exposing_contents() {
        let root = temp_root("corrupt");
        let path = auth_file_path(&root);
        let raw = b"not-json { access_token: secret }";
        fs::write(&path, raw).unwrap();

        let err = auth_get(&root, "session").unwrap_err();
        assert_eq!(err, AUTH_STORE_CORRUPT);
        assert!(!err.contains("access_token"));
        assert!(!err.contains("secret"));
        assert!(!err.contains("not-json"));
        assert_eq!(auth_store_status(&root).unwrap_err(), AUTH_STORE_CORRUPT);
        assert_eq!(fs::read(&path).unwrap(), raw);
    }

    #[test]
    fn corrupt_auth_file_is_not_overwritten() {
        let root = temp_root("corrupt-keep");
        let path = auth_file_path(&root);
        let raw = b"{ this is not json, refresh_token: keep-me }";
        fs::write(&path, raw).unwrap();

        assert_eq!(auth_set(&root, "session", "new").unwrap_err(), AUTH_STORE_CORRUPT);
        assert_eq!(auth_clear(&root).unwrap_err(), AUTH_STORE_CORRUPT);
        assert_eq!(fs::read(&path).unwrap(), raw);
    }

    #[test]
    fn failed_replace_leaves_the_previous_file_intact() {
        let root = temp_root("replace-fail");
        auth_set(&root, "session", "keep-original").unwrap();
        let path = auth_file_path(&root);
        let original = fs::read(&path).unwrap();
        let tmp = tmp_file_path(&path);
        fs::create_dir(&tmp).unwrap();

        let err = auth_set(&root, "session", "should-not-land").unwrap_err();
        assert_eq!(err, AUTH_STORE_FAILED);
        assert!(!err.contains("keep-original"));
        assert!(!err.contains("should-not-land"));
        assert_eq!(fs::read(&path).unwrap(), original);
        let _ = fs::remove_dir(&tmp);
    }

    #[test]
    fn auth_file_is_not_the_general_state_store() {
        let root = PathBuf::from(r"C:\Users\Maor\AppData\Local\com.filerelay.app");
        let auth = auth_file_path(&root);
        assert_eq!(auth.file_name().unwrap(), "supabase-auth.json");
        assert_ne!(auth.file_name().unwrap(), "state.json");
    }
}
