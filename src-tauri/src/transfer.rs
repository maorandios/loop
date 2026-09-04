use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::copy::HE;
use crate::inbox::{self, InboxLocalEntry, InboxRole};
use crate::paths::{inbox_version_dir, parse_version_segment, version_folder_name};
use crate::state::AppState;

pub const TUS_CHUNK_SIZE: usize = 6 * 1024 * 1024;
pub const MAX_FILE_SIZE: u64 = 52_428_800;

pub(crate) const FILE_TOO_LARGE: &str = "file_too_large";
pub(crate) const SEND_FAILED: &str = "send_failed";
pub(crate) const FILE_BUSY: &str = "file_busy";
pub(crate) const FILE_CHANGED_DURING_RETURN: &str = "file_changed_during_return";
const DOWNLOAD_FAILED: &str = "download_failed";
const HASH_MISMATCH: &str = "hash_mismatch";
const SELECTION_UNKNOWN: &str = "selection_unknown";
const INVALID_STORAGE_PATH: &str = "invalid_storage_path";
const INVALID_DOWNLOAD_URL: &str = "invalid_download_url";

pub fn project_ref() -> &'static str {
    include_str!(concat!(env!("OUT_DIR"), "/filerelay_project_ref.txt")).trim()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub selection_id: Uuid,
    pub original_filename: String,
    pub size: u64,
    pub blake3: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedStoragePath {
    pub workspace_id: Uuid,
    pub handoff_id: Uuid,
    pub version: u16,
    pub object_id: Uuid,
}

pub fn sanitize_filename(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 255 {
        return Err(SEND_FAILED.to_string());
    }
    if trimmed.contains(['/', '\\']) || trimmed.contains("..") {
        return Err(SEND_FAILED.to_string());
    }

    let mut cleaned: String = trimmed
        .chars()
        .filter(|ch| {
            !ch.is_control()
                && !matches!(
                    *ch,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect();
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    if cleaned.is_empty() {
        cleaned = "file".to_string();
    }

    let stem = cleaned
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(cleaned.as_str());
    if is_reserved_stem(stem) {
        cleaned = format!("_{cleaned}");
    }
    Ok(cleaned)
}

fn is_reserved_stem(stem: &str) -> bool {
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn parse_uuid_part(raw: &str) -> Result<Uuid, String> {
    if raw.len() != 36 {
        return Err(INVALID_STORAGE_PATH.to_string());
    }
    let bytes = raw.as_bytes();
    const HYPHENS: [usize; 4] = [8, 13, 18, 23];
    for (index, byte) in bytes.iter().enumerate() {
        if HYPHENS.contains(&index) {
            if *byte != b'-' {
                return Err(INVALID_STORAGE_PATH.to_string());
            }
        } else if !is_hex_byte(*byte) {
            return Err(INVALID_STORAGE_PATH.to_string());
        }
    }
    Uuid::parse_str(raw).map_err(|_| INVALID_STORAGE_PATH.to_string())
}

pub fn parse_storage_path(raw: &str) -> Result<ParsedStoragePath, String> {
    if raw.contains("//") {
        return Err(INVALID_STORAGE_PATH.to_string());
    }
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() != 4 || parts.iter().any(|part| part.is_empty()) {
        return Err(INVALID_STORAGE_PATH.to_string());
    }
    let version = parse_version_segment(parts[2])?;
    let workspace_id = parse_uuid_part(parts[0])?;
    let handoff_id = parse_uuid_part(parts[1])?;
    let object_id = parse_uuid_part(parts[3])?;
    Ok(ParsedStoragePath {
        workspace_id,
        handoff_id,
        version,
        object_id,
    })
}

pub fn validate_storage_path_ids(
    storage_path: &str,
    handoff_id: Uuid,
    object_id: Uuid,
) -> Result<ParsedStoragePath, String> {
    validate_storage_path_ids_version(storage_path, handoff_id, object_id, 1)
}

pub fn validate_storage_path_ids_version(
    storage_path: &str,
    handoff_id: Uuid,
    object_id: Uuid,
    version: u16,
) -> Result<ParsedStoragePath, String> {
    let parsed = parse_storage_path(storage_path)?;
    if parsed.version != version || parsed.handoff_id != handoff_id || parsed.object_id != object_id
    {
        return Err(INVALID_STORAGE_PATH.to_string());
    }
    Ok(parsed)
}

pub fn tus_endpoint(project_ref: &str) -> String {
    format!("https://{project_ref}.storage.supabase.co/storage/v1/upload/resumable")
}

pub fn is_allowed_download_host(host: &str, project_ref: &str) -> bool {
    let expected_storage = format!("{project_ref}.storage.supabase.co");
    let expected_api = format!("{project_ref}.supabase.co");
    host.eq_ignore_ascii_case(&expected_storage) || host.eq_ignore_ascii_case(&expected_api)
}

pub fn validate_download_url(
    raw: &str,
    handoff_id: Uuid,
    project_ref: &str,
) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| INVALID_DOWNLOAD_URL.to_string())?;
    if url.scheme() != "https" {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    if url.port_or_known_default() != Some(443) {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    let host = url.host_str().ok_or_else(|| INVALID_DOWNLOAD_URL.to_string())?;
    if !is_allowed_download_host(host, project_ref) {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    let path = url.path();
    let decoded = percent_decode_path(path);
    if decoded.contains("..") || path.to_ascii_lowercase().contains("%2e%2e") {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    let segments: Vec<&str> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    let filerelay_at = segments
        .iter()
        .position(|part| *part == "filerelay")
        .ok_or_else(|| INVALID_DOWNLOAD_URL.to_string())?;
    let after = &segments[filerelay_at + 1..];
    if after.len() != 4 {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    if parse_version_segment(after[2]).is_err() {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    let path_handoff =
        parse_uuid_part(after[1]).map_err(|_| INVALID_DOWNLOAD_URL.to_string())?;
    if path_handoff != handoff_id {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    if parse_uuid_part(after[0]).is_err() || parse_uuid_part(after[3]).is_err() {
        return Err(INVALID_DOWNLOAD_URL.to_string());
    }
    Ok(url)
}

fn percent_decode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push(char::from((hi << 4) | lo));
                i += 3;
                continue;
            }
        }
        out.push(char::from(bytes[i]));
        i += 1;
    }
    out
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn is_file_busy(err: &io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        err.kind() == io::ErrorKind::PermissionDenied
    }
}

pub(crate) fn hash_path(path: &Path) -> Result<(u64, String), String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if is_file_busy(&err) => return Err(FILE_BUSY.to_string()),
        Err(_) => return Err(SEND_FAILED.to_string()),
    };
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 65_536];
    let mut size = 0u64;
    loop {
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(err) if is_file_busy(&err) => return Err(FILE_BUSY.to_string()),
            Err(_) => return Err(SEND_FAILED.to_string()),
        };
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_FILE_SIZE {
            return Err(FILE_TOO_LARGE.to_string());
        }
        hasher.update(&buf[..n]);
    }
    if size == 0 {
        return Err(SEND_FAILED.to_string());
    }
    Ok((size, hasher.finalize().to_hex().to_string()))
}

fn hash_file(path: &Path) -> Result<(u64, String), String> {
    hash_path(path)
}

async fn hash_file_async(path: &Path, err: &'static str) -> Result<(u64, String), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| err.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 65_536];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf).await.map_err(|_| err.to_string())?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((size, hasher.finalize().to_hex().to_string()))
}

pub fn is_allowed_redirect_url(url: &reqwest::Url, project_ref: &str) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port_or_known_default() != Some(443) {
        return false;
    }
    match url.host_str() {
        Some(host) => is_allowed_download_host(host, project_ref),
        None => false,
    }
}

fn http_client(fail: &'static str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if is_allowed_redirect_url(attempt.url(), project_ref()) {
                attempt.follow()
            } else {
                attempt.error(INVALID_DOWNLOAD_URL)
            }
        }))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| fail.to_string())
}

fn tus_metadata_pairs(storage_path: &str) -> [(&'static str, &str); 4] {
    [
        ("bucketName", "filerelay"),
        ("objectName", storage_path),
        ("contentType", "application/octet-stream"),
        ("cacheControl", "3600"),
    ]
}

fn tus_metadata(storage_path: &str) -> String {
    tus_metadata_pairs(storage_path)
        .iter()
        .map(|(key, value)| format!("{key} {}", B64.encode(value.as_bytes())))
        .collect::<Vec<_>>()
        .join(",")
}

fn tus_metadata_key_names(storage_path: &str) -> Vec<&'static str> {
    tus_metadata_pairs(storage_path)
        .iter()
        .map(|(key, _)| *key)
        .collect()
}

pub fn storage_path_shape(storage_path: &str) -> String {
    storage_path
        .split('/')
        .map(|part| {
            if Uuid::parse_str(part).is_ok() {
                "{uuid}"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_hex_byte(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')
}

fn looks_like_uuid(bytes: &[u8]) -> bool {
    if bytes.len() < 36 {
        return false;
    }
    const HYPHENS: [usize; 4] = [8, 13, 18, 23];
    for (index, byte) in bytes[..36].iter().enumerate() {
        if HYPHENS.contains(&index) {
            if *byte != b'-' {
                return false;
            }
        } else if !is_hex_byte(*byte) {
            return false;
        }
    }
    true
}

fn redact_uuids(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if looks_like_uuid(&bytes[i..]) {
            out.push_str("{uuid}");
            i += 36;
            continue;
        }
        out.push(char::from(bytes[i]));
        i += 1;
    }
    out
}

fn redact_jwts(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].len() >= 3 && &bytes[i..i + 3] == b"eyJ" {
            out.push_str("[redacted]");
            i += 3;
            while i < bytes.len() {
                let byte = bytes[i];
                if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        out.push(char::from(bytes[i]));
        i += 1;
    }
    out
}

pub fn sanitize_tus_error_text(raw: &str) -> String {
    let redacted = redact_uuids(&redact_jwts(raw));
    redacted.chars().take(240).collect()
}

pub fn tus_error_code_and_message(body: &str) -> (Option<String>, Option<String>) {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let code = value
            .get("statusCode")
            .or_else(|| value.get("code"))
            .or_else(|| value.get("status"))
            .and_then(|item| match item {
                serde_json::Value::String(text) => Some(sanitize_tus_error_text(text)),
                serde_json::Value::Number(number) => Some(number.to_string()),
                _ => None,
            });
        let error = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(|item| item.as_str())
            .map(sanitize_tus_error_text);
        return (code, error);
    }
    (None, Some(sanitize_tus_error_text(trimmed)))
}

pub fn format_tus_post_failure_log(
    status: u16,
    body: &str,
    endpoint: &str,
    upload_length: u64,
    header_names: &[&str],
    metadata_keys: &[&str],
    storage_path: &str,
) -> String {
    let (code, error) = tus_error_code_and_message(body);
    let parsed = reqwest::Url::parse(endpoint).ok();
    let host = parsed
        .as_ref()
        .and_then(|url| url.host_str())
        .unwrap_or("unknown");
    let endpoint_path = parsed
        .as_ref()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| "/".to_string());
    format!(
        "tus_post_failed status={status} code={} error={} host={} endpoint_path={} upload_length={upload_length} header_names={} metadata_keys={} path_shape={}",
        code.as_deref().unwrap_or("-"),
        error.as_deref().unwrap_or("-"),
        host,
        endpoint_path,
        header_names.join(","),
        metadata_keys.join(","),
        storage_path_shape(storage_path),
    )
}

fn log_tus_post_failure(
    status: u16,
    body: &str,
    endpoint: &str,
    upload_length: u64,
    header_names: &[&str],
    metadata_keys: &[&str],
    storage_path: &str,
) {
    eprintln!(
        "{}",
        format_tus_post_failure_log(
            status,
            body,
            endpoint,
            upload_length,
            header_names,
            metadata_keys,
            storage_path,
        )
    );
}

struct PartCleanup {
    path: PathBuf,
    keep: bool,
}

impl Drop for PartCleanup {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) async fn upload_resumable(
    path: &Path,
    access_token: &str,
    storage_path: &str,
    expected_size: u64,
) -> Result<(), String> {
    let client = http_client(SEND_FAILED)?;
    let endpoint = tus_endpoint(project_ref());
    let post_header_names = [
        "Tus-Resumable",
        "Upload-Length",
        "Upload-Metadata",
        "Authorization",
        "x-upsert",
    ];
    let metadata_keys = tus_metadata_key_names(storage_path);
    let create = client
        .post(&endpoint)
        .header("Tus-Resumable", "1.0.0")
        .header("Upload-Length", expected_size.to_string())
        .header("Upload-Metadata", tus_metadata(storage_path))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("x-upsert", "false")
        .send()
        .await
        .map_err(|_| SEND_FAILED.to_string())?;
    if !create.status().is_success() && create.status().as_u16() != 201 {
        let status = create.status().as_u16();
        let body = create.text().await.unwrap_or_default();
        log_tus_post_failure(
            status,
            &body,
            &endpoint,
            expected_size,
            &post_header_names,
            &metadata_keys,
            storage_path,
        );
        return Err(SEND_FAILED.to_string());
    }
    let location = create
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| SEND_FAILED.to_string())?
        .to_string();
    drop(create);
    let patch_url = reqwest::Url::parse(&endpoint)
        .map_err(|_| SEND_FAILED.to_string())?
        .join(&location)
        .map_err(|_| SEND_FAILED.to_string())?;
    if !is_allowed_redirect_url(&patch_url, project_ref()) {
        return Err(SEND_FAILED.to_string());
    }

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| SEND_FAILED.to_string())?;
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; TUS_CHUNK_SIZE];
    while offset < expected_size {
        let remaining = (expected_size - offset) as usize;
        let want = remaining.min(TUS_CHUNK_SIZE);
        let mut filled = 0;
        while filled < want {
            let n = file
                .read(&mut buf[filled..want])
                .await
                .map_err(|_| SEND_FAILED.to_string())?;
            if n == 0 {
                return Err(SEND_FAILED.to_string());
            }
            filled += n;
        }
        let response = client
            .patch(patch_url.clone())
            .header("Tus-Resumable", "1.0.0")
            .header("Upload-Offset", offset.to_string())
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/offset+octet-stream",
            )
            .header("Authorization", format!("Bearer {access_token}"))
            .body(buf[..filled].to_vec())
            .send()
            .await
            .map_err(|_| SEND_FAILED.to_string())?;
        if !response.status().is_success() && response.status().as_u16() != 204 {
            return Err(SEND_FAILED.to_string());
        }
        offset += filled as u64;
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    rename_file(from, to, true)
}

#[cfg(windows)]
fn rename_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    rename_file(from, to, false)
}

#[cfg(windows)]
fn rename_file(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    let src: Vec<u16> = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dest: Vec<u16> = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    let ok = unsafe { MoveFileExW(src.as_ptr(), dest.as_ptr(), flags) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(not(windows))]
fn rename_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists"));
    }
    fs::rename(from, to)
}

fn final_inbox_path(root: &Path, handoff_id: Uuid, filename: &str, version: &str) -> Result<PathBuf, String> {
    Ok(inbox_version_dir(root, &handoff_id.to_string(), version)?.join(filename))
}

async fn file_matches(path: &Path, expected_size: u64, expected_blake3: &str) -> bool {
    match hash_file_async(path, DOWNLOAD_FAILED).await {
        Ok((size, hash)) => size == expected_size && hash == expected_blake3,
        Err(_) => false,
    }
}

fn open_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|_| DOWNLOAD_FAILED.to_string())
}

async fn download_to_part(
    url: &reqwest::Url,
    part_path: &Path,
    expected_size: u64,
    expected_blake3: &str,
) -> Result<(), String> {
    let mut cleanup = PartCleanup {
        path: part_path.to_path_buf(),
        keep: false,
    };
    let client = http_client(DOWNLOAD_FAILED)?;
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    if !response.status().is_success() {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    if let Some(parent) = part_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    }
    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut written = 0u64;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| DOWNLOAD_FAILED.to_string())?;
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        written += chunk.len() as u64;
        if written > expected_size || written > MAX_FILE_SIZE {
            return Err(DOWNLOAD_FAILED.to_string());
        }
        hasher.update(&chunk);
        if file.write_all(&chunk).await.is_err() {
            return Err(DOWNLOAD_FAILED.to_string());
        }
    }
    if file.flush().await.is_err() || file.sync_all().await.is_err() {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    drop(file);
    let hash = hasher.finalize().to_hex().to_string();
    if written != expected_size {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    if hash != expected_blake3 {
        return Err(HASH_MISMATCH.to_string());
    }
    cleanup.keep = true;
    Ok(())
}

#[tauri::command]
pub fn pick_send_file(app: AppHandle, state: State<AppState>) -> Result<Option<PickedFile>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| SEND_FAILED.to_string())?;
    let meta = fs::metadata(&path).map_err(|_| SEND_FAILED.to_string())?;
    if !meta.is_file() {
        return Err(SEND_FAILED.to_string());
    }
    if meta.len() == 0 || meta.len() > MAX_FILE_SIZE {
        return Err(FILE_TOO_LARGE.to_string());
    }
    let original = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SEND_FAILED.to_string())?;
    let original_filename = sanitize_filename(original)?;
    let (size, blake3) = hash_file(&path)?;
    if size != meta.len() {
        return Err(SEND_FAILED.to_string());
    }
    let selection_id = Uuid::new_v4();
    state
        .selections
        .lock()
        .expect("selection lock")
        .insert(selection_id, path);
    Ok(Some(PickedFile {
        selection_id,
        original_filename,
        size,
        blake3,
    }))
}

#[tauri::command]
pub fn cancel_send_selection(state: State<AppState>, selection_id: Uuid) -> Result<(), String> {
    state
        .selections
        .lock()
        .expect("selection lock")
        .remove(&selection_id);
    Ok(())
}

#[tauri::command]
pub async fn tus_upload_v1(
    state: State<'_, AppState>,
    selection_id: Uuid,
    access_token: String,
    handoff_id: Uuid,
    object_id: Uuid,
    storage_path: String,
) -> Result<(), String> {
    validate_storage_path_ids(&storage_path, handoff_id, object_id)?;
    let path = {
        let selections = state.selections.lock().expect("selection lock");
        selections
            .get(&selection_id)
            .cloned()
            .ok_or_else(|| SELECTION_UNKNOWN.to_string())?
    };
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| SEND_FAILED.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE_SIZE {
        state
            .selections
            .lock()
            .expect("selection lock")
            .remove(&selection_id);
        return Err(if meta.len() > MAX_FILE_SIZE {
            FILE_TOO_LARGE.to_string()
        } else {
            SEND_FAILED.to_string()
        });
    }
    let result = upload_resumable(&path, &access_token, &storage_path, meta.len()).await;
    state
        .selections
        .lock()
        .expect("selection lock")
        .remove(&selection_id);
    result
}

fn parse_inbox_role(role: Option<&str>, version: u16) -> InboxRole {
    match role.map(str::trim).unwrap_or("") {
        "sender" => InboxRole::Sender,
        "recipient" => InboxRole::Recipient,
        _ if version >= 2 => InboxRole::Sender,
        _ => InboxRole::Recipient,
    }
}

#[tauri::command]
pub async fn download_inbox(
    state: State<'_, AppState>,
    handoff_id: Uuid,
    signed_url: String,
    expected_size: u64,
    expected_blake3: String,
    original_filename: String,
    version: Option<String>,
    role: Option<String>,
) -> Result<(), String> {
    if expected_size == 0 || expected_size > MAX_FILE_SIZE {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    let expected_hash = expected_blake3.trim().to_ascii_lowercase();
    if expected_hash.len() != 64 || !expected_hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    let version_label = version.unwrap_or_else(|| "v1".to_string());
    let version_number = parse_version_segment(&version_label)?;
    let version_label = version_folder_name(version_number)?;
    let inbox_role = parse_inbox_role(role.as_deref(), version_number);
    let filename = sanitize_filename(&original_filename).map_err(|_| DOWNLOAD_FAILED.to_string())?;
    let url = validate_download_url(&signed_url, handoff_id, project_ref())?;
    let data_root = state.data_root.clone();
    let dest = final_inbox_path(&data_root, handoff_id, &filename, &version_label)?;
    if tokio::fs::try_exists(&dest)
        .await
        .unwrap_or(false)
    {
        if file_matches(&dest, expected_size, &expected_hash).await {
            inbox::remember_version(
                &data_root,
                handoff_id,
                &filename,
                expected_size,
                &expected_hash,
                &version_label,
                inbox_role,
            )?;
            return Ok(());
        }
        tokio::fs::remove_file(&dest)
            .await
            .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    }
    let part = dest.parent().unwrap_or_else(|| Path::new(".")).join(format!(
        "{}.part",
        dest.file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| DOWNLOAD_FAILED.to_string())?
    ));
    let _ = tokio::fs::remove_file(&part).await;
    if let Err(err) = download_to_part(&url, &part, expected_size, &expected_hash).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err);
    }
    if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DOWNLOAD_FAILED.to_string());
    }
    let part_for_rename = part.clone();
    let dest_for_rename = dest.clone();
    let renamed = tauri::async_runtime::spawn_blocking(move || {
        rename_no_clobber(&part_for_rename, &dest_for_rename)
    })
    .await
    .map_err(|_| DOWNLOAD_FAILED.to_string())?;
    if renamed.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DOWNLOAD_FAILED.to_string());
    }
    inbox::remember_version(
        &data_root,
        handoff_id,
        &filename,
        expected_size,
        &expected_hash,
        &version_label,
        inbox_role,
    )?;
    Ok(())
}

fn inbox_record_for(
    inbox: &inbox::InboxFile,
    handoff_id: &str,
    version: Option<&str>,
) -> Result<(u16, inbox::InboxRecord), String> {
    let version_number = if let Some(label) = version {
        parse_version_segment(label)?
    } else {
        inbox
            .highest_version(handoff_id)
            .ok_or_else(|| DOWNLOAD_FAILED.to_string())?
    };
    let record = inbox
        .version_record(handoff_id, version_number)
        .cloned()
        .ok_or_else(|| DOWNLOAD_FAILED.to_string())?;
    Ok((version_number, record))
}

#[tauri::command]
pub async fn open_inbox_file(
    app: AppHandle,
    state: State<'_, AppState>,
    handoff_id: Uuid,
    version: Option<String>,
) -> Result<(), String> {
    let data_root = state.data_root.clone();
    let inbox = inbox::load_inbox(&data_root)?;
    let (version_number, record) =
        inbox_record_for(&inbox, &handoff_id.to_string(), version.as_deref())?;
    let version_label = version_folder_name(version_number)?;
    let dest = final_inbox_path(&data_root, handoff_id, &record.filename, &version_label)?;
    if !file_matches(&dest, record.size, &record.blake3).await {
        return Err(HASH_MISMATCH.to_string());
    }
    open_path(&app, &dest)
}

#[tauri::command]
pub fn reveal_inbox_folder(
    app: AppHandle,
    state: State<AppState>,
    handoff_id: Uuid,
    version: Option<String>,
) -> Result<(), String> {
    let inbox = inbox::load_inbox(&state.data_root)?;
    let (version_number, record) =
        inbox_record_for(&inbox, &handoff_id.to_string(), version.as_deref())?;
    let version_label = version_folder_name(version_number)?;
    let dest = final_inbox_path(&state.data_root, handoff_id, &record.filename, &version_label)?;
    if !dest.exists() {
        return Err(DOWNLOAD_FAILED.to_string());
    }
    app.opener()
        .reveal_item_in_dir(&dest)
        .map_err(|_| DOWNLOAD_FAILED.to_string())
}

#[tauri::command]
pub fn inbox_local_state(state: State<AppState>) -> Result<Vec<InboxLocalEntry>, String> {
    let inbox = inbox::load_inbox(&state.data_root)?;
    Ok(inbox::local_entries(&inbox))
}

// Toast click is not an acceptance criterion. tauri-plugin-notification
// Actions are not supported on Windows through the documented API.
#[tauri::command]
pub fn notify_new_file(app: AppHandle, sender_display_name: String) -> Result<(), String> {
    let hidden = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .map(|visible| !visible)
        .unwrap_or(false);
    if !hidden {
        return Ok(());
    }
    let body = format!("{}{}", HE.new_file_from_prefix, sender_display_name.trim());
    app.notification()
        .builder()
        .title(HE.brand)
        .body(body)
        .show()
        .map_err(|_| DOWNLOAD_FAILED.to_string())
}

#[tauri::command]
pub fn notify_file_returned(app: AppHandle, sender_display_name: String) -> Result<(), String> {
    let hidden = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .map(|visible| !visible)
        .unwrap_or(false);
    if !hidden {
        return Ok(());
    }
    let body = format!(
        "{}{}",
        sender_display_name.trim(),
        HE.file_returned_suffix
    );
    app.notification()
        .builder()
        .title(HE.brand)
        .body(body)
        .show()
        .map_err(|_| DOWNLOAD_FAILED.to_string())
}

#[allow(dead_code)]
pub fn take_selection(
    selections: &mut BTreeMap<Uuid, PathBuf>,
    selection_id: Uuid,
) -> Result<PathBuf, String> {
    selections
        .remove(&selection_id)
        .ok_or_else(|| SELECTION_UNKNOWN.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> (Uuid, Uuid, Uuid) {
        (
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
        )
    }

    #[test]
    fn chunk_size_is_exactly_six_mebibytes() {
        assert_eq!(TUS_CHUNK_SIZE, 6 * 1024 * 1024);
    }

    #[test]
    fn project_ref_is_embedded_without_a_key() {
        let value = project_ref();
        assert!(!value.is_empty());
        assert!(value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()));
        assert!(!value.contains('.'));
        assert!(!value.contains("service_role"));
        assert!(!value.starts_with("eyJ"));
        assert!(!value.contains("sb_publishable"));
    }

    #[test]
    fn tus_host_is_built_from_project_ref() {
        let endpoint = tus_endpoint("abc123");
        assert_eq!(
            endpoint,
            "https://abc123.storage.supabase.co/storage/v1/upload/resumable"
        );
    }

    #[test]
    fn tus_metadata_uses_standard_base64_and_required_keys() {
        let (workspace, handoff, object) = ids();
        let path = format!("{workspace}/{handoff}/v1/{object}");
        let meta = tus_metadata(&path);
        let keys: Vec<&str> = meta
            .split(',')
            .map(|pair| pair.split(' ').next().unwrap())
            .collect();
        assert_eq!(
            keys,
            ["bucketName", "objectName", "contentType", "cacheControl"]
        );
        for pair in meta.split(',') {
            let encoded = pair.split(' ').nth(1).unwrap();
            assert!(B64.decode(encoded).is_ok());
            assert!(!encoded.contains('-'));
            assert!(!encoded.contains('_'));
        }
        let object_name = B64
            .decode(meta.split(',').nth(1).unwrap().split(' ').nth(1).unwrap())
            .unwrap();
        assert_eq!(object_name, path.as_bytes());
    }

    #[test]
    fn tus_post_failure_log_is_sanitized() {
        let (workspace, handoff, object) = ids();
        let path = format!("{workspace}/{handoff}/v1/{object}");
        let body = r#"{"statusCode":"400","error":"Invalid Compact JWS","message":"eyJhbGciOiJIUzI1NiJ9.payload.sig"}"#;
        let log = format_tus_post_failure_log(
            400,
            body,
            "https://abc123.storage.supabase.co/storage/v1/upload/resumable?token=secret",
            12,
            &[
                "Tus-Resumable",
                "Upload-Length",
                "Upload-Metadata",
                "Authorization",
                "x-upsert",
            ],
            &["bucketName", "objectName", "contentType", "cacheControl"],
            &path,
        );
        assert!(log.contains("status=400"));
        assert!(log.contains("code=400"));
        assert!(log.contains("error=Invalid Compact JWS"));
        assert!(log.contains("host=abc123.storage.supabase.co"));
        assert!(log.contains("endpoint_path=/storage/v1/upload/resumable"));
        assert!(log.contains("upload_length=12"));
        assert!(log.contains("header_names=Tus-Resumable,Upload-Length,Upload-Metadata,Authorization,x-upsert"));
        assert!(log.contains(
            "metadata_keys=bucketName,objectName,contentType,cacheControl"
        ));
        assert!(log.contains("path_shape={uuid}/{uuid}/v1/{uuid}"));
        assert!(!log.contains("token=secret"));
        assert!(!log.contains("eyJ"));
        assert!(!log.contains("Bearer "));
        assert!(!log.contains(&workspace.to_string()));
        assert!(!log.contains(&handoff.to_string()));
        assert!(!log.contains(&object.to_string()));
        assert!(!log.contains("x-signature"));
        assert_eq!(storage_path_shape(&path), "{uuid}/{uuid}/v1/{uuid}");
    }

    #[test]
    fn filename_sanitization_strips_separators_and_reserved_names() {
        assert!(sanitize_filename("../secret.txt").is_err());
        assert!(sanitize_filename("a/b.txt").is_err());
        assert_eq!(sanitize_filename("דוח.docx").unwrap(), "דוח.docx");
        assert!(sanitize_filename("CON.txt").unwrap().starts_with('_'));
        assert!(sanitize_filename("").is_err());
    }

    #[test]
    fn storage_path_must_match_handoff_and_object_ids() {
        let (workspace, handoff, object) = ids();
        let path = format!("{workspace}/{handoff}/v1/{object}");
        let parsed = validate_storage_path_ids(&path, handoff, object).unwrap();
        assert_eq!(parsed.workspace_id, workspace);
        assert!(validate_storage_path_ids(&path, object, handoff).is_err());
        let parsed_v2 = parse_storage_path(&format!("{workspace}/{handoff}/v2/{object}")).unwrap();
        assert_eq!(parsed_v2.version, 2);
        assert!(validate_storage_path_ids(
            &format!("{workspace}/{handoff}/v2/{object}"),
            handoff,
            object
        )
        .is_err());
        assert!(validate_storage_path_ids_version(
            &format!("{workspace}/{handoff}/v2/{object}"),
            handoff,
            object,
            2
        )
        .is_ok());
        assert!(parse_storage_path(&format!("{workspace}/{handoff}/v1/{object}/extra")).is_err());
        assert!(parse_storage_path("not-a-uuid/x/v1/y").is_err());
    }

    #[test]
    fn storage_path_accepts_canonical_v1_to_v1000_and_rejects_the_rest() {
        let (workspace, handoff, object) = ids();
        for version in [1u16, 2, 3, 10, 1000] {
            let parsed =
                parse_storage_path(&format!("{workspace}/{handoff}/v{version}/{object}")).unwrap();
            assert_eq!(parsed.version, version);
            assert_eq!(parsed.handoff_id, handoff);
            assert_eq!(parsed.object_id, object);
        }
        assert!(parse_storage_path(&format!("{workspace}/{handoff}/v0/{object}")).is_err());
        assert!(parse_storage_path(&format!("{workspace}/{handoff}/v01/{object}")).is_err());
        assert!(parse_storage_path(&format!("{workspace}/{handoff}/v1001/{object}")).is_err());
        assert!(parse_storage_path(&format!(
            "{workspace}/{handoff}/v2147483648/{object}"
        ))
        .is_err());
        assert!(parse_storage_path(&format!(
            "{workspace}/{handoff}/v{}/{object}",
            "9".repeat(80)
        ))
        .is_err());
        assert!(parse_storage_path(&format!("{workspace}/{handoff}/v3/{object}/extra")).is_err());
        assert!(parse_storage_path(&format!("{workspace}//{handoff}/v1/{object}")).is_err());
        assert!(parse_storage_path(&format!("not-a-uuid/{handoff}/v1/{object}")).is_err());
        assert!(validate_storage_path_ids_version(
            &format!("{workspace}/{handoff}/v3/{object}"),
            handoff,
            object,
            2
        )
        .is_err());
        assert!(validate_storage_path_ids_version(
            &format!("{workspace}/{handoff}/v3/{object}"),
            handoff,
            object,
            3
        )
        .is_ok());
    }

    #[test]
    fn corrupt_local_inbox_file_does_not_match_expected_hash() {
        let root = std::env::temp_dir().join(format!("filerelay-m9b-hash-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dest = root.join("file.txt");
        std::fs::write(&dest, b"corrupt").unwrap();
        let (size, hash) = hash_file(&dest).unwrap();
        std::fs::write(&dest, b"changed").unwrap();
        let current = hash_file(&dest).unwrap();
        assert_ne!(current, (size, hash.clone()));
        std::fs::remove_file(&dest).unwrap();
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn download_url_rejects_http_foreign_host_and_wrong_handoff() {
        let (_workspace, handoff, object) = ids();
        let workspace = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let ref_id = "abc123ref";
        let ok = format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v1/{object}?token=abc"
        );
        assert!(validate_download_url(&ok, handoff, ref_id).is_ok());
        let v3 = format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v3/{object}?token=abc"
        );
        assert!(validate_download_url(&v3, handoff, ref_id).is_ok());
        let v1000 = format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v1000/{object}"
        );
        assert!(validate_download_url(&v1000, handoff, ref_id).is_ok());
        let v0 = format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v0/{object}"
        );
        assert!(validate_download_url(&v0, handoff, ref_id).is_err());
        let api_host = format!(
            "https://{ref_id}.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v1/{object}"
        );
        assert!(validate_download_url(&api_host, handoff, ref_id).is_ok());
        assert!(validate_download_url(
            &ok.replace("https://", "http://"),
            handoff,
            ref_id
        )
        .is_err());
        assert!(validate_download_url(
            &ok.replace(
                &format!("{ref_id}.storage.supabase.co"),
                "evil.example"
            ),
            handoff,
            ref_id
        )
        .is_err());
        let other = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
        assert!(validate_download_url(&ok, other, ref_id).is_err());
        assert!(validate_download_url(
            &ok.replace("filerelay", "other-bucket"),
            handoff,
            ref_id
        )
        .is_err());
        assert!(validate_download_url(
            &format!("https://{ref_id}.storage.supabase.co/storage/v1/object/sign/filerelay/{workspace}/{handoff}/v1/{object}/%2e%2e/secret"),
            handoff,
            ref_id
        )
        .is_err());
    }

    #[test]
    fn unknown_selection_is_rejected_without_a_path() {
        let mut selections = BTreeMap::new();
        let missing = Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap();
        assert_eq!(take_selection(&mut selections, missing).unwrap_err(), SELECTION_UNKNOWN);
    }

    #[test]
    fn oversize_constant_matches_bucket_limit() {
        assert_eq!(MAX_FILE_SIZE, 52_428_800);
    }

    #[test]
    fn transfer_source_uses_bearer_tus() {
        let source = include_str!("transfer.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("Authorization"));
        assert!(production.contains("Bearer {access_token}"));
        assert!(!production.contains("x-signature"));
        assert!(!production.contains("service_role"));
        assert!(!production.contains("reqwest::blocking"));
        assert!(production.contains("async fn tus_upload_v1"));
        assert!(production.contains("async fn upload_resumable"));
        assert!(production.contains("async fn download_inbox"));
        assert!(production.contains("x-upsert"));
        assert!(production.contains("Policy::custom"));
        assert!(production.contains("is_allowed_redirect_url(attempt.url()"));
        assert!(production.contains(".part"));
        assert!(production.contains("hasher.update"));
        assert!(production.contains("rename_no_clobber"));
        assert!(production.contains("MAX_FILE_SIZE"));
        assert!(production.contains("spawn_blocking"));
        assert!(production.contains("format_tus_post_failure_log"));
        assert!(production.contains("HASH_MISMATCH"));
        assert!(production.contains("highest_version"));
    }

    #[test]
    fn every_redirect_must_be_https_on_the_same_project_host() {
        let ref_id = "abc123ref";
        let storage = reqwest::Url::parse(&format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/x"
        ))
        .unwrap();
        let api = reqwest::Url::parse(&format!("https://{ref_id}.supabase.co/storage/v1/object/sign/x"))
            .unwrap();
        let http = reqwest::Url::parse(&format!(
            "http://{ref_id}.storage.supabase.co/storage/v1/object/sign/x"
        ))
        .unwrap();
        let foreign =
            reqwest::Url::parse("https://evil.example/storage/v1/object/sign/x").unwrap();
        let other_ref = reqwest::Url::parse(
            "https://otherref.storage.supabase.co/storage/v1/object/sign/x",
        )
        .unwrap();
        let odd_port = reqwest::Url::parse(&format!(
            "https://{ref_id}.storage.supabase.co:8443/storage/v1/object/sign/x"
        ))
        .unwrap();
        assert!(is_allowed_redirect_url(&storage, ref_id));
        assert!(is_allowed_redirect_url(&api, ref_id));
        assert!(!is_allowed_redirect_url(&http, ref_id));
        assert!(!is_allowed_redirect_url(&foreign, ref_id));
        assert!(!is_allowed_redirect_url(&other_ref, ref_id));
        assert!(!is_allowed_redirect_url(&odd_port, ref_id));
    }
}
