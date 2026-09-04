use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

pub fn parse_data_dir_override(raw: Option<&str>) -> Option<PathBuf> {
    raw.map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from)
}

pub fn should_skip_single_instance(debug: bool, data_dir_env: Option<&str>) -> bool {
    debug && parse_data_dir_override(data_dir_env).is_some()
}

pub fn choose_data_root(debug: bool, data_dir_env: Option<&str>, app_local: PathBuf) -> PathBuf {
    if debug {
        if let Some(override_dir) = parse_data_dir_override(data_dir_env) {
            return override_dir;
        }
    }
    app_local
}

pub fn resolve_data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_local = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?;
    let env_raw = std::env::var("FILERELAY_DATA_DIR").ok();
    let chosen = choose_data_root(cfg!(debug_assertions), env_raw.as_deref(), app_local);
    let root = if chosen.is_absolute() {
        chosen
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(chosen)
    };
    std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

pub fn ensure_data_layout(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(root.join("state")).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(root.join("files").join("inbox")).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(tmp_dir(root)).map_err(|err| err.to_string())?;
    Ok(())
}

pub fn state_file_path(root: &Path) -> PathBuf {
    root.join("state").join("state.json")
}

pub fn inbox_state_file_path(root: &Path) -> PathBuf {
    root.join("state").join("inbox.json")
}

pub fn inbox_dir(root: &Path) -> PathBuf {
    root.join("files").join("inbox")
}

pub fn tmp_dir(root: &Path) -> PathBuf {
    root.join("files").join("tmp")
}

pub fn parse_version_segment(version: &str) -> Result<u16, String> {
    let trimmed = version.trim();
    if trimmed.len() > 5 || !trimmed.starts_with('v') {
        return Err("invalid_storage_path".to_string());
    }
    let digits = &trimmed[1..];
    if digits.is_empty() || digits.as_bytes().first() == Some(&b'0') {
        return Err("invalid_storage_path".to_string());
    }
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid_storage_path".to_string());
    }
    let parsed = digits
        .parse::<u16>()
        .map_err(|_| "invalid_storage_path".to_string())?;
    if parsed < 1 || parsed > 1000 {
        return Err("invalid_storage_path".to_string());
    }
    Ok(parsed)
}

pub fn version_folder_name(version: u16) -> Result<String, String> {
    if version < 1 || version > 1000 {
        return Err("invalid_storage_path".to_string());
    }
    Ok(format!("v{version}"))
}

pub fn parse_inbox_version(version: &str) -> Result<String, String> {
    version_folder_name(parse_version_segment(version)?)
}

pub fn inbox_version_dir(root: &Path, handoff_id: &str, version: &str) -> Result<PathBuf, String> {
    let version = parse_inbox_version(version)?;
    Ok(inbox_dir(root).join(handoff_id).join(version))
}

pub fn is_return_snapshot_filename(name: &str) -> bool {
    let Some(stem) = name.strip_prefix("return-") else {
        return false;
    };
    let Some(stem) = stem.strip_suffix(".part") else {
        return false;
    };
    let bytes = stem.as_bytes();
    if bytes.len() != 73 || bytes[36] != b'-' {
        return false;
    }
    uuid::Uuid::parse_str(&stem[..36]).is_ok() && uuid::Uuid::parse_str(&stem[37..]).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_local() -> PathBuf {
        PathBuf::from(r"C:\Users\Maor\AppData\Local\com.filerelay.app")
    }

    #[test]
    fn empty_or_whitespace_override_is_ignored() {
        assert_eq!(parse_data_dir_override(None), None);
        assert_eq!(parse_data_dir_override(Some("")), None);
        assert_eq!(parse_data_dir_override(Some("   ")), None);
    }

    #[test]
    fn override_path_is_trimmed() {
        let path = parse_data_dir_override(Some(r"  C:\temp\filerelay-a  ")).unwrap();
        assert_eq!(path, PathBuf::from(r"C:\temp\filerelay-a"));
    }

    #[test]
    fn release_ignores_data_dir_env_for_the_data_root() {
        let root = choose_data_root(
            false,
            Some(r"C:\temp\filerelay-debug-a"),
            app_local(),
        );
        assert_eq!(root, app_local());
    }

    #[test]
    fn debug_uses_a_non_empty_data_dir_override() {
        let root = choose_data_root(true, Some(r"C:\temp\filerelay-a"), app_local());
        assert_eq!(root, PathBuf::from(r"C:\temp\filerelay-a"));
    }

    #[test]
    fn debug_keeps_app_local_when_override_is_empty() {
        let root = choose_data_root(true, Some("   "), app_local());
        assert_eq!(root, app_local());
    }

    #[test]
    fn release_always_uses_single_instance() {
        assert!(!should_skip_single_instance(false, None));
        assert!(!should_skip_single_instance(
            false,
            Some(r"C:\temp\filerelay-a"),
        ));
    }

    #[test]
    fn debug_skips_single_instance_only_for_a_non_empty_override() {
        assert!(!should_skip_single_instance(true, None));
        assert!(!should_skip_single_instance(true, Some("")));
        assert!(!should_skip_single_instance(true, Some("   ")));
        assert!(should_skip_single_instance(
            true,
            Some(r"C:\temp\filerelay-a"),
        ));
    }

    #[test]
    fn state_file_lives_under_local_state_dir() {
        let root = app_local();
        let file = state_file_path(&root);
        assert!(file.is_absolute());
        assert_eq!(file, root.join("state").join("state.json"));
        assert!(!file.to_string_lossy().contains("Roaming"));
    }

    #[test]
    fn inbox_layout_stays_under_data_root() {
        let root = app_local();
        assert_eq!(inbox_dir(&root), root.join("files").join("inbox"));
        assert_eq!(
            inbox_state_file_path(&root),
            root.join("state").join("inbox.json")
        );
        let handoff = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            inbox_version_dir(&root, handoff, "v1").unwrap(),
            root.join("files")
                .join("inbox")
                .join(handoff)
                .join("v1")
        );
        assert_eq!(
            inbox_version_dir(&root, handoff, "v2").unwrap(),
            root.join("files")
                .join("inbox")
                .join(handoff)
                .join("v2")
        );
        assert_eq!(
            inbox_version_dir(&root, handoff, "v3").unwrap(),
            root.join("files")
                .join("inbox")
                .join(handoff)
                .join("v3")
        );
        assert_eq!(
            inbox_version_dir(&root, handoff, "v1000").unwrap(),
            root.join("files")
                .join("inbox")
                .join(handoff)
                .join("v1000")
        );
        assert!(inbox_version_dir(&root, handoff, "v0").is_err());
        assert!(inbox_version_dir(&root, handoff, "v01").is_err());
        assert!(inbox_version_dir(&root, handoff, "v1001").is_err());
        assert_eq!(tmp_dir(&root), root.join("files").join("tmp"));
    }

    #[test]
    fn version_segment_accepts_canonical_v1_to_v1000() {
        assert_eq!(parse_version_segment("v1").unwrap(), 1);
        assert_eq!(parse_version_segment("v2").unwrap(), 2);
        assert_eq!(parse_version_segment("v3").unwrap(), 3);
        assert_eq!(parse_version_segment("v10").unwrap(), 10);
        assert_eq!(parse_version_segment("v1000").unwrap(), 1000);
        assert!(parse_version_segment("v0").is_err());
        assert!(parse_version_segment("v01").is_err());
        assert!(parse_version_segment("v1001").is_err());
        assert!(parse_version_segment(&format!("v{}", "9".repeat(20))).is_err());
        assert!(parse_version_segment("v-1").is_err());
        assert!(parse_version_segment("V1").is_err());
    }

    #[test]
    fn return_snapshot_filename_matches_app_pattern_only() {
        let handoff = "11111111-1111-4111-8111-111111111111";
        let snap = "22222222-2222-4222-8222-222222222222";
        assert!(is_return_snapshot_filename(&format!(
            "return-{handoff}-{snap}.part"
        )));
        assert!(!is_return_snapshot_filename("inbox-file.docx"));
        assert!(!is_return_snapshot_filename(&format!("{handoff}.part")));
        assert!(!is_return_snapshot_filename("return-not-a-uuid.part"));
    }
}
