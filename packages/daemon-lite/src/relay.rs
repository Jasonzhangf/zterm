use crate::config::DaemonConfig;
use crate::pty::PtyManager;
use crate::webrtc::WebRtcPeerManager;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn normalize_relay_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    format!("{trimmed}/")
}

fn to_ws_url(base: &str, path: &str) -> Result<String> {
    let mut parsed = url::Url::parse(base)?.join(path)?;
    match parsed.scheme() {
        "http" => {
            let _ = parsed.set_scheme("ws");
        }
        "https" => {
            let _ = parsed.set_scheme("wss");
        }
        _ => {}
    }
    Ok(parsed.to_string())
}

fn detect_tailscale_ip() -> Option<String> {
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("100.100.100.100:80").is_ok() {
            if let Ok(local) = sock.local_addr() {
                let ip = local.ip().to_string();
                if ip.starts_with("100.") {
                    return Some(ip);
                }
            }
        }
    }
    None
}

async fn login_relay(base: &str, username: &str, password: &str) -> Result<String> {
    let login_url = url::Url::parse(base)?.join("api/auth/login")?.to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let resp = client
        .post(&login_url)
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .with_context(|| format!("relay login request failed: {login_url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("relay login failed ({status}): {body}");
    }
    let body: Value = resp.json().await?;
    let token = body
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .context("relay login response missing accessToken")?;
    Ok(token)
}

fn build_directory_update(cfg: &DaemonConfig, pty: &PtyManager) -> Value {
    let now_iso = chrono::Utc::now().to_rfc3339();
    let endpoints = vec![
        json!({
            "id": format!("rtc-direct:{}", cfg.daemon_host_id),
            "kind": "rtc-direct",
            "relayHostId": cfg.daemon_host_id,
            "authRequired": !cfg.auth_token.is_empty(),
            "lastSeenAt": now_iso,
        }),
        json!({
            "id": format!("relay-rtc:{}", cfg.daemon_host_id),
            "kind": "relay-rtc",
            "relayHostId": cfg.daemon_host_id,
            "authRequired": !cfg.auth_token.is_empty(),
            "lastSeenAt": now_iso,
        }),
    ];

    let sessions: Vec<Value> = pty
        .list_sessions()
        .into_iter()
        .map(|s| {
            json!({
                "name": s.name,
                "cwd": s.cwd,
                "updatedAt": now_iso,
            })
        })
        .collect();

    json!({
        "type": "directory-update",
        "directory": {
            "endpoints": endpoints,
            "sessions": sessions,
            "publishedAt": now_iso,
        }
    })
}

pub async fn run_relay_loop(cfg: DaemonConfig, pty: Arc<PtyManager>) {
    let relay = match cfg.relay {
        Some(ref r) => r.clone(),
        None => {
            println!("traversal relay: disabled (missing relay config)");
            return;
        }
    };
    let base = normalize_relay_base(&relay.relay_url);
    println!("traversal relay: {base} (host={})", relay.host_id);

    loop {
        let token = match login_relay(&base, &relay.username, &relay.password).await {
            Ok(t) => t,
            Err(err) => {
                eprintln!("relay login error: {err}");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        let mut ws_url = match to_ws_url(&base, "ws/host").and_then(|u| Ok(url::Url::parse(&u)?)) {
            Ok(u) => u,
            Err(err) => {
                eprintln!("invalid relay ws/host URL: {err}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        ws_url
            .query_pairs_mut()
            .append_pair("token", &token)
            .append_pair("hostId", &relay.host_id)
            .append_pair("deviceId", &relay.device_id)
            .append_pair("deviceName", &relay.device_name)
            .append_pair("platform", "linux")
            .append_pair("appVersion", env!("CARGO_PKG_VERSION"))
            .append_pair("daemonVersion", env!("CARGO_PKG_VERSION"));

        let ws_stream = match connect_async(ws_url.as_str()).await {
            Ok((stream, _)) => stream,
            Err(err) => {
                eprintln!("relay ws connect error: {err}");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        let (mut write, mut read) = ws_stream.split();
        let (signal_out_tx, mut signal_out_rx) = mpsc::channel::<(String, Value)>(128);
        let mut rtc_peers = WebRtcPeerManager::new(
            cfg.daemon_host_id.clone(),
            Arc::clone(&pty),
            signal_out_tx,
        );
        let mut publish_tick = tokio::time::interval(Duration::from_secs(30));

        loop {
            tokio::select! {
                _ = publish_tick.tick() => {
                    let update = build_directory_update(&cfg, &pty);
                    if write.send(Message::Text(update.to_string())).await.is_err() {
                        break;
                    }
                    if write.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
                Some((peer_id, msg)) = signal_out_rx.recv() => {
                    let env = json!({
                        "type": "relay-signal",
                        "peerId": peer_id,
                        "message": msg,
                    });
                    if write.send(Message::Text(env.to_string())).await.is_err() {
                        break;
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                                match parsed.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                                    "relay-ready" => {
                                        println!("traversal relay host online: {}", relay.host_id);
                                        let update = build_directory_update(&cfg, &pty);
                                        if write.send(Message::Text(update.to_string())).await.is_err() {
                                            break;
                                        }
                                    }
                                    "relay-signal" => {
                                        if let (Some(pid), Some(msg)) = (
                                            parsed.get("peerId").and_then(|v| v.as_str()),
                                            parsed.get("message").cloned(),
                                        ) {
                                            rtc_peers.handle_signal(pid, msg).await;
                                        }
                                    }
                                    "relay-peer-close" => {
                                        if let Some(pid) = parsed.get("peerId").and_then(|v| v.as_str()) {
                                            rtc_peers.close_peer(pid).await;
                                        }
                                    }
                                    "relay-error" => {
                                        eprintln!("relay error: {parsed}");
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
            }
        }

        eprintln!("relay ws disconnected, reconnecting in 2s...");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
