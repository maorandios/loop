use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const STATE_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDevice {
    pub device_id: Uuid,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocalDevice {
    device_id: Uuid,
    display_name: String,
    #[serde(default, alias = "pairing_code")]
    pairing_code: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

pub struct LoadedDevice {
    pub device: LocalDevice,
    pub needs_rewrite: bool,
}

pub fn create_local_device(display_name: String) -> LocalDevice {
    LocalDevice {
        device_id: Uuid::new_v4(),
        display_name,
    }
}

pub fn load_local_device(value: serde_json::Value) -> Result<LoadedDevice, String> {
    let needs_rewrite = value.get("pairingCode").is_some()
        || value.get("pairing_code").is_some()
        || value.get("port").is_some();
    let stored: StoredLocalDevice =
        serde_json::from_value(value).map_err(|_| "identity_invalid".to_string())?;
    Ok(LoadedDevice {
        device: LocalDevice {
            device_id: stored.device_id,
            display_name: stored.display_name,
        },
        needs_rewrite: needs_rewrite || stored.pairing_code.is_some() || stored.port.is_some(),
    })
}

pub fn normalize_display_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().to_string();
    if name.is_empty() {
        return Err("display_name_required".into());
    }
    if name.chars().count() > 50 {
        return Err("display_name_too_long".into());
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_trimmed_and_required() {
        assert_eq!(normalize_display_name("  מאור  ").unwrap(), "מאור");
        assert_eq!(
            normalize_display_name("   ").unwrap_err(),
            "display_name_required"
        );
    }

    #[test]
    fn display_name_rejects_more_than_fifty_chars() {
        let too_long = "א".repeat(51);
        assert_eq!(
            normalize_display_name(&too_long).unwrap_err(),
            "display_name_too_long"
        );
        assert!(normalize_display_name(&"א".repeat(50)).is_ok());
    }

    #[test]
    fn old_store_identity_loads_without_lan_fields() {
        let raw = serde_json::json!({
            "deviceId": "11111111-1111-4111-8111-111111111111",
            "displayName": "מאור",
            "pairingCode": "482913",
            "port": 4747
        });
        let loaded = load_local_device(raw).unwrap();
        assert_eq!(loaded.device.display_name, "מאור");
        assert_eq!(
            loaded.device.device_id.to_string(),
            "11111111-1111-4111-8111-111111111111"
        );
        assert!(loaded.needs_rewrite);
        let rewritten = serde_json::to_value(&loaded.device).unwrap();
        assert!(rewritten.get("pairingCode").is_none());
        assert!(rewritten.get("port").is_none());
        assert!(rewritten.get("pairing_code").is_none());
    }

    #[test]
    fn new_identity_json_omits_lan_fields() {
        let device = LocalDevice {
            device_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            display_name: "מאור".into(),
        };
        let json = serde_json::to_value(&device).unwrap();
        assert_eq!(json["deviceId"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(json["displayName"], "מאור");
        assert!(json.get("port").is_none());
        assert!(json.get("pairingCode").is_none());
    }

    #[test]
    fn snake_case_legacy_store_still_loads_identity() {
        let raw = serde_json::json!({
            "deviceId": "11111111-1111-4111-8111-111111111111",
            "displayName": "מאור",
            "pairing_code": "482913",
            "port": 0
        });
        let loaded = load_local_device(raw).unwrap();
        assert_eq!(loaded.device.display_name, "מאור");
        assert!(loaded.needs_rewrite);
    }
}
