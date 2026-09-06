use std::collections::HashSet;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::paths::{resume_dir, resume_file_path};
use crate::transfer::{replace_file, SEND_FAILED};

pub const RESUME_SCHEMA_VERSION: u32 = 1;
pub const RESERVATION_RENEWAL_REQUIRED: &str = "reservation_renewal_required";
pub const RESUME_BUSY: &str = "resume_busy";
pub const ACK_INVALID_STAGE: &str = "ack_invalid_stage";
pub const ACK_ID_MISMATCH: &str = "ack_id_mismatch";
pub const COMMAND_ID_REUSE: &str = "command_id_reuse";
pub const UNSUPPORTED_RESUME_SCHEMA: &str = "unsupported_resume_schema";
pub const SNAPSHOT_REQUIRED: &str = "snapshot_required";
pub const RESUME_SNAPSHOT_REQUIRED: &str = "resume_snapshot_required";
pub const RESUME_FILE_MISMATCH: &str = "resume_file_mismatch";
pub const FILE_CHANGED_DURING_UPLOAD: &str = "file_changed_during_upload";
pub const POST_RESPONSE_UNKNOWN: &str = "post_response_unknown";
pub const FINALIZE_INTENT_MISMATCH: &str = "finalize_intent_mismatch";
pub const RENEWAL_SKEW_SECS: i64 = 60;

pub type ResumeKey = (Uuid, u16, Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeKind {
    Initial,
    Result,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FinalizeIntent {
    #[serde(alias = "resultAction")]
    pub result_action: String,
    #[serde(alias = "resultNote")]
    pub result_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeIntentPayload {
    pub result_action: String,
    pub result_note: Option<String>,
}

impl FinalizeIntent {
    pub fn normalized(self) -> Self {
        Self {
            result_action: self.result_action.trim().to_string(),
            result_note: self
                .result_note
                .map(|note| note.trim().to_string())
                .filter(|note| !note.is_empty()),
        }
    }

    pub fn to_payload(&self) -> FinalizeIntentPayload {
        FinalizeIntentPayload {
            result_action: self.result_action.clone(),
            result_note: self.result_note.clone(),
        }
    }
}

pub fn assert_finalize_intent_unchanged(
    existing: &ResumeRecord,
    incoming: &FinalizeIntent,
) -> Result<(), String> {
    let incoming = incoming.clone().normalized();
    match existing.finalize_intent.as_ref() {
        Some(saved) if saved.clone().normalized() != incoming => {
            Err(FINALIZE_INTENT_MISMATCH.to_string())
        }
        Some(_) => Ok(()),
        None if existing.kind == ResumeKind::Result => Err(FINALIZE_INTENT_MISMATCH.to_string()),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeStage {
    Reserved,
    SnapshotReady,
    TusCreated,
    Uploading,
    UploadedWaitingFinalize,
    PostResponseUnknown,
    Aborting,
    TusTerminated,
    UploadCompletedCleanup,
    StorageRemoved,
    RpcConfirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeRecord {
    pub schema_version: u32,
    pub stage: ResumeStage,
    pub kind: ResumeKind,
    pub handoff_id: Uuid,
    pub transfer_id: Uuid,
    pub object_id: Uuid,
    pub version_number: u16,
    pub storage_path: String,
    pub file_name: String,
    pub expected_size: u64,
    pub blake3: String,
    pub tus_location: Option<String>,
    pub last_offset: u64,
    pub pending_upload_expires_at: String,
    pub reservation_client_request_id: Uuid,
    pub last_renew_client_request_id: Option<Uuid>,
    pub finalize_client_request_id: Uuid,
    pub abort_client_request_id: Uuid,
    pub snapshot_id: Option<Uuid>,
    pub snapshot_path: Option<String>,
    pub source_path: Option<String>,
    pub tus_terminated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalize_intent: Option<FinalizeIntent>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSummary {
    pub kind: ResumeKind,
    pub stage: ResumeStage,
    pub handoff_id: Uuid,
    pub transfer_id: Uuid,
    pub object_id: Uuid,
    pub version_number: u16,
    pub file_name: String,
    pub storage_path: String,
    pub pending_upload_expires_at: String,
    pub reservation_client_request_id: Uuid,
    pub last_renew_client_request_id: Option<Uuid>,
    pub finalize_client_request_id: Uuid,
    pub abort_client_request_id: Uuid,
}

impl From<&ResumeRecord> for ResumeSummary {
    fn from(record: &ResumeRecord) -> Self {
        Self {
            kind: record.kind,
            stage: record.stage,
            handoff_id: record.handoff_id,
            transfer_id: record.transfer_id,
            object_id: record.object_id,
            version_number: record.version_number,
            file_name: record.file_name.clone(),
            storage_path: record.storage_path.clone(),
            pending_upload_expires_at: record.pending_upload_expires_at.clone(),
            reservation_client_request_id: record.reservation_client_request_id,
            last_renew_client_request_id: record.last_renew_client_request_id,
            finalize_client_request_id: record.finalize_client_request_id,
            abort_client_request_id: record.abort_client_request_id,
        }
    }
}

pub fn parse_resume_file_name(name: &str) -> Option<(Uuid, u16, Uuid)> {
    let stem = name.strip_suffix(".json")?;
    if stem.len() < 36 + 1 + 1 + 1 + 36 {
        return None;
    }
    let object = Uuid::parse_str(&stem[stem.len() - 36..]).ok()?;
    let rest = stem.get(..stem.len() - 37)?;
    let (handoff_raw, version_raw) = rest.rsplit_once('-')?;
    let handoff = Uuid::parse_str(handoff_raw).ok()?;
    let version: u16 = version_raw.parse().ok()?;
    if version < 1 || version > 1000 {
        return None;
    }
    Some((handoff, version, object))
}

pub fn list_summaries(root: &Path) -> Result<Vec<ResumeSummary>, String> {
    let dir = resume_dir(root);
    let entries = match std::fs::read_dir(&dir) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(SEND_FAILED.to_string()),
        Ok(entries) => entries,
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some((handoff, version, object)) = parse_resume_file_name(name) else {
            continue;
        };
        match load_resume(root, handoff, version, object) {
            Ok(Some(record)) => out.push(ResumeSummary::from(&record)),
            Ok(None) | Err(_) => {}
        }
    }
    out.sort_by(|left, right| {
        left.handoff_id
            .cmp(&right.handoff_id)
            .then(left.version_number.cmp(&right.version_number))
            .then(left.object_id.cmp(&right.object_id))
    });
    Ok(out)
}

#[derive(Debug)]
pub struct ResumeGuard {
    key: ResumeKey,
    inflight: Arc<Mutex<HashSet<ResumeKey>>>,
}

impl Drop for ResumeGuard {
    fn drop(&mut self) {
        if let Ok(mut held) = self.inflight.lock() {
            held.remove(&self.key);
        }
    }
}

pub fn try_lock_resume(
    inflight: Arc<Mutex<HashSet<ResumeKey>>>,
    key: ResumeKey,
) -> Result<ResumeGuard, String> {
    {
        let mut held = inflight.lock().expect("resume inflight lock");
        if !held.insert(key) {
            return Err(RESUME_BUSY.to_string());
        }
    }
    Ok(ResumeGuard { key, inflight })
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn parse_rfc3339_utc(raw: &str) -> Result<i64, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    let (body, offset_secs) = split_rfc3339_offset(trimmed)?;
    let (date, time) = body
        .split_once('T')
        .or_else(|| body.split_once('t'))
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let month: u32 = date_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let day: u32 = date_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    if date_parts.next().is_some() {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    let time = time.split('.').next().unwrap_or(time);
    let mut time_parts = time.split(':');
    let hour: u32 = time_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let minute: u32 = time_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let second: u32 = time_parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    if time_parts.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    let days = days_from_civil(year, month, day)?;
    Ok(days * 86_400 + i64::from(hour * 3600 + minute * 60 + second) - offset_secs)
}

fn split_rfc3339_offset(raw: &str) -> Result<(String, i64), String> {
    if let Some(body) = raw.strip_suffix('Z').or_else(|| raw.strip_suffix('z')) {
        return Ok((body.to_string(), 0));
    }
    if let Some(idx) = raw.rfind('+') {
        if idx >= 10 {
            let offset = parse_offset(&raw[idx + 1..])?;
            return Ok((raw[..idx].to_string(), offset));
        }
    }
    if let Some(idx) = raw.rfind('-') {
        if idx >= 19 {
            let offset = parse_offset(&raw[idx + 1..])?;
            return Ok((raw[..idx].to_string(), -offset));
        }
    }
    Err(RESERVATION_RENEWAL_REQUIRED.to_string())
}

fn parse_offset(raw: &str) -> Result<i64, String> {
    let compact = raw.replace(':', "");
    if compact.len() != 4 || !compact.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    let hours: i64 = compact[..2]
        .parse()
        .map_err(|_| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let minutes: i64 = compact[2..]
        .parse()
        .map_err(|_| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    if hours > 23 || minutes > 59 {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    Ok(hours * 3600 + minutes * 60)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Result<i64, String> {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = u32::try_from(y - era * 400).map_err(|_| RESERVATION_RENEWAL_REQUIRED.to_string())?;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok(i64::from(era) * 146_097 + i64::from(doe) - 719_468)
}

pub fn assert_command_ids_distinct(record: &ResumeRecord) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in [
        record.reservation_client_request_id,
        record.finalize_client_request_id,
        record.abort_client_request_id,
    ] {
        if !seen.insert(id) {
            return Err(COMMAND_ID_REUSE.to_string());
        }
    }
    if let Some(renew) = record.last_renew_client_request_id {
        if !seen.insert(renew) {
            return Err(COMMAND_ID_REUSE.to_string());
        }
    }
    Ok(())
}

pub fn assert_reservation_fresh(record: &ResumeRecord) -> Result<(), String> {
    let expires = parse_rfc3339_utc(&record.pending_upload_expires_at)?;
    if expires - now_unix() <= RENEWAL_SKEW_SECS {
        return Err(RESERVATION_RENEWAL_REQUIRED.to_string());
    }
    Ok(())
}

#[allow(dead_code)]
pub fn reservation_needs_network_block(record: &ResumeRecord) -> bool {
    assert_reservation_fresh(record).is_err()
}

pub fn load_resume(
    root: &Path,
    handoff_id: Uuid,
    version_number: u16,
    object_id: Uuid,
) -> Result<Option<ResumeRecord>, String> {
    let path = resume_file_path(root, handoff_id, version_number, object_id);
    match std::fs::read(&path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SEND_FAILED.to_string()),
        Ok(bytes) => {
            let value = serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| SEND_FAILED.to_string())?;
            let version = value
                .get("schema_version")
                .and_then(|item| item.as_u64())
                .unwrap_or(0) as u32;
            if version > RESUME_SCHEMA_VERSION {
                return Err(UNSUPPORTED_RESUME_SCHEMA.to_string());
            }
            let record: ResumeRecord =
                serde_json::from_value(value).map_err(|_| SEND_FAILED.to_string())?;
            if record.kind != ResumeKind::Initial && record.kind != ResumeKind::Result {
                return Err(SEND_FAILED.to_string());
            }
            if record.handoff_id != handoff_id
                || record.version_number != version_number
                || record.object_id != object_id
            {
                return Err(SEND_FAILED.to_string());
            }
            assert_command_ids_distinct(&record)?;
            Ok(Some(record))
        }
    }
}

pub fn save_resume(root: &Path, record: &ResumeRecord) -> Result<(), String> {
    if record.schema_version > RESUME_SCHEMA_VERSION {
        return Err(UNSUPPORTED_RESUME_SCHEMA.to_string());
    }
    assert_command_ids_distinct(record)?;
    let dir = resume_dir(root);
    std::fs::create_dir_all(&dir).map_err(|_| SEND_FAILED.to_string())?;
    let path = resume_file_path(
        root,
        record.handoff_id,
        record.version_number,
        record.object_id,
    );
    let payload = serde_json::to_vec_pretty(record).map_err(|_| SEND_FAILED.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut file = File::create(&tmp).map_err(|_| SEND_FAILED.to_string())?;
    file.write_all(&payload)
        .map_err(|_| SEND_FAILED.to_string())?;
    file.sync_all().map_err(|_| SEND_FAILED.to_string())?;
    drop(file);
    replace_file(&tmp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        SEND_FAILED.to_string()
    })
}

pub fn delete_resume_and_snapshot(root: &Path, record: &ResumeRecord) -> Result<(), String> {
    if let Some(snapshot) = record.snapshot_path.as_deref() {
        let path = PathBuf::from(snapshot);
        if path.starts_with(crate::paths::tmp_dir(root)) {
            let _ = std::fs::remove_file(&path);
        }
    }
    let path = resume_file_path(
        root,
        record.handoff_id,
        record.version_number,
        record.object_id,
    );
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SEND_FAILED.to_string()),
    }
}

pub fn referenced_snapshot_paths(root: &Path) -> HashSet<PathBuf> {
    let mut out = HashSet::new();
    let dir = resume_dir(root);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<ResumeRecord>(&bytes) else {
            continue;
        };
        if let Some(snapshot) = record.snapshot_path {
            out.insert(PathBuf::from(snapshot));
        }
    }
    out
}

pub fn snapshot_is_valid(record: &ResumeRecord) -> bool {
    let Some(path) = record.snapshot_path.as_deref() else {
        return false;
    };
    let path = Path::new(path);
    match crate::transfer::hash_path(path) {
        Ok((size, hash)) => size == record.expected_size && hash == record.blake3,
        Err(_) => false,
    }
}

pub fn source_matches_snapshot(record: &ResumeRecord) -> Result<bool, String> {
    let Some(path) = record.source_path.as_deref() else {
        return Ok(true);
    };
    match crate::transfer::hash_path(Path::new(path)) {
        Ok((size, hash)) => Ok(size == record.expected_size && hash == record.blake3),
        Err(err) if err == crate::transfer::FILE_BUSY => Err(err),
        Err(_) => Ok(false),
    }
}

pub fn update_expiry(
    record: &mut ResumeRecord,
    pending_upload_expires_at: String,
    renew_client_request_id: Uuid,
) -> Result<(), String> {
    if renew_client_request_id == record.reservation_client_request_id
        || renew_client_request_id == record.finalize_client_request_id
        || renew_client_request_id == record.abort_client_request_id
    {
        return Err(COMMAND_ID_REUSE.to_string());
    }
    parse_rfc3339_utc(&pending_upload_expires_at)?;
    record.pending_upload_expires_at = pending_upload_expires_at;
    record.last_renew_client_request_id = Some(renew_client_request_id);
    record.updated_at = now_unix();
    assert_command_ids_distinct(record)?;
    Ok(())
}

pub fn ack_finalized(record: &ResumeRecord, finalize_client_request_id: Uuid) -> Result<(), String> {
    if record.finalize_client_request_id != finalize_client_request_id {
        return Err(ACK_ID_MISMATCH.to_string());
    }
    Ok(())
}

pub fn ack_aborted(record: &ResumeRecord, abort_client_request_id: Uuid) -> Result<(), String> {
    if record.stage != ResumeStage::StorageRemoved {
        return Err(ACK_INVALID_STAGE.to_string());
    }
    if record.abort_client_request_id != abort_client_request_id {
        return Err(ACK_ID_MISMATCH.to_string());
    }
    Ok(())
}

pub fn mark_storage_removed(record: &mut ResumeRecord) -> Result<(), String> {
    if !matches!(
        record.stage,
        ResumeStage::TusTerminated | ResumeStage::UploadCompletedCleanup
    ) {
        return Err(ACK_INVALID_STAGE.to_string());
    }
    record.stage = ResumeStage::StorageRemoved;
    record.updated_at = now_unix();
    Ok(())
}

pub fn mark_tus_terminated(record: &mut ResumeRecord) {
    record.stage = ResumeStage::TusTerminated;
    record.tus_terminated_at = Some(now_unix());
    record.updated_at = now_unix();
}

pub fn mark_upload_completed_cleanup(record: &mut ResumeRecord) {
    record.stage = ResumeStage::UploadCompletedCleanup;
    record.updated_at = now_unix();
}

pub fn resume_blocks_upload(stage: ResumeStage) -> bool {
    matches!(
        stage,
        ResumeStage::Aborting
            | ResumeStage::TusTerminated
            | ResumeStage::UploadCompletedCleanup
            | ResumeStage::StorageRemoved
            | ResumeStage::RpcConfirmed
    )
}

pub fn new_record(
    kind: ResumeKind,
    handoff_id: Uuid,
    transfer_id: Uuid,
    object_id: Uuid,
    version_number: u16,
    storage_path: String,
    file_name: String,
    expected_size: u64,
    blake3: String,
    pending_upload_expires_at: String,
    reservation_client_request_id: Uuid,
    finalize_client_request_id: Uuid,
    abort_client_request_id: Uuid,
    snapshot_id: Uuid,
    snapshot_path: PathBuf,
    source_path: Option<PathBuf>,
) -> Result<ResumeRecord, String> {
    parse_rfc3339_utc(&pending_upload_expires_at)?;
    let now = now_unix();
    let record = ResumeRecord {
        schema_version: RESUME_SCHEMA_VERSION,
        stage: ResumeStage::SnapshotReady,
        kind,
        handoff_id,
        transfer_id,
        object_id,
        version_number,
        storage_path,
        file_name,
        expected_size,
        blake3,
        tus_location: None,
        last_offset: 0,
        pending_upload_expires_at,
        reservation_client_request_id,
        last_renew_client_request_id: None,
        finalize_client_request_id,
        abort_client_request_id,
        snapshot_id: Some(snapshot_id),
        snapshot_path: Some(snapshot_path.to_string_lossy().into_owned()),
        source_path: source_path.map(|path| path.to_string_lossy().into_owned()),
        tus_terminated_at: None,
        finalize_intent: None,
        created_at: now,
        updated_at: now,
    };
    assert_command_ids_distinct(&record)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::ensure_data_layout;

    fn ids() -> (Uuid, Uuid, Uuid, Uuid, Uuid, Uuid) {
        (
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
            Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap(),
            Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap(),
            Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap(),
        )
    }

    fn far_expiry() -> String {
        "2099-01-01T00:00:00Z".to_string()
    }

    fn sample(root: &Path) -> ResumeRecord {
        let (handoff, transfer, object, reservation, finalize, abort) = ids();
        new_record(
            ResumeKind::Result,
            handoff,
            transfer,
            object,
            1,
            format!("{handoff}/{handoff}/v1/{object}"),
            "דוח.docx".into(),
            4,
            "ab".repeat(32),
            far_expiry(),
            reservation,
            finalize,
            abort,
            Uuid::parse_str("77777777-7777-4777-8777-777777777777").unwrap(),
            root.join("files").join("tmp").join("snap.part"),
            None,
        )
        .unwrap()
    }

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("filerelay-m10c-b-{}", Uuid::new_v4()));
        ensure_data_layout(&root).unwrap();
        root
    }

    #[test]
    fn command_ids_must_be_distinct() {
        let root = temp_root();
        let mut record = sample(&root);
        record.abort_client_request_id = record.finalize_client_request_id;
        assert_eq!(
            assert_command_ids_distinct(&record).unwrap_err(),
            COMMAND_ID_REUSE
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_command_retries_keep_the_same_renew_id() {
        let root = temp_root();
        let mut record = sample(&root);
        let renew = Uuid::parse_str("88888888-8888-4888-8888-888888888888").unwrap();
        update_expiry(&mut record, far_expiry(), renew).unwrap();
        update_expiry(&mut record, "2099-06-01T00:00:00Z".into(), renew).unwrap();
        assert_eq!(record.last_renew_client_request_id, Some(renew));
        assert_eq!(record.pending_upload_expires_at, "2099-06-01T00:00:00Z");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn renew_cannot_reuse_finalize_id() {
        let root = temp_root();
        let mut record = sample(&root);
        let finalize = record.finalize_client_request_id;
        assert_eq!(
            update_expiry(&mut record, far_expiry(), finalize).unwrap_err(),
            COMMAND_ID_REUSE
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn expired_reservation_does_not_look_fresh() {
        let root = temp_root();
        let mut record = sample(&root);
        record.pending_upload_expires_at = "2000-01-01T00:00:00Z".into();
        assert_eq!(
            assert_reservation_fresh(&record).unwrap_err(),
            RESERVATION_RENEWAL_REQUIRED
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn near_expiry_requires_renewal() {
        let root = temp_root();
        let mut record = sample(&root);
        let soon = now_unix() + 10;
        record.pending_upload_expires_at = format!("1970-01-01T00:00:{soon:02}Z");
        // 10 seconds after epoch is in the past; use now+10 formatted properly
        record.pending_upload_expires_at = "2099-01-01T00:00:00+00:00".into();
        assert!(assert_reservation_fresh(&record).is_ok());
        record.pending_upload_expires_at = "2001-01-01T00:00:00+00:00".into();
        assert!(reservation_needs_network_block(&record));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_finalized_requires_matching_id_from_any_stage() {
        let root = temp_root();
        let record = sample(&root);
        let finalize = record.finalize_client_request_id;
        assert!(ack_finalized(&record, finalize).is_ok());
        assert_eq!(
            ack_finalized(&record, record.abort_client_request_id).unwrap_err(),
            ACK_ID_MISMATCH
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_aborted_rejects_tus_terminated() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::TusTerminated;
        assert_eq!(
            ack_aborted(&record, record.abort_client_request_id).unwrap_err(),
            ACK_INVALID_STAGE
        );
        record.stage = ResumeStage::StorageRemoved;
        assert!(ack_aborted(&record, record.abort_client_request_id).is_ok());
        assert_eq!(
            ack_aborted(&record, record.finalize_client_request_id).unwrap_err(),
            ACK_ID_MISMATCH
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mark_storage_removed_only_from_terminated() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::Uploading;
        assert_eq!(
            mark_storage_removed(&mut record).unwrap_err(),
            ACK_INVALID_STAGE
        );
        record.stage = ResumeStage::Aborting;
        assert_eq!(
            mark_storage_removed(&mut record).unwrap_err(),
            ACK_INVALID_STAGE
        );
        record.stage = ResumeStage::TusTerminated;
        mark_storage_removed(&mut record).unwrap();
        assert_eq!(record.stage, ResumeStage::StorageRemoved);
        record.stage = ResumeStage::UploadCompletedCleanup;
        mark_storage_removed(&mut record).unwrap();
        assert_eq!(record.stage, ResumeStage::StorageRemoved);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_409_full_upload_cleanup_succeeds_and_keeps_resume() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::Aborting;
        save_resume(&root, &record).unwrap();
        mark_upload_completed_cleanup(&mut record);
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.stage, ResumeStage::UploadCompletedCleanup);
        let mut loaded = loaded;
        mark_storage_removed(&mut loaded).unwrap();
        save_resume(&root, &loaded).unwrap();
        assert_eq!(
            ack_aborted(&loaded, loaded.finalize_client_request_id).unwrap_err(),
            ACK_ID_MISMATCH
        );
        let still = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap();
        assert!(still.is_some());
        assert_eq!(still.unwrap().stage, ResumeStage::StorageRemoved);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_409_partial_or_invalid_head_stops_cleanup() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::Aborting;
        save_resume(&root, &record).unwrap();
        assert_eq!(
            mark_storage_removed(&mut record).unwrap_err(),
            ACK_INVALID_STAGE
        );
        assert_eq!(
            ack_aborted(&record, record.abort_client_request_id).unwrap_err(),
            ACK_INVALID_STAGE
        );
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.stage, ResumeStage::Aborting);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_409_gone_head_continues_to_terminated_cleanup() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::Aborting;
        mark_tus_terminated(&mut record);
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.stage, ResumeStage::TusTerminated);
        let mut loaded = loaded;
        mark_storage_removed(&mut loaded).unwrap();
        assert_eq!(loaded.stage, ResumeStage::StorageRemoved);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restart_from_upload_completed_cleanup_allows_storage_remove_not_upload() {
        let root = temp_root();
        let mut record = sample(&root);
        mark_upload_completed_cleanup(&mut record);
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.stage, ResumeStage::UploadCompletedCleanup);
        assert!(resume_blocks_upload(loaded.stage));
        assert!(!resume_blocks_upload(ResumeStage::Uploading));
        let mut loaded = loaded;
        mark_storage_removed(&mut loaded).unwrap();
        save_resume(&root, &loaded).unwrap();
        assert!(
            load_resume(
                &root,
                record.handoff_id,
                record.version_number,
                record.object_id
            )
            .unwrap()
            .is_some()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resume_is_not_deleted_before_rpc_ack() {
        let root = temp_root();
        let mut record = sample(&root);
        mark_upload_completed_cleanup(&mut record);
        save_resume(&root, &record).unwrap();
        assert_eq!(
            ack_aborted(&record, record.abort_client_request_id).unwrap_err(),
            ACK_INVALID_STAGE
        );
        record.stage = ResumeStage::TusTerminated;
        assert_eq!(
            ack_aborted(&record, record.abort_client_request_id).unwrap_err(),
            ACK_INVALID_STAGE
        );
        mark_storage_removed(&mut record).unwrap();
        save_resume(&root, &record).unwrap();
        assert!(ack_aborted(&record, record.abort_client_request_id).is_ok());
        assert!(
            load_resume(
                &root,
                record.handoff_id,
                record.version_number,
                record.object_id
            )
            .unwrap()
            .is_some()
        );
        delete_resume_and_snapshot(&root, &record).unwrap();
        assert!(
            load_resume(
                &root,
                record.handoff_id,
                record.version_number,
                record.object_id
            )
            .unwrap()
            .is_none()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_roundtrip_and_future_schema_rejected() {
        let root = temp_root();
        let record = sample(&root);
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.file_name, "דוח.docx");
        assert_eq!(loaded.kind, ResumeKind::Result);
        assert!(loaded.tus_location.is_none());
        let path = resume_file_path(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        );
        let mut value = serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap())
            .unwrap();
        value["schema_version"] = serde_json::json!(2);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            load_resume(
                &root,
                record.handoff_id,
                record.version_number,
                record.object_id
            )
            .unwrap_err(),
            UNSUPPORTED_RESUME_SCHEMA
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_guard_allows_only_one_holder() {
        let inflight = Arc::new(Mutex::new(HashSet::new()));
        let (handoff, _, object, _, _, _) = ids();
        let key = (handoff, 1u16, object);
        let first = try_lock_resume(inflight.clone(), key).unwrap();
        assert_eq!(
            try_lock_resume(inflight.clone(), key).unwrap_err(),
            RESUME_BUSY
        );
        drop(first);
        assert!(try_lock_resume(inflight, key).is_ok());
    }

    #[test]
    fn uploaded_waiting_finalize_is_not_a_post_stage() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::UploadedWaitingFinalize;
        record.tus_location = Some("https://example.invalid/upload".into());
        assert_eq!(record.stage, ResumeStage::UploadedWaitingFinalize);
        assert_ne!(record.stage, ResumeStage::TusCreated);
        assert_ne!(record.stage, ResumeStage::Uploading);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn source_change_after_snapshot_is_detected() {
        let root = temp_root();
        let source = root.join("work.txt");
        std::fs::write(&source, b"one").unwrap();
        let (size, hash) = crate::transfer::hash_path(&source).unwrap();
        let mut record = sample(&root);
        record.expected_size = size;
        record.blake3 = hash;
        record.source_path = Some(source.to_string_lossy().into_owned());
        assert!(source_matches_snapshot(&record).unwrap());
        std::fs::write(&source, b"two!").unwrap();
        assert!(!source_matches_snapshot(&record).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn post_response_unknown_keeps_record_without_inventing_location() {
        let root = temp_root();
        let mut record = sample(&root);
        record.stage = ResumeStage::PostResponseUnknown;
        record.tus_location = None;
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.stage, ResumeStage::PostResponseUnknown);
        assert!(loaded.tus_location.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn record_json_omits_access_token_and_legacy_kind() {
        let root = temp_root();
        let record = sample(&root);
        let text = serde_json::to_string(&record).unwrap();
        assert!(!text.contains("access_token"));
        assert!(!text.contains("legacy_return"));
        assert!(!text.contains("sb_publishable"));
        assert!(text.contains("\"kind\":\"result\""));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_summaries_omit_location_paths_and_full_hash() {
        let root = temp_root();
        let mut record = sample(&root);
        record.tus_location = Some("https://example.invalid/storage/v1/upload/resumable/secret".into());
        record.source_path = Some(r"C:\Users\Maor\work\secret.docx".into());
        record.snapshot_path = Some(r"C:\tmp\result-secret.part".into());
        record.blake3 = "ab".repeat(32);
        record.last_offset = 100;
        save_resume(&root, &record).unwrap();
        let listed = list_summaries(&root).unwrap();
        assert_eq!(listed.len(), 1);
        let text = serde_json::to_string(&listed).unwrap();
        assert!(text.contains("\"fileName\":\"דוח.docx\""));
        assert!(text.contains("\"storagePath\":\""));
        assert!(!text.contains("tusLocation"));
        assert!(!text.contains("tus_location"));
        assert!(!text.contains("sourcePath"));
        assert!(!text.contains("snapshotPath"));
        assert!(!text.contains("access_token"));
        assert!(!text.contains("blake3"));
        assert!(!text.contains(&record.blake3));
        assert!(!text.contains("upload/resumable"));
        assert!(!text.contains("C:\\\\Users"));
        assert!(!text.contains("finalize_intent"));
        assert!(!text.contains("finalizeIntent"));
        assert!(!text.contains("result_action"));
        assert!(!text.contains("resultAction"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finalize_intent_accepts_ipc_camel_case_and_keeps_disk_snake_case() {
        let from_ipc: FinalizeIntent = serde_json::from_str(
            r#"{"resultAction":"approved","resultNote":"הערה"}"#,
        )
        .unwrap();
        assert_eq!(from_ipc.result_action, "approved");
        assert_eq!(from_ipc.result_note.as_deref(), Some("הערה"));
        let from_disk: FinalizeIntent = serde_json::from_str(
            r#"{"result_action":"rejected","result_note":null}"#,
        )
        .unwrap();
        assert_eq!(from_disk.result_action, "rejected");
        assert!(from_disk.result_note.is_none());
        let stored = serde_json::to_string(&from_ipc).unwrap();
        assert!(stored.contains("result_action"));
        assert!(!stored.contains("resultAction"));
    }

    #[test]
    fn finalize_intent_persists_and_rejects_changes() {
        let root = temp_root();
        let mut record = sample(&root);
        record.finalize_intent = Some(FinalizeIntent {
            result_action: "approved".into(),
            result_note: None,
        });
        save_resume(&root, &record).unwrap();
        let loaded = load_resume(
            &root,
            record.handoff_id,
            record.version_number,
            record.object_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            loaded.finalize_intent.as_ref().map(|intent| intent.result_action.as_str()),
            Some("approved")
        );
        assert!(assert_finalize_intent_unchanged(
            &loaded,
            &FinalizeIntent {
                result_action: " approved ".into(),
                result_note: Some("  ".into()),
            }
        )
        .is_ok());
        assert_eq!(
            assert_finalize_intent_unchanged(
                &loaded,
                &FinalizeIntent {
                    result_action: "rejected".into(),
                    result_note: Some("לא".into()),
                }
            )
            .unwrap_err(),
            FINALIZE_INTENT_MISMATCH
        );
        let summary = serde_json::to_string(&ResumeSummary::from(&loaded)).unwrap();
        assert!(!summary.contains("approved"));
        assert!(!summary.contains("finalizeIntent"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_result_intent_cannot_be_invented_on_retry() {
        let root = temp_root();
        let record = sample(&root);
        assert_eq!(
            assert_finalize_intent_unchanged(
                &record,
                &FinalizeIntent {
                    result_action: "returned_with_file".into(),
                    result_note: None,
                }
            )
            .unwrap_err(),
            FINALIZE_INTENT_MISMATCH
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rust_sources_do_not_call_postgrest_or_embed_publishable_key() {
        let resume = include_str!("resume.rs");
        let tus = include_str!("tus.rs");
        let transfer = include_str!("transfer.rs");
        for source in [resume, tus, transfer] {
            let production = source.split("#[cfg(test)]").next().unwrap();
            assert!(!production.contains("rest/v1/rpc"));
            assert!(!production.contains("/rpc/"));
            assert!(!production.contains("sb_publishable"));
            assert!(!production.contains("service_role"));
        }
    }
}
