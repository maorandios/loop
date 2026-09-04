use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use uuid::Uuid;

use crate::inbox::{
    acknowledge_sync, apply_hash_result, load_inbox, pending_statuses, save_inbox, InboxRole,
    LocalStateEvent, PendingLocalStatus,
};
use crate::paths::{inbox_dir, inbox_version_dir, is_return_snapshot_filename, tmp_dir, version_folder_name};
use crate::state::{ActiveWatch, AppState, ReturnSnapshot};
use crate::transfer::{
    hash_path, is_file_busy, upload_resumable, validate_storage_path_ids_version, FILE_BUSY,
    FILE_CHANGED_DURING_RETURN, FILE_TOO_LARGE, MAX_FILE_SIZE, SEND_FAILED,
};

const WATCH_FAILED: &str = "watch_failed";
const SNAPSHOT_UNKNOWN: &str = "snapshot_unknown";
const EVENT_NAME: &str = "handoff-local-state";

const BACKOFF_MS: [u64; 5] = [250, 500, 1_000, 2_000, 4_000];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSnapshot {
    pub return_snapshot_id: Uuid,
    pub file_size: u64,
    pub blake3: String,
}

pub fn cleanup_orphan_snapshots(root: &Path) -> Result<(), String> {
    let dir = tmp_dir(root);
    let entries = match std::fs::read_dir(&dir) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Ok(()),
        Ok(entries) => entries,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_return_snapshot_filename(name) {
            continue;
        }
        if path.starts_with(inbox_dir(root)) {
            continue;
        }
        if path.starts_with(&dir) && path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

fn emit_local_state<R: Runtime>(app: &AppHandle<R>, event: LocalStateEvent) {
    let _ = app.emit(EVENT_NAME, event);
}

fn working_path(root: &Path, handoff_id: Uuid, filename: &str, version: u16) -> Result<PathBuf, String> {
    let label = version_folder_name(version)?;
    Ok(inbox_version_dir(root, &handoff_id.to_string(), &label)?.join(filename))
}

fn current_generation(state: &AppState, handoff_id: Uuid) -> Option<u64> {
    state
        .watches
        .lock()
        .expect("watch lock")
        .get(&handoff_id)
        .map(|watch| watch.generation)
}

fn bump_watch_generation(state: &AppState, handoff_id: Uuid) -> Option<u64> {
    let mut watches = state.watches.lock().expect("watch lock");
    let watch = watches.get_mut(&handoff_id)?;
    watch.generation = watch.generation.saturating_add(1);
    Some(watch.generation)
}

fn schedule_debounced_recheck<R: Runtime>(app: AppHandle<R>, handoff_id: Uuid) {
    let token = {
        let state = app.state::<AppState>();
        let mut watches = state.watches.lock().expect("watch lock");
        let Some(watch) = watches.get_mut(&handoff_id) else {
            return;
        };
        watch.debounce_token = watch.debounce_token.saturating_add(1);
        watch.debounce_token
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let state = app.state::<AppState>();
        let current = state
            .watches
            .lock()
            .expect("watch lock")
            .get(&handoff_id)
            .map(|watch| watch.debounce_token);
        if current != Some(token) {
            return;
        }
        let _ = recheck_now(app.clone(), handoff_id).await;
    });
}

async fn recheck_now<R: Runtime>(app: AppHandle<R>, handoff_id: Uuid) -> Result<(), String> {
    let state = app.state::<AppState>();
    let had_watch = current_generation(&state, handoff_id).is_some();
    let generation = if let Some(gen) = bump_watch_generation(&state, handoff_id) {
        gen
    } else {
        let mut inbox = load_inbox(&state.data_root)?;
        let Some(record) = inbox.working_record_mut(&handoff_id.to_string()) else {
            return Ok(());
        };
        record.generation = record.generation.saturating_add(1);
        let gen = record.generation;
        save_inbox(&state.data_root, &inbox)?;
        gen
    };

    let (filename, version, root) = {
        let inbox = load_inbox(&state.data_root)?;
        let Some(record) = inbox.working_record(&handoff_id.to_string()) else {
            return Ok(());
        };
        let Some(version) = inbox.working_version(&handoff_id.to_string()) else {
            return Ok(());
        };
        (record.filename.clone(), version, state.data_root.clone())
    };
    let path = working_path(&root, handoff_id, &filename, version)?;

    let mut hash_result: Option<String> = None;
    for (index, wait_ms) in std::iter::once(0u64).chain(BACKOFF_MS.into_iter()).enumerate() {
        if wait_ms > 0 {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        }
        if had_watch && current_generation(&state, handoff_id).is_none() {
            return Ok(());
        }
        if let Some(current) = current_generation(&state, handoff_id) {
            if current != generation {
                return Ok(());
            }
        }
        match hash_path(&path) {
            Ok((_size, hash)) => {
                hash_result = Some(hash);
                break;
            }
            Err(err) if err == FILE_BUSY => {
                if index == BACKOFF_MS.len() {
                    break;
                }
            }
            Err(_) => {
                break;
            }
        }
    }

    if had_watch && current_generation(&state, handoff_id).is_none() {
        return Ok(());
    }
    if let Some(current) = current_generation(&state, handoff_id) {
        if current != generation {
            return Ok(());
        }
    }

    let mut inbox = load_inbox(&root)?;
    let Some(record) = inbox.working_record_mut(&handoff_id.to_string()) else {
        return Ok(());
    };
    if let Some(hash) = hash_result {
        apply_hash_result(record, generation, &hash, false);
    } else {
        apply_hash_result(record, generation, &record.blake3.clone(), true);
    }
    let event = record.to_event(&handoff_id.to_string());
    save_inbox(&root, &inbox)?;
    emit_local_state(&app, event);
    Ok(())
}

fn watch_filter(event: &Event, filename: &str) -> bool {
    event.paths.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == filename)
    })
}

#[tauri::command]
pub fn start_inbox_watch(
    app: AppHandle,
    state: State<AppState>,
    handoff_id: Uuid,
) -> Result<(), String> {
    let inbox = load_inbox(&state.data_root)?;
    if inbox.role(&handoff_id.to_string()) != Some(InboxRole::Recipient) {
        return Err(WATCH_FAILED.to_string());
    }
    let record = inbox
        .working_record(&handoff_id.to_string())
        .ok_or_else(|| WATCH_FAILED.to_string())?;
    let version = inbox
        .working_version(&handoff_id.to_string())
        .ok_or_else(|| WATCH_FAILED.to_string())?;
    let filename = record.filename.clone();
    let dir = inbox_version_dir(
        &state.data_root,
        &handoff_id.to_string(),
        &version_folder_name(version)?,
    )?;
    std::fs::create_dir_all(&dir).map_err(|_| WATCH_FAILED.to_string())?;

    let app_for_watch = app.clone();
    let watched_name = filename.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            if !watch_filter(&event, &watched_name) {
                return;
            }
            schedule_debounced_recheck(app_for_watch.clone(), handoff_id);
        },
        notify::Config::default(),
    )
    .map_err(|_| WATCH_FAILED.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|_| WATCH_FAILED.to_string())?;

    state
        .watches
        .lock()
        .expect("watch lock")
        .insert(
            handoff_id,
            ActiveWatch {
                _watcher: watcher,
                generation: 0,
                debounce_token: 0,
            },
        );
    Ok(())
}

#[tauri::command]
pub fn stop_inbox_watch(state: State<AppState>, handoff_id: Uuid) -> Result<(), String> {
    state
        .watches
        .lock()
        .expect("watch lock")
        .remove(&handoff_id);
    let mut inbox = load_inbox(&state.data_root)?;
    if let Some(record) = inbox.working_record_mut(&handoff_id.to_string()) {
        crate::inbox::clear_watch_sync(record);
        save_inbox(&state.data_root, &inbox)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn recheck_inbox_file(app: AppHandle, handoff_id: Uuid) -> Result<(), String> {
    recheck_now(app, handoff_id).await
}

#[tauri::command]
pub fn get_pending_local_statuses(
    state: State<AppState>,
) -> Result<Vec<PendingLocalStatus>, String> {
    let inbox = load_inbox(&state.data_root)?;
    Ok(pending_statuses(&inbox))
}

#[tauri::command]
pub fn acknowledge_local_status_sync(
    state: State<AppState>,
    handoff_id: Uuid,
    desired_status: String,
    generation: u64,
) -> Result<bool, String> {
    let mut inbox = load_inbox(&state.data_root)?;
    let Some(record) = inbox.working_record_mut(&handoff_id.to_string()) else {
        return Ok(false);
    };
    let ok = acknowledge_sync(record, &desired_status, generation);
    save_inbox(&state.data_root, &inbox)?;
    Ok(ok)
}

#[tauri::command]
pub fn recheck_all_inbox_files(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let inbox = load_inbox(&state.data_root)?;
    let ids: Vec<Uuid> = inbox
        .handoffs
        .iter()
        .filter(|(_, handoff)| handoff.role == InboxRole::Recipient)
        .filter_map(|(id, _)| Uuid::parse_str(id).ok())
        .collect();
    for id in ids {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = recheck_now(handle, id).await;
        });
    }
    Ok(())
}

fn snapshot_tmp_path(root: &Path, handoff_id: Uuid, snapshot_id: Uuid) -> PathBuf {
    tmp_dir(root).join(format!("return-{handoff_id}-{snapshot_id}.part"))
}

fn hash_or_busy(path: &Path) -> Result<(u64, String), String> {
    hash_path(path).map_err(|err| {
        if err == FILE_BUSY {
            FILE_BUSY.to_string()
        } else {
            err
        }
    })
}

fn copy_hashed(src: &Path, dest: &Path) -> Result<(u64, String), String> {
    let mut input = std::fs::File::open(src).map_err(|err| {
        if is_file_busy(&err) {
            FILE_BUSY.to_string()
        } else {
            SEND_FAILED.to_string()
        }
    })?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| SEND_FAILED.to_string())?;
    }
    let mut output = std::fs::File::create(dest).map_err(|_| SEND_FAILED.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 65_536];
    let mut size = 0u64;
    loop {
        use std::io::Read;
        let n = input
            .read(&mut buf)
            .map_err(|err| {
                if is_file_busy(&err) {
                    FILE_BUSY.to_string()
                } else {
                    SEND_FAILED.to_string()
                }
            })?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_FILE_SIZE {
            return Err(FILE_TOO_LARGE.to_string());
        }
        hasher.update(&buf[..n]);
        std::io::Write::write_all(&mut output, &buf[..n]).map_err(|_| SEND_FAILED.to_string())?;
    }
    output.flush().map_err(|_| SEND_FAILED.to_string())?;
    output.sync_all().map_err(|_| SEND_FAILED.to_string())?;
    if size == 0 {
        return Err(SEND_FAILED.to_string());
    }
    Ok((size, hasher.finalize().to_hex().to_string()))
}

#[tauri::command]
pub fn prepare_return_snapshot(
    state: State<AppState>,
    handoff_id: Uuid,
) -> Result<PreparedSnapshot, String> {
    let inbox = load_inbox(&state.data_root)?;
    let record = inbox
        .working_record(&handoff_id.to_string())
        .ok_or_else(|| SEND_FAILED.to_string())?;
    let version = inbox
        .working_version(&handoff_id.to_string())
        .ok_or_else(|| SEND_FAILED.to_string())?;
    let src = working_path(&state.data_root, handoff_id, &record.filename, version)?;
    let before = hash_or_busy(&src)?;
    if before.0 > MAX_FILE_SIZE {
        return Err(FILE_TOO_LARGE.to_string());
    }
    let snapshot_id = Uuid::new_v4();
    let dest = snapshot_tmp_path(&state.data_root, handoff_id, snapshot_id);
    let copied = match copy_hashed(&src, &dest) {
        Ok(copied) => copied,
        Err(err) => {
            let _ = std::fs::remove_file(&dest);
            return Err(err);
        }
    };
    let after = match hash_or_busy(&src) {
        Ok(after) => after,
        Err(err) => {
            let _ = std::fs::remove_file(&dest);
            return Err(err);
        }
    };
    if before != copied || copied != after {
        let _ = std::fs::remove_file(&dest);
        return Err(FILE_CHANGED_DURING_RETURN.to_string());
    }
    state.snapshots.lock().expect("snapshot lock").insert(
        snapshot_id,
        ReturnSnapshot {
            path: dest,
            handoff_id,
            size: copied.0,
            blake3: copied.1.clone(),
        },
    );
    Ok(PreparedSnapshot {
        return_snapshot_id: snapshot_id,
        file_size: copied.0,
        blake3: copied.1,
    })
}

#[tauri::command]
pub fn discard_return_snapshot(
    state: State<AppState>,
    return_snapshot_id: Uuid,
) -> Result<(), String> {
    if let Some(snapshot) = state
        .snapshots
        .lock()
        .expect("snapshot lock")
        .remove(&return_snapshot_id)
    {
        let _ = std::fs::remove_file(&snapshot.path);
    }
    Ok(())
}

#[tauri::command]
pub fn confirm_return_snapshot(
    state: State<AppState>,
    return_snapshot_id: Uuid,
) -> Result<(), String> {
    let snapshot = state
        .snapshots
        .lock()
        .expect("snapshot lock")
        .get(&return_snapshot_id)
        .cloned()
        .ok_or_else(|| SNAPSHOT_UNKNOWN.to_string())?;
    let inbox = load_inbox(&state.data_root)?;
    let record = inbox
        .working_record(&snapshot.handoff_id.to_string())
        .ok_or_else(|| SNAPSHOT_UNKNOWN.to_string())?;
    let version = inbox
        .working_version(&snapshot.handoff_id.to_string())
        .ok_or_else(|| SNAPSHOT_UNKNOWN.to_string())?;
    let working = working_path(
        &state.data_root,
        snapshot.handoff_id,
        &record.filename,
        version,
    )?;
    let current = hash_or_busy(&working)?;
    if current.0 != snapshot.size || current.1 != snapshot.blake3 {
        return Err(FILE_CHANGED_DURING_RETURN.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn tus_upload_v2(
    state: State<'_, AppState>,
    return_snapshot_id: Uuid,
    access_token: String,
    handoff_id: Uuid,
    object_id: Uuid,
    storage_path: String,
    version_number: u16,
) -> Result<(), String> {
    let parsed =
        validate_storage_path_ids_version(&storage_path, handoff_id, object_id, version_number)?;
    if parsed.version != version_number || version_number < 2 {
        return Err("invalid_storage_path".to_string());
    }
    let snapshot = state
        .snapshots
        .lock()
        .expect("snapshot lock")
        .get(&return_snapshot_id)
        .cloned()
        .ok_or_else(|| SNAPSHOT_UNKNOWN.to_string())?;
    if snapshot.handoff_id != handoff_id {
        return Err(SNAPSHOT_UNKNOWN.to_string());
    }
    upload_resumable(&snapshot.path, &access_token, &storage_path, snapshot.size).await?;
    let inbox = load_inbox(&state.data_root)?;
    let record = inbox
        .working_record(&handoff_id.to_string())
        .ok_or_else(|| SEND_FAILED.to_string())?;
    let filename = record.filename.clone();
    let version_label = version_folder_name(version_number)?;
    let dest = inbox_version_dir(&state.data_root, &handoff_id.to_string(), &version_label)?
        .join(&filename);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| SEND_FAILED.to_string())?;
    }
    let tmp = dest.with_extension("copy.tmp");
    std::fs::copy(&snapshot.path, &tmp).map_err(|_| SEND_FAILED.to_string())?;
    crate::transfer::replace_file(&tmp, &dest).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        SEND_FAILED.to_string()
    })?;
    crate::inbox::remember_version(
        &state.data_root,
        handoff_id,
        &filename,
        snapshot.size,
        &snapshot.blake3,
        &version_label,
        InboxRole::Recipient,
    )?;
    Ok(())
}

pub fn recheck_on_focus<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let inbox = match load_inbox(&state.data_root) {
        Ok(inbox) => inbox,
        Err(_) => return,
    };
    for (key, handoff) in &inbox.handoffs {
        if handoff.role != InboxRole::Recipient {
            continue;
        }
        if let Ok(id) = Uuid::parse_str(key) {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = recheck_now(handle, id).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{ensure_data_layout, inbox_version_dir};

    #[test]
    fn prepared_snapshot_json_has_no_path() {
        let payload = PreparedSnapshot {
            return_snapshot_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            file_size: 4,
            blake3: "ab".repeat(32),
        };
        let json = serde_json::to_value(&payload).unwrap();
        let text = serde_json::to_string(&payload).unwrap();
        assert!(json.get("returnSnapshotId").is_some());
        assert!(json.get("fileSize").is_some());
        assert!(json.get("blake3").is_some());
        assert!(json.get("path").is_none());
        assert!(!text.contains("tmp"));
        assert!(!text.contains("C:\\\\"));
        assert!(!text.contains("token"));
    }

    #[test]
    fn orphan_cleanup_deletes_only_tmp_pattern_and_never_inbox() {
        let root = std::env::temp_dir().join(format!("filerelay-m7-{}", Uuid::new_v4()));
        ensure_data_layout(&root).unwrap();
        let handoff = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let snap = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
        let tmp = snapshot_tmp_path(&root, handoff, snap);
        std::fs::write(&tmp, b"snap").unwrap();
        let other = tmp_dir(&root).join("notes.txt");
        std::fs::write(&other, b"keep").unwrap();
        let inbox_file = inbox_version_dir(&root, &handoff.to_string(), "v1")
            .unwrap()
            .join("work.docx");
        std::fs::create_dir_all(inbox_file.parent().unwrap()).unwrap();
        std::fs::write(&inbox_file, b"inbox").unwrap();

        cleanup_orphan_snapshots(&root).unwrap();

        assert!(!tmp.exists());
        assert!(other.exists());
        assert!(inbox_file.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bump_generation_discards_stale_results_by_identity() {
        assert_eq!(BACKOFF_MS, [250, 500, 1_000, 2_000, 4_000]);
        let source = include_str!("watch.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("current != generation"));
        assert!(production.contains("debounce_token"));
        assert!(production.contains("handoff-local-state"));
        assert!(!production.contains("service_role"));
        assert!(!production.contains("x-signature"));
    }
}
