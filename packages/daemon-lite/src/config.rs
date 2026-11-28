use anyhow::{Context, Result};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub relay_url: String,
    pub username: String,
    pub password: String,
    pub host_id: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub zterm_dir: PathBuf,
    pub config_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub auth_token: String,
    pub daemon_host_id: String,
    pub device_id: String,
    pub relay: Option<RelayConfig>,
}

pub fn hostname_string() -> String {
    if let Ok(name) = env::var("HOSTNAME") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(content) = fs::read_to_string("/proc/sys/kernel/hostname") {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "openwrt-lite".to_string()
}

fn default_zterm_dir() -> PathBuf {
    let home = env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/root"));
    home.join(".zterm")
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(path)
        .with_context(|| format!("failed to read config {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    let parsed: Value = serde_json::from_str(&text)
        .with_context(|| format!("invalid JSON in {}", path.display()))?;
    Ok(parsed.as_object().cloned().unwrap_or_default())
}

fn get_obj<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    map.get(key).and_then(|v| v.as_object())
}

fn get_str(map: Option<&Map<String, Value>>, key: &str) -> String {
    map.and_then(|m| m.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn get_u16(map: Option<&Map<String, Value>>, key: &str) -> Option<u16> {
    map.and_then(|m| m.get(key)).and_then(|v| {
        v.as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
    })
}

fn env_nonempty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn ensure_daemon_id(zterm_dir: &Path, host: &str) -> Result<String> {
    let id_path = zterm_dir.join("daemon-id");
    if let Ok(existing) = fs::read_to_string(&id_path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    fs::create_dir_all(zterm_dir)?;
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let safe_host: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    let generated = format!("daemon-{}-{}", safe_host, &digest[..16]);
    fs::write(&id_path, format!("{generated}\n"))?;
    Ok(generated)
}

pub fn load_config() -> Result<DaemonConfig> {
    let zterm_dir = default_zterm_dir();
    let config_path = zterm_dir.join("config.json");
    let root = read_json_object(&config_path)?;
    let zterm = get_obj(&root, "zterm");
    let android = zterm.and_then(|m| get_obj(m, "android"));
    let mobile = get_obj(&root, "mobile");

    let daemon_map = android
        .and_then(|m| get_obj(m, "daemon"))
        .or_else(|| mobile.and_then(|m| get_obj(m, "daemon")));
    let relay_map = android
        .and_then(|m| get_obj(m, "relay"))
        .or_else(|| mobile.and_then(|m| get_obj(m, "relay")));

    let host = env_nonempty("ZTERM_HOST")
        .or_else(|| env_nonempty("HOST"))
        .or_else(|| {
            let s = get_str(daemon_map, "host");
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| "0.0.0.0".to_string());

    let port = env_nonempty("ZTERM_PORT")
        .or_else(|| env_nonempty("PORT"))
        .and_then(|s| s.parse::<u16>().ok())
        .or_else(|| get_u16(daemon_map, "port"))
        .unwrap_or(3333);

    let auth_token = env_nonempty("ZTERM_AUTH_TOKEN")
        .unwrap_or_else(|| get_str(daemon_map, "authToken"));

    let relay_url = env_nonempty("ZTERM_TRAVERSAL_RELAY_URL")
        .unwrap_or_else(|| get_str(relay_map, "relayUrl"));
    let username = env_nonempty("ZTERM_TRAVERSAL_USERNAME")
        .unwrap_or_else(|| get_str(relay_map, "username"));
    let password = env_nonempty("ZTERM_TRAVERSAL_PASSWORD")
        .unwrap_or_else(|| get_str(relay_map, "password"));
    let relay_host_id = env_nonempty("ZTERM_TRAVERSAL_HOST_ID")
        .unwrap_or_else(|| get_str(relay_map, "hostId"));

    let hostname = hostname_string();
    let device_id = env_nonempty("ZTERM_TRAVERSAL_DEVICE_ID")
        .or_else(|| {
            let s = get_str(relay_map, "deviceId");
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| hostname.clone());
    let device_name = {
        let s = get_str(relay_map, "deviceName");
        if s.is_empty() { hostname.clone() } else { s }
    };

    let relay = if !relay_url.is_empty()
        && !username.is_empty()
        && !password.is_empty()
        && !relay_host_id.is_empty()
    {
        Some(RelayConfig {
            relay_url,
            username,
            password,
            host_id: relay_host_id.clone(),
            device_id: device_id.clone(),
            device_name,
        })
    } else {
        None
    };

    let daemon_host_id = if let Some(ref r) = relay {
        r.host_id.clone()
    } else {
        ensure_daemon_id(&zterm_dir, &hostname)?
    };

    Ok(DaemonConfig {
        zterm_dir,
        config_path,
        host,
        port,
        auth_token,
        daemon_host_id,
        device_id,
        relay,
    })
}

pub fn configure_relay_cmd(
    relay_url: String,
    username: String,
    password_stdin: bool,
    host_id: String,
    device_name: Option<String>,
) -> Result<()> {
    if !password_stdin {
        anyhow::bail!("configure-relay requires --password-stdin");
    }
    let mut password = String::new();
    io::stdin().read_to_string(&mut password)?;
    let password = password.trim_end_matches(&['\r', '\n'][..]).to_string();
    if password.is_empty() {
        anyhow::bail!("empty password on stdin");
    }

    let zterm_dir = default_zterm_dir();
    fs::create_dir_all(&zterm_dir)?;
    let config_path = zterm_dir.join("config.json");
    let mut root = read_json_object(&config_path)?;

    let zterm_val = root
        .entry("zterm")
        .or_insert_with(|| Value::Object(Map::new()));
    if !zterm_val.is_object() {
        *zterm_val = Value::Object(Map::new());
    }
    let zterm_obj = zterm_val.as_object_mut().unwrap();

    let android_val = zterm_obj
        .entry("android")
        .or_insert_with(|| Value::Object(Map::new()));
    if !android_val.is_object() {
        *android_val = Value::Object(Map::new());
    }
    let android_obj = android_val.as_object_mut().unwrap();

    let relay_val = android_obj
        .entry("relay")
        .or_insert_with(|| Value::Object(Map::new()));
    if !relay_val.is_object() {
        *relay_val = Value::Object(Map::new());
    }
    let relay_obj = relay_val.as_object_mut().unwrap();

    let resolved_name = device_name.unwrap_or_else(|| host_id.clone());
    relay_obj.insert("relayUrl".to_string(), Value::String(relay_url.trim().to_string()));
    relay_obj.insert("username".to_string(), Value::String(username.trim().to_string()));
    relay_obj.insert("password".to_string(), Value::String(password));
    relay_obj.insert("hostId".to_string(), Value::String(host_id.trim().to_string()));
    relay_obj.insert("deviceId".to_string(), Value::String(host_id.trim().to_string()));
    relay_obj.insert("deviceName".to_string(), Value::String(resolved_name.clone()));

    let tmp_path = zterm_dir.join(format!("config.json.tmp-{}", uuid::Uuid::new_v4()));
    let serialized = serde_json::to_string_pretty(&Value::Object(root))?;
    fs::write(&tmp_path, format!("{serialized}\n"))?;
    fs::rename(&tmp_path, &config_path)?;

    println!(
        "zterm relay configured: path={} relayUrl={} username={} hostId={} deviceName={} passwordSet=true",
        config_path.display(),
        relay_url.trim(),
        username.trim(),
        host_id.trim(),
        resolved_name
    );
    Ok(())
}
