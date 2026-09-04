use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::paths::{inbox_state_file_path, version_folder_name};

pub const INBOX_SCHEMA_VERSION: u32 = 2;
const DOWNLOAD_FAILED: &str = "download_failed";
const UNSUPPORTED_INBOX_SCHEMA: &str = "unsupported_inbox_schema";

fn default_v1() -> String {
    "v1".to_string()
}

fn default_opened() -> String {
    "opened".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InboxRole {
    Sender,
    Recipient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRecord {
    pub filename: String,
    pub size: u64,
    pub blake3: String,
    #[serde(default = "default_v1")]
    pub version: String,
    #[serde(default)]
    pub last_checked_hash: Option<String>,
    #[serde(default)]
    pub content_differs_from_v1: bool,
    #[serde(default = "default_opened")]
    pub desired_status: String,
    #[serde(default)]
    pub pending_recheck: bool,
    #[serde(default)]
    pub pending_status_sync: bool,
    #[serde(default)]
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxHandoff {
    pub role: InboxRole,
    #[serde(default)]
    pub versions: BTreeMap<u16, InboxRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboxFile {
    #[serde(default, rename = "schema_version", alias = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default)]
    pub handoffs: BTreeMap<String, InboxHandoff>,
    #[serde(default, skip_serializing)]
    pub entries: BTreeMap<String, InboxRecord>,
    #[serde(default, skip_serializing)]
    pub returns: BTreeMap<String, InboxRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxLocalEntry {
    pub handoff_id: String,
    pub filename: String,
    pub version: String,
    pub content_differs_from_v1: bool,
    pub desired_status: String,
    pub pending_recheck: bool,
    pub pending_status_sync: bool,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLocalStatus {
    pub handoff_id: String,
    pub generation: u64,
    pub desired_status: String,
    pub content_differs_from_v1: bool,
    pub pending_recheck: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStateEvent {
    pub handoff_id: String,
    pub generation: u64,
    pub content_differs_from_v1: bool,
    pub desired_status: String,
    pub pending_recheck: bool,
}

impl InboxRecord {
    pub fn to_local_entry(&self, handoff_id: &str) -> InboxLocalEntry {
        InboxLocalEntry {
            handoff_id: handoff_id.to_string(),
            filename: self.filename.clone(),
            version: self.version.clone(),
            content_differs_from_v1: self.content_differs_from_v1,
            desired_status: self.desired_status.clone(),
            pending_recheck: self.pending_recheck,
            pending_status_sync: self.pending_status_sync,
            generation: self.generation,
        }
    }

    pub fn to_event(&self, handoff_id: &str) -> LocalStateEvent {
        LocalStateEvent {
            handoff_id: handoff_id.to_string(),
            generation: self.generation,
            content_differs_from_v1: self.content_differs_from_v1,
            desired_status: self.desired_status.clone(),
            pending_recheck: self.pending_recheck,
        }
    }
}

impl InboxFile {
    pub fn migrate_if_needed(&mut self) -> bool {
        if self.schema_version > INBOX_SCHEMA_VERSION {
            return false;
        }
        if self.schema_version == INBOX_SCHEMA_VERSION {
            self.entries.clear();
            self.returns.clear();
            return false;
        }
        let entries = std::mem::take(&mut self.entries);
        let returns = std::mem::take(&mut self.returns);
        for (id, mut record) in entries {
            record.version = "v1".to_string();
            self.upsert_version(&id, 1, InboxRole::Recipient, record);
        }
        for (id, mut record) in returns {
            record.version = "v2".to_string();
            let role = if self
                .handoffs
                .get(&id)
                .is_some_and(|handoff| handoff.role == InboxRole::Recipient)
            {
                InboxRole::Recipient
            } else {
                InboxRole::Sender
            };
            self.upsert_version(&id, 2, role, record);
        }
        self.schema_version = INBOX_SCHEMA_VERSION;
        true
    }

    pub fn upsert_version(
        &mut self,
        handoff_id: &str,
        version: u16,
        role: InboxRole,
        record: InboxRecord,
    ) {
        let handoff = self
            .handoffs
            .entry(handoff_id.to_string())
            .or_insert_with(|| InboxHandoff {
                role,
                versions: BTreeMap::new(),
            });
        if handoff.versions.is_empty() {
            handoff.role = role;
        }
        handoff.versions.insert(version, record);
    }

    pub fn highest_version(&self, handoff_id: &str) -> Option<u16> {
        self.handoffs
            .get(handoff_id)
            .and_then(|handoff| handoff.versions.keys().next_back().copied())
    }

    pub fn version_record(&self, handoff_id: &str, version: u16) -> Option<&InboxRecord> {
        self.handoffs
            .get(handoff_id)
            .and_then(|handoff| handoff.versions.get(&version))
    }

    pub fn working_version(&self, handoff_id: &str) -> Option<u16> {
        self.highest_version(handoff_id)
    }

    pub fn working_record(&self, handoff_id: &str) -> Option<&InboxRecord> {
        let version = self.working_version(handoff_id)?;
        self.version_record(handoff_id, version)
    }

    pub fn working_record_mut(&mut self, handoff_id: &str) -> Option<&mut InboxRecord> {
        let version = self.working_version(handoff_id)?;
        self.handoffs
            .get_mut(handoff_id)
            .and_then(|handoff| handoff.versions.get_mut(&version))
    }

    pub fn role(&self, handoff_id: &str) -> Option<InboxRole> {
        self.handoffs.get(handoff_id).map(|handoff| handoff.role)
    }
}

fn inbox_tmp_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn schema_version_from_value(value: &serde_json::Value) -> u32 {
    value
        .get("schema_version")
        .or_else(|| value.get("schemaVersion"))
        .and_then(|version| version.as_u64())
        .map(|version| version as u32)
        .unwrap_or(0)
}

fn peek_schema_version(bytes: &[u8]) -> Option<u32> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .map(|value| schema_version_from_value(&value))
}

fn is_unsupported_schema(bytes: &[u8]) -> bool {
    peek_schema_version(bytes).is_some_and(|version| version > INBOX_SCHEMA_VERSION)
}

fn has_canonical_schema_key(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .is_some_and(|object| object.contains_key("schema_version"))
}

fn reject_if_unsupported(bytes: &[u8]) -> Result<(), String> {
    if is_unsupported_schema(bytes) {
        Err(UNSUPPORTED_INBOX_SCHEMA.to_string())
    } else {
        Ok(())
    }
}

fn parse_inbox_bytes(bytes: &[u8]) -> Result<InboxFile, String> {
    reject_if_unsupported(bytes)?;
    serde_json::from_slice(bytes).map_err(|_| DOWNLOAD_FAILED.to_string())
}

fn recover_interrupted_save(path: &Path) -> Result<(), String> {
    let tmp = inbox_tmp_path(path);
    if !tmp.exists() {
        return Ok(());
    }
    let tmp_bytes = match std::fs::read(&tmp) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            return Ok(());
        }
    };
    if is_unsupported_schema(&tmp_bytes) {
        return Err(UNSUPPORTED_INBOX_SCHEMA.to_string());
    }
    if let Ok(original) = std::fs::read(path) {
        if is_unsupported_schema(&original) {
            return Err(UNSUPPORTED_INBOX_SCHEMA.to_string());
        }
    }
    let tmp_ok = parse_inbox_bytes(&tmp_bytes).is_ok();
    match std::fs::read(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if tmp_ok {
                replace_file(&tmp, path).map_err(|_| DOWNLOAD_FAILED.to_string())?;
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
            Ok(())
        }
        Err(_) => Err(DOWNLOAD_FAILED.to_string()),
        Ok(original) => match parse_inbox_bytes(&original) {
            Ok(_) if tmp_ok => {
                replace_file(&tmp, path).map_err(|_| DOWNLOAD_FAILED.to_string())?;
                Ok(())
            }
            Ok(_) => {
                let _ = std::fs::remove_file(&tmp);
                Ok(())
            }
            Err(code) if code == UNSUPPORTED_INBOX_SCHEMA => Err(code),
            Err(_) => {
                if !tmp_ok {
                    let _ = std::fs::remove_file(&tmp);
                }
                Ok(())
            }
        },
    }
}

fn peek_inbox_files_for_unsupported(path: &Path) -> Result<(), String> {
    if let Ok(bytes) = std::fs::read(path) {
        reject_if_unsupported(&bytes)?;
    }
    let tmp = inbox_tmp_path(path);
    if let Ok(bytes) = std::fs::read(&tmp) {
        reject_if_unsupported(&bytes)?;
    }
    Ok(())
}

pub fn load_inbox(root: &Path) -> Result<InboxFile, String> {
    let path = inbox_state_file_path(root);
    peek_inbox_files_for_unsupported(&path)?;
    recover_interrupted_save(&path)?;
    let (mut inbox, source_bytes) = match std::fs::read(&path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => (InboxFile::default(), None),
        Err(_) => return Err(DOWNLOAD_FAILED.to_string()),
        Ok(bytes) => (parse_inbox_bytes(&bytes)?, Some(bytes)),
    };
    let migrated = inbox.migrate_if_needed();
    let needs_canonical_key = source_bytes
        .as_deref()
        .is_some_and(|bytes| !has_canonical_schema_key(bytes));
    if inbox.schema_version > INBOX_SCHEMA_VERSION {
        return Err(UNSUPPORTED_INBOX_SCHEMA.to_string());
    }
    if (migrated || needs_canonical_key) && path.exists() {
        save_inbox(root, &inbox)?;
    } else if inbox.schema_version < INBOX_SCHEMA_VERSION {
        inbox.schema_version = INBOX_SCHEMA_VERSION;
    }
    Ok(inbox)
}

pub fn save_inbox(root: &Path, inbox: &InboxFile) -> Result<(), String> {
    if inbox.schema_version > INBOX_SCHEMA_VERSION {
        return Err(UNSUPPORTED_INBOX_SCHEMA.to_string());
    }
    let path = inbox_state_file_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| DOWNLOAD_FAILED.to_string())?;
    }
    let mut payload_inbox = inbox.clone();
    payload_inbox.schema_version = INBOX_SCHEMA_VERSION;
    payload_inbox.entries.clear();
    payload_inbox.returns.clear();
    let payload =
        serde_json::to_vec_pretty(&payload_inbox).map_err(|_| DOWNLOAD_FAILED.to_string())?;
    let tmp = inbox_tmp_path(&path);
    let mut file = File::create(&tmp).map_err(|_| DOWNLOAD_FAILED.to_string())?;
    file.write_all(&payload)
        .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    file.sync_all().map_err(|_| DOWNLOAD_FAILED.to_string())?;
    drop(file);
    replace_file(&tmp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        DOWNLOAD_FAILED.to_string()
    })
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    crate::transfer::replace_file(from, to)
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)
}

pub fn remember_version(
    root: &Path,
    handoff_id: Uuid,
    filename: &str,
    size: u64,
    blake3: &str,
    version: &str,
    role: InboxRole,
) -> Result<(), String> {
    let version_number = crate::paths::parse_version_segment(version)?;
    let mut inbox = load_inbox(root)?;
    let record = InboxRecord {
        filename: filename.to_string(),
        size,
        blake3: blake3.to_string(),
        version: version_folder_name(version_number)?,
        last_checked_hash: Some(blake3.to_string()),
        content_differs_from_v1: false,
        desired_status: "opened".to_string(),
        pending_recheck: false,
        pending_status_sync: false,
        generation: 0,
    };
    inbox.upsert_version(&handoff_id.to_string(), version_number, role, record);
    save_inbox(root, &inbox)
}

pub fn apply_hash_result(
    record: &mut InboxRecord,
    generation: u64,
    hash: &str,
    pending_recheck: bool,
) {
    record.generation = generation;
    record.pending_recheck = pending_recheck;
    if pending_recheck {
        return;
    }
    let differs = hash != record.blake3;
    let desired = if differs { "modified" } else { "opened" };
    let desired_changed = record.desired_status != desired;
    record.last_checked_hash = Some(hash.to_string());
    record.content_differs_from_v1 = differs;
    record.desired_status = desired.to_string();
    if desired_changed {
        record.pending_status_sync = true;
    }
}

pub fn acknowledge_sync(
    record: &mut InboxRecord,
    desired_status: &str,
    generation: u64,
) -> bool {
    if record.generation == generation && record.desired_status == desired_status {
        record.pending_status_sync = false;
        true
    } else {
        false
    }
}

pub fn pending_statuses(inbox: &InboxFile) -> Vec<PendingLocalStatus> {
    inbox
        .handoffs
        .iter()
        .filter(|(_, handoff)| handoff.role == InboxRole::Recipient)
        .filter_map(|(handoff_id, handoff)| {
            let version = handoff.versions.keys().next_back().copied()?;
            let record = handoff.versions.get(&version)?;
            if !record.pending_status_sync {
                return None;
            }
            Some(PendingLocalStatus {
                handoff_id: handoff_id.clone(),
                generation: record.generation,
                desired_status: record.desired_status.clone(),
                content_differs_from_v1: record.content_differs_from_v1,
                pending_recheck: record.pending_recheck,
            })
        })
        .collect()
}

pub fn local_entries(inbox: &InboxFile) -> Vec<InboxLocalEntry> {
    let mut out = Vec::new();
    for (handoff_id, handoff) in &inbox.handoffs {
        for record in handoff.versions.values() {
            out.push(record.to_local_entry(handoff_id));
        }
    }
    out
}

pub fn clear_watch_sync(record: &mut InboxRecord) {
    record.pending_status_sync = false;
    record.pending_recheck = false;
    record.generation = 0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{ensure_data_layout, inbox_dir, inbox_state_file_path};

    fn sample() -> InboxRecord {
        InboxRecord {
            filename: "דוח.docx".into(),
            size: 12,
            blake3: "a".repeat(64),
            version: "v1".into(),
            last_checked_hash: None,
            content_differs_from_v1: false,
            desired_status: "opened".into(),
            pending_recheck: false,
            pending_status_sync: false,
            generation: 0,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("filerelay-m9b-{label}-{}", Uuid::new_v4()));
        ensure_data_layout(&root).unwrap();
        root
    }

    #[test]
    fn hash_change_sets_modified_and_pending_sync() {
        let mut record = sample();
        apply_hash_result(&mut record, 3, &"b".repeat(64), false);
        assert_eq!(record.generation, 3);
        assert_eq!(record.desired_status, "modified");
        assert!(record.content_differs_from_v1);
        assert!(record.pending_status_sync);
        assert!(!record.pending_recheck);
    }

    #[test]
    fn matching_hash_keeps_opened_without_pending() {
        let mut record = sample();
        let original = record.blake3.clone();
        apply_hash_result(&mut record, 1, &original, false);
        assert_eq!(record.desired_status, "opened");
        assert!(!record.content_differs_from_v1);
        assert!(!record.pending_status_sync);
    }

    #[test]
    fn undo_after_modified_sets_opened_pending() {
        let mut record = sample();
        apply_hash_result(&mut record, 1, &"b".repeat(64), false);
        let original = record.blake3.clone();
        apply_hash_result(&mut record, 2, &original, false);
        assert_eq!(record.desired_status, "opened");
        assert!(!record.content_differs_from_v1);
        assert!(record.pending_status_sync);
        assert_eq!(record.generation, 2);
    }

    #[test]
    fn stale_ack_does_not_clear_newer_pending() {
        let mut record = sample();
        apply_hash_result(&mut record, 4, &"b".repeat(64), false);
        assert!(acknowledge_sync(&mut record, "modified", 4));
        let original = record.blake3.clone();
        apply_hash_result(&mut record, 5, &original, false);
        assert!(!acknowledge_sync(&mut record, "modified", 4));
        assert!(record.pending_status_sync);
        assert_eq!(record.desired_status, "opened");
        assert!(acknowledge_sync(&mut record, "opened", 5));
        assert!(!record.pending_status_sync);
    }

    #[test]
    fn locked_file_sets_pending_recheck_only() {
        let mut record = sample();
        let original = record.blake3.clone();
        apply_hash_result(&mut record, 8, &original, true);
        assert!(record.pending_recheck);
        assert_eq!(record.desired_status, "opened");
        assert!(!record.pending_status_sync);
        assert_eq!(record.generation, 8);
    }

    #[test]
    fn event_payload_omits_path_hash_and_token() {
        let record = sample();
        let json = serde_json::to_value(record.to_event("handoff-1")).unwrap();
        let text = serde_json::to_string(&json).unwrap();
        assert_eq!(json["handoffId"], "handoff-1");
        assert!(json.get("generation").is_some());
        assert!(json.get("contentDiffersFromV1").is_some());
        assert!(json.get("desiredStatus").is_some());
        assert!(json.get("pendingRecheck").is_some());
        assert!(json.get("filename").is_none());
        assert!(json.get("blake3").is_none());
        assert!(json.get("lastCheckedHash").is_none());
        assert!(json.get("path").is_none());
        assert!(!text.contains("token"));
        assert!(!text.contains("C:\\\\"));
        assert!(!text.contains("https://"));
        assert!(!text.contains("/files/inbox"));
    }

    #[test]
    fn m6_inbox_json_defaults_to_v1_opened() {
        let raw = r#"{
          "entries": {
            "11111111-1111-4111-8111-111111111111": {
              "filename": "a.txt",
              "size": 1,
              "blake3": "aa"
            }
          }
        }"#;
        let mut inbox: InboxFile = serde_json::from_str(raw).unwrap();
        assert!(inbox.migrate_if_needed());
        let record = inbox
            .version_record("11111111-1111-4111-8111-111111111111", 1)
            .unwrap();
        assert_eq!(record.version, "v1");
        assert_eq!(record.desired_status, "opened");
        assert!(!record.pending_status_sync);
        assert_eq!(
            inbox.role("11111111-1111-4111-8111-111111111111"),
            Some(InboxRole::Recipient)
        );
        assert!(inbox.entries.is_empty());
        assert!(inbox.returns.is_empty());
    }

    #[test]
    fn migrates_entries_and_returns_without_losing_fields() {
        let raw = r#"{
          "entries": {
            "11111111-1111-4111-8111-111111111111": {
              "filename": "work.txt",
              "size": 4,
              "blake3": "aaaa",
              "desiredStatus": "modified",
              "generation": 7,
              "contentDiffersFromV1": true
            }
          },
          "returns": {
            "22222222-2222-4222-8222-222222222222": {
              "filename": "back.txt",
              "size": 8,
              "blake3": "bbbb",
              "version": "v2"
            }
          }
        }"#;
        let mut inbox: InboxFile = serde_json::from_str(raw).unwrap();
        assert!(inbox.migrate_if_needed());
        let work = inbox
            .version_record("11111111-1111-4111-8111-111111111111", 1)
            .unwrap();
        assert_eq!(work.filename, "work.txt");
        assert_eq!(work.size, 4);
        assert_eq!(work.blake3, "aaaa");
        assert_eq!(work.desired_status, "modified");
        assert_eq!(work.generation, 7);
        assert!(work.content_differs_from_v1);
        assert_eq!(
            inbox.role("11111111-1111-4111-8111-111111111111"),
            Some(InboxRole::Recipient)
        );
        let returned = inbox
            .version_record("22222222-2222-4222-8222-222222222222", 2)
            .unwrap();
        assert_eq!(returned.filename, "back.txt");
        assert_eq!(returned.version, "v2");
        assert_eq!(
            inbox.role("22222222-2222-4222-8222-222222222222"),
            Some(InboxRole::Sender)
        );
        assert_eq!(inbox.schema_version, 2);
        assert!(!inbox.migrate_if_needed());
        assert_eq!(inbox.highest_version("11111111-1111-4111-8111-111111111111"), Some(1));
        assert_eq!(inbox.highest_version("22222222-2222-4222-8222-222222222222"), Some(2));
    }

    #[test]
    fn migration_is_idempotent_on_disk() {
        let root = temp_root("idem");
        let path = inbox_state_file_path(&root);
        std::fs::write(
            &path,
            r#"{
              "entries": {
                "11111111-1111-4111-8111-111111111111": {
                  "filename": "a.txt",
                  "size": 2,
                  "blake3": "cc"
                }
              }
            }"#,
        )
        .unwrap();
        let first = load_inbox(&root).unwrap();
        let second = load_inbox(&root).unwrap();
        assert_eq!(first.schema_version, 2);
        assert_eq!(second.schema_version, 2);
        assert_eq!(
            serde_json::to_string(&first.handoffs).unwrap(),
            serde_json::to_string(&second.handoffs).unwrap()
        );
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"schema_version\": 2"));
        assert!(!saved.contains("schemaVersion"));
        assert!(!saved.contains("\"entries\""));
        assert!(!saved.contains("\"returns\""));
        let first_bytes = std::fs::read(&path).unwrap();
        let _ = load_inbox(&root).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), first_bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn written_json_uses_snake_case_schema_version() {
        let root = temp_root("canon-key");
        let mut inbox = InboxFile::default();
        inbox.schema_version = 2;
        inbox.upsert_version(
            "11111111-1111-4111-8111-111111111111",
            1,
            InboxRole::Recipient,
            sample(),
        );
        save_inbox(&root, &inbox).unwrap();
        let saved = std::fs::read_to_string(inbox_state_file_path(&root)).unwrap();
        assert!(saved.contains("\"schema_version\": 2"));
        assert!(!saved.contains("schemaVersion"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_file_without_schema_field_migrates_to_2() {
        let root = temp_root("legacy-missing");
        let path = inbox_state_file_path(&root);
        std::fs::write(
            &path,
            r#"{
              "entries": {
                "11111111-1111-4111-8111-111111111111": {
                  "filename": "a.txt",
                  "size": 2,
                  "blake3": "cc"
                }
              }
            }"#,
        )
        .unwrap();
        let loaded = load_inbox(&root).unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert!(loaded
            .version_record("11111111-1111-4111-8111-111111111111", 1)
            .is_some());
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"schema_version\": 2"));
        assert!(!saved.contains("schemaVersion"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_version_1_migrates_to_2() {
        let root = temp_root("schema-1");
        let path = inbox_state_file_path(&root);
        std::fs::write(
            &path,
            r#"{
              "schema_version": 1,
              "entries": {
                "11111111-1111-4111-8111-111111111111": {
                  "filename": "a.txt",
                  "size": 2,
                  "blake3": "cc"
                }
              }
            }"#,
        )
        .unwrap();
        let loaded = load_inbox(&root).unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(
            loaded
                .version_record("11111111-1111-4111-8111-111111111111", 1)
                .unwrap()
                .filename,
            "a.txt"
        );
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"schema_version\": 2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_version_alias_is_read_and_rewritten_canonically() {
        let root = temp_root("alias");
        let path = inbox_state_file_path(&root);
        std::fs::write(
            &path,
            r#"{
              "schemaVersion": 2,
              "handoffs": {
                "11111111-1111-4111-8111-111111111111": {
                  "role": "recipient",
                  "versions": {
                    "1": {
                      "filename": "a.txt",
                      "size": 2,
                      "blake3": "cc",
                      "version": "v1"
                    }
                  }
                }
              }
            }"#,
        )
        .unwrap();
        let loaded = load_inbox(&root).unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(
            loaded
                .version_record("11111111-1111-4111-8111-111111111111", 1)
                .unwrap()
                .filename,
            "a.txt"
        );
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"schema_version\": 2"));
        assert!(!saved.contains("schemaVersion"));
        let after_rewrite = std::fs::read(&path).unwrap();
        let _ = load_inbox(&root).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), after_rewrite);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn future_schema_is_rejected_without_touching_files() {
        let root = temp_root("future");
        let path = inbox_state_file_path(&root);
        let inbox_json = r#"{
          "schema_version": 3,
          "handoffs": {
            "future-only": {
              "role": "recipient",
              "versions": {
                "9": {
                  "filename": "future.txt",
                  "size": 9,
                  "blake3": "ff"
                }
              }
            }
          }
        }"#;
        let tmp_json = r#"{"schema_version":3,"note":"leave-tmp"}"#;
        std::fs::write(&path, inbox_json).unwrap();
        let tmp = inbox_tmp_path(&path);
        std::fs::write(&tmp, tmp_json).unwrap();
        let keep = inbox_dir(&root)
            .join("11111111-1111-4111-8111-111111111111")
            .join("v1")
            .join("keep.txt");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep-me").unwrap();
        assert_eq!(
            load_inbox(&root).unwrap_err(),
            "unsupported_inbox_schema"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), inbox_json);
        assert_eq!(std::fs::read_to_string(&tmp).unwrap(), tmp_json);
        assert_eq!(std::fs::read(&keep).unwrap(), b"keep-me");
        assert!(tmp.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_json_does_not_delete_inbox_files() {
        let root = temp_root("corrupt");
        let path = inbox_state_file_path(&root);
        std::fs::write(&path, "{not-json").unwrap();
        let keep = inbox_dir(&root)
            .join("11111111-1111-4111-8111-111111111111")
            .join("v1")
            .join("keep.txt");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep-me").unwrap();
        assert!(load_inbox(&root).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not-json");
        assert_eq!(std::fs::read(&keep).unwrap(), b"keep-me");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn interrupted_tmp_rename_is_recovered_without_deleting_files() {
        let root = temp_root("tmp");
        let path = inbox_state_file_path(&root);
        std::fs::write(
            &path,
            r#"{
              "entries": {
                "11111111-1111-4111-8111-111111111111": {
                  "filename": "old.txt",
                  "size": 1,
                  "blake3": "old"
                }
              }
            }"#,
        )
        .unwrap();
        let keep = inbox_dir(&root)
            .join("11111111-1111-4111-8111-111111111111")
            .join("v1")
            .join("old.txt");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"bytes").unwrap();
        let mut recovered = InboxFile::default();
        recovered.schema_version = 2;
        recovered.upsert_version(
            "11111111-1111-4111-8111-111111111111",
            1,
            InboxRole::Recipient,
            InboxRecord {
                filename: "old.txt".into(),
                size: 1,
                blake3: "newhash".into(),
                version: "v1".into(),
                last_checked_hash: None,
                content_differs_from_v1: false,
                desired_status: "opened".into(),
                pending_recheck: false,
                pending_status_sync: false,
                generation: 0,
            },
        );
        std::fs::write(
            inbox_tmp_path(&path),
            serde_json::to_vec_pretty(&recovered).unwrap(),
        )
        .unwrap();
        let loaded = load_inbox(&root).unwrap();
        assert_eq!(
            loaded
                .version_record("11111111-1111-4111-8111-111111111111", 1)
                .unwrap()
                .blake3,
            "newhash"
        );
        assert_eq!(std::fs::read(&keep).unwrap(), b"bytes");
        assert!(!inbox_tmp_path(&path).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn open_prefers_highest_local_version() {
        let mut inbox = InboxFile {
            schema_version: 2,
            ..InboxFile::default()
        };
        let mut v1 = sample();
        v1.version = "v1".into();
        let mut v3 = sample();
        v3.version = "v3".into();
        v3.filename = "later.txt".into();
        inbox.upsert_version("h1", 1, InboxRole::Recipient, v1);
        inbox.upsert_version("h1", 3, InboxRole::Recipient, v3);
        assert_eq!(inbox.highest_version("h1"), Some(3));
        assert_eq!(inbox.working_record("h1").unwrap().filename, "later.txt");
        assert_ne!(inbox.highest_version("h1"), Some(2));
    }
}
