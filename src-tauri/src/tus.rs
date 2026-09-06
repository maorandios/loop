use std::path::Path;
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::transfer::{
    format_tus_post_failure_log, project_ref, tus_endpoint, tus_metadata, tus_metadata_key_names,
    TUS_CHUNK_SIZE, SEND_FAILED,
};

const INVALID_TUS_URL: &str = "invalid_tus_url";

pub enum TusPostResult {
    Created(String),
    Unknown,
    Failed,
}

pub enum TusHeadResult {
    Offset { offset: u64, length: Option<u64> },
    Gone,
    Transient,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TusDeleteResult {
    Terminated,
    Conflict,
    Transient,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteConflictDecision {
    TusTerminated,
    UploadCompletedCleanup,
    KeepRecord,
}

pub fn decide_delete_conflict(head: &TusHeadResult) -> DeleteConflictDecision {
    match head {
        TusHeadResult::Gone => DeleteConflictDecision::TusTerminated,
        TusHeadResult::Offset {
            offset,
            length: Some(length),
        } if *offset == *length => DeleteConflictDecision::UploadCompletedCleanup,
        TusHeadResult::Offset {
            offset,
            length: Some(length),
        } if *offset < *length => DeleteConflictDecision::KeepRecord,
        TusHeadResult::Offset { .. }
        | TusHeadResult::Transient
        | TusHeadResult::Failed => DeleteConflictDecision::KeepRecord,
    }
}

pub fn is_allowed_tus_url(url: &reqwest::Url, project_ref: &str) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port_or_known_default() != Some(443) {
        return false;
    }
    let host = match url.host_str() {
        Some(host) => host,
        None => return false,
    };
    let expected = format!("{project_ref}.storage.supabase.co");
    if !host.eq_ignore_ascii_case(&expected) {
        return false;
    }
    url.path().starts_with("/storage/v1/upload/resumable")
}

fn tus_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if is_allowed_tus_url(attempt.url(), project_ref()) {
                attempt.follow()
            } else {
                attempt.error(INVALID_TUS_URL)
            }
        }))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| SEND_FAILED.to_string())
}

fn resolve_location(endpoint: &str, location: &str, project_ref: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|_| SEND_FAILED.to_string())?
        .join(location)
        .map_err(|_| SEND_FAILED.to_string())?;
    if !is_allowed_tus_url(&url, project_ref) {
        return Err(SEND_FAILED.to_string());
    }
    Ok(url)
}

pub async fn tus_post(
    access_token: &str,
    storage_path: &str,
    expected_size: u64,
) -> TusPostResult {
    let client = match tus_client() {
        Ok(client) => client,
        Err(_) => return TusPostResult::Failed,
    };
    let ref_id = project_ref();
    let endpoint = tus_endpoint(ref_id);
    let metadata = tus_metadata(storage_path);
    let metadata_keys = tus_metadata_key_names(storage_path);
    let response = match client
        .post(&endpoint)
        .header("Tus-Resumable", "1.0.0")
        .header("Upload-Length", expected_size.to_string())
        .header("Upload-Metadata", metadata)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("x-upsert", "false")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return TusPostResult::Unknown,
    };
    let status = response.status();
    if !status.is_success() && status.as_u16() != 201 {
        let body = response.text().await.unwrap_or_default();
        eprintln!(
            "{}",
            format_tus_post_failure_log(
                status.as_u16(),
                &body,
                &endpoint,
                expected_size,
                &[
                    "Tus-Resumable",
                    "Upload-Length",
                    "Upload-Metadata",
                    "Authorization",
                    "x-upsert",
                ],
                &metadata_keys,
                storage_path,
            )
        );
        return TusPostResult::Failed;
    }
    match response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    {
        Some(location) if resolve_location(&endpoint, &location, ref_id).is_ok() => {
            TusPostResult::Created(location)
        }
        Some(_) => TusPostResult::Failed,
        None => TusPostResult::Unknown,
    }
}

pub async fn tus_head(access_token: &str, location: &str) -> TusHeadResult {
    let client = match tus_client() {
        Ok(client) => client,
        Err(_) => return TusHeadResult::Failed,
    };
    let ref_id = project_ref();
    let endpoint = tus_endpoint(ref_id);
    let url = match resolve_location(&endpoint, location, ref_id) {
        Ok(url) => url,
        Err(_) => return TusHeadResult::Failed,
    };
    let response = match client
        .head(url)
        .header("Tus-Resumable", "1.0.0")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return TusHeadResult::Transient,
    };
    let status = response.status().as_u16();
    if status == 404 || status == 410 {
        return TusHeadResult::Gone;
    }
    if status >= 500 {
        return TusHeadResult::Transient;
    }
    if !response.status().is_success() {
        return TusHeadResult::Failed;
    }
    match response
        .headers()
        .get("Upload-Offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(offset) => {
            let length = response
                .headers()
                .get("Upload-Length")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            TusHeadResult::Offset { offset, length }
        }
        None => TusHeadResult::Failed,
    }
}

pub async fn tus_delete(access_token: &str, location: &str) -> TusDeleteResult {
    let client = match tus_client() {
        Ok(client) => client,
        Err(_) => return TusDeleteResult::Failed,
    };
    let ref_id = project_ref();
    let endpoint = tus_endpoint(ref_id);
    let url = match resolve_location(&endpoint, location, ref_id) {
        Ok(url) => url,
        Err(_) => return TusDeleteResult::Failed,
    };
    let response = match client
        .delete(url)
        .header("Tus-Resumable", "1.0.0")
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return TusDeleteResult::Transient,
    };
    let status = response.status().as_u16();
    if status == 204 || status == 404 || status == 410 || response.status().is_success() {
        TusDeleteResult::Terminated
    } else if status == 409 {
        TusDeleteResult::Conflict
    } else if status >= 500 {
        TusDeleteResult::Transient
    } else {
        TusDeleteResult::Failed
    }
}

pub async fn tus_patch_file(
    path: &Path,
    access_token: &str,
    location: &str,
    mut offset: u64,
    expected_size: u64,
) -> Result<u64, String> {
    if offset > expected_size {
        return Err(SEND_FAILED.to_string());
    }
    if offset == expected_size {
        return Ok(offset);
    }
    let client = tus_client()?;
    let ref_id = project_ref();
    let endpoint = tus_endpoint(ref_id);
    let url = resolve_location(&endpoint, location, ref_id)?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| SEND_FAILED.to_string())?;
    if offset > 0 {
        tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| SEND_FAILED.to_string())?;
    }
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
            .patch(url.clone())
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
        let status = response.status().as_u16();
        if status >= 500 {
            return Err(SEND_FAILED.to_string());
        }
        if !response.status().is_success() && status != 204 {
            return Err(SEND_FAILED.to_string());
        }
        offset += filled as u64;
    }
    Ok(offset)
}

pub async fn upload_ephemeral(
    path: &Path,
    access_token: &str,
    storage_path: &str,
    expected_size: u64,
) -> Result<(), String> {
    let location = match tus_post(access_token, storage_path, expected_size).await {
        TusPostResult::Created(location) => location,
        TusPostResult::Unknown | TusPostResult::Failed => return Err(SEND_FAILED.to_string()),
    };
    tus_patch_file(path, access_token, &location, 0, expected_size).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tus_url_allows_only_project_storage_resumable_path() {
        let ref_id = "abc123ref";
        let ok = reqwest::Url::parse(&format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/upload/resumable/session"
        ))
        .unwrap();
        let api = reqwest::Url::parse(&format!(
            "https://{ref_id}.supabase.co/storage/v1/upload/resumable"
        ))
        .unwrap();
        let other_path = reqwest::Url::parse(&format!(
            "https://{ref_id}.storage.supabase.co/storage/v1/object/sign/x"
        ))
        .unwrap();
        let http = reqwest::Url::parse(&format!(
            "http://{ref_id}.storage.supabase.co/storage/v1/upload/resumable"
        ))
        .unwrap();
        assert!(is_allowed_tus_url(&ok, ref_id));
        assert!(!is_allowed_tus_url(&api, ref_id));
        assert!(!is_allowed_tus_url(&other_path, ref_id));
        assert!(!is_allowed_tus_url(&http, ref_id));
    }

    #[test]
    fn production_tus_client_checks_every_redirect() {
        let source = include_str!("tus.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("Policy::custom"));
        assert!(production.contains("is_allowed_tus_url(attempt.url()"));
        assert!(production.contains("https_only(true)"));
        assert!(production.contains("status == 409"));
        assert!(production.contains("decide_delete_conflict"));
        assert!(!production.contains("sb_publishable"));
        assert!(!production.contains("rest/v1/rpc"));
    }

    #[test]
    fn delete_409_after_full_upload_allows_cleanup() {
        let head = TusHeadResult::Offset {
            offset: 6_553_600,
            length: Some(6_553_600),
        };
        assert_eq!(
            decide_delete_conflict(&head),
            DeleteConflictDecision::UploadCompletedCleanup
        );
    }

    #[test]
    fn delete_409_with_partial_upload_keeps_record() {
        let head = TusHeadResult::Offset {
            offset: 6_291_456,
            length: Some(6_553_600),
        };
        assert_eq!(
            decide_delete_conflict(&head),
            DeleteConflictDecision::KeepRecord
        );
    }

    #[test]
    fn delete_409_with_invalid_head_keeps_record() {
        assert_eq!(
            decide_delete_conflict(&TusHeadResult::Offset {
                offset: 100,
                length: None,
            }),
            DeleteConflictDecision::KeepRecord
        );
        assert_eq!(
            decide_delete_conflict(&TusHeadResult::Offset {
                offset: 200,
                length: Some(100),
            }),
            DeleteConflictDecision::KeepRecord
        );
        assert_eq!(
            decide_delete_conflict(&TusHeadResult::Failed),
            DeleteConflictDecision::KeepRecord
        );
        assert_eq!(
            decide_delete_conflict(&TusHeadResult::Transient),
            DeleteConflictDecision::KeepRecord
        );
    }

    #[test]
    fn delete_409_with_gone_head_terminates_session() {
        assert_eq!(
            decide_delete_conflict(&TusHeadResult::Gone),
            DeleteConflictDecision::TusTerminated
        );
    }
}
