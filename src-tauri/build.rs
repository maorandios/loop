use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let project_ref = match load_project_ref() {
        Ok(value) => value,
        Err(code) => panic!("{code}"),
    };
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("filerelay_project_ref.txt"), project_ref)
        .expect("write_project_ref_failed");
    tauri_build::build();
}

fn load_project_ref() -> Result<String, &'static str> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|_| "missing_supabase_url")?);
    let env_path = manifest_dir.join("..").join(".env.local");
    println!("cargo:rerun-if-changed={}", env_path.display());
    let contents = fs::read_to_string(&env_path).map_err(|_| "missing_supabase_url")?;
    let url = vite_supabase_url(&contents).ok_or("missing_supabase_url")?;
    extract_project_ref(&url)
}

fn vite_supabase_url(contents: &str) -> Option<String> {
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "VITE_SUPABASE_URL" {
            continue;
        }
        let trimmed = strip_quotes(value.trim());
        if trimmed.is_empty() {
            return None;
        }
        return Some(trimmed);
    }
    None
}

fn strip_quotes(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].trim().to_string();
        }
    }
    value.to_string()
}

fn extract_project_ref(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("https://") {
        return Err("invalid_supabase_url");
    }
    let without_scheme = &trimmed["https://".len()..];
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() || host.contains('@') || host.contains(':') {
        return Err("invalid_supabase_url");
    }
    let mut labels = host.split('.');
    let Some(project_ref) = labels.next() else {
        return Err("invalid_supabase_url");
    };
    let Some(second) = labels.next() else {
        return Err("invalid_supabase_url");
    };
    let Some(tld) = labels.next() else {
        return Err("invalid_supabase_url");
    };
    if labels.next().is_some() || second != "supabase" || tld != "co" {
        return Err("invalid_supabase_url");
    }
    if project_ref.is_empty()
        || project_ref == "www"
        || project_ref == "storage"
        || !project_ref
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
    {
        return Err("invalid_supabase_url");
    }
    Ok(project_ref.to_string())
}
