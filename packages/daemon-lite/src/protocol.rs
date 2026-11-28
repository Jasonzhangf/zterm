use crate::pty::PtyManager;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BUFFER_SYNC_BYTES: usize = 128_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone)]
pub struct OutboundFrame {
    pub bulk: bool,
    pub text: String,
}

pub struct ChannelAttachment {
    pub channel_id: String,
    pub session_name: String,
    pub body_subscribed: bool,
}

pub struct MuxConnectionState {
    pub daemon_host_id: String,
    pub transport_id: String,
    pub hello_seen: bool,
    pub channels: HashMap<String, ChannelAttachment>,
    pub pty: Arc<PtyManager>,
}

impl MuxConnectionState {
    pub fn new(daemon_host_id: String, pty: Arc<PtyManager>) -> Self {
        Self {
            daemon_host_id,
            transport_id: uuid::Uuid::new_v4().to_string(),
            hello_seen: false,
            channels: HashMap::new(),
            pty,
        }
    }

    pub fn handle_text(&mut self, raw: &str) -> Vec<OutboundFrame> {
        let parsed: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return vec![],
        };
        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);

        match msg_type {
            "mux-hello" => {
                self.hello_seen = true;
                vec![OutboundFrame {
                    bulk: false,
                    text: json!({
                        "type": "mux-ready",
                        "payload": {
                            "version": 1,
                            "daemonHostId": self.daemon_host_id,
                            "capabilities": {
                                "version": 1,
                                "channelEnvelope": true,
                                "targetMessages": true,
                                "boundedBodyScheduler": true,
                                "bulkChannel": { "version": 1, "label": "zterm-bulk" },
                                "reliableInput": { "version": 1 }
                            }
                        }
                    })
                    .to_string(),
                }]
            }
            "mux-ping" => {
                let sent_at = payload.get("sentAt").and_then(|v| v.as_u64()).unwrap_or(0);
                vec![OutboundFrame {
                    bulk: false,
                    text: json!({
                        "type": "mux-pong",
                        "payload": { "sentAt": sent_at, "receivedAt": now_ms() }
                    })
                    .to_string(),
                }]
            }
            "mux-target-message" => self.handle_target_message(&payload),
            "mux-channel-open" => self.handle_channel_open(&payload),
            "mux-channel-message" => self.handle_channel_message(&payload),
            "mux-channel-close" => {
                if let Some(cid) = payload.get("channelId").and_then(|v| v.as_str()) {
                    self.channels.remove(cid);
                }
                vec![]
            }
            _ => vec![],
        }
    }

    fn handle_target_message(&self, payload: &Value) -> Vec<OutboundFrame> {
        let request_id = payload.get("requestId").cloned();
        let message = match payload.get("message") {
            Some(m) => m,
            None => return vec![],
        };
        let inner_type = message.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let inner_payload = message.get("payload").cloned().unwrap_or(Value::Null);

        match inner_type {
            "list-sessions" => {
                let catalog = self.pty.list_sessions();
                let names: Vec<String> = catalog.iter().map(|c| c.name.clone()).collect();
                let ts = now_ms();
                let activities: Vec<Value> = names
                    .iter()
                    .map(|n| json!({ "name": n, "lastLiveActivityAt": ts, "stopped": false }))
                    .collect();

                let mut resp_payload = json!({
                    "message": {
                        "type": "sessions",
                        "payload": {
                            "sessions": names,
                            "sessionCatalog": catalog,
                        }
                    }
                });
                if let Some(req_id) = request_id {
                    resp_payload["requestId"] = req_id;
                }
                vec![
                    OutboundFrame {
                        bulk: false,
                        text: json!({ "type": "mux-target-message", "payload": resp_payload }).to_string(),
                    },
                    OutboundFrame {
                        bulk: false,
                        text: json!({
                            "type": "mux-target-message",
                            "payload": {
                                "message": {
                                    "type": "session-activity",
                                    "payload": { "activities": activities }
                                }
                            }
                        })
                        .to_string(),
                    },
                ]
            }
            "terminal-snapshot-request" => {
                let stable_id = inner_payload
                    .get("stableId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let max_lines = inner_payload
                    .get("maxLines")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);

                let session_name = self.pty.find_by_stable_id(stable_id);
                let result_msg = if let Some(name) = session_name {
                    if let Some((sid, snap)) = self.pty.snapshot(&name, max_lines) {
                        json!({
                            "type": "terminal-snapshot-result",
                            "payload": {
                                "status": "available",
                                "backend": "tmux",
                                "stableId": sid,
                                "head": {
                                    "sessionId": name,
                                    "revision": snap.revision,
                                    "latestEndIndex": snap.end_index,
                                    "availableStartIndex": snap.available_start_index,
                                    "availableEndIndex": snap.available_end_index,
                                    "cursorKeysApp": snap.cursor_keys_app,
                                    "cursor": snap.cursor,
                                },
                                "body": {
                                    "revision": snap.revision,
                                    "startIndex": snap.start_index,
                                    "endIndex": snap.end_index,
                                    "availableStartIndex": snap.available_start_index,
                                    "availableEndIndex": snap.available_end_index,
                                    "cols": snap.cols,
                                    "rows": snap.rows,
                                    "cursorKeysApp": snap.cursor_keys_app,
                                    "cursor": snap.cursor,
                                    "lines": snap.lines,
                                }
                            }
                        })
                    } else {
                        json!({
                            "type": "terminal-snapshot-result",
                            "payload": { "status": "unavailable", "reason": "mirror_not_present" }
                        })
                    }
                } else {
                    json!({
                        "type": "terminal-snapshot-result",
                        "payload": { "status": "failed", "code": "session_not_found" }
                    })
                };

                let mut resp_payload = json!({ "message": result_msg });
                if let Some(req_id) = request_id {
                    resp_payload["requestId"] = req_id;
                }
                vec![OutboundFrame {
                    bulk: true,
                    text: json!({ "type": "mux-target-message", "payload": resp_payload }).to_string(),
                }]
            }
            "tmux-create-session" => {
                let name = inner_payload
                    .get("sessionName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("main");
                let _ = self.pty.create_session(name, 80, 24);
                vec![]
            }
            "tmux-kill-session" => {
                if let Some(name) = inner_payload.get("sessionName").and_then(|v| v.as_str()) {
                    self.pty.kill_session(name);
                }
                vec![]
            }
            _ => vec![],
        }
    }

    fn handle_channel_open(&mut self, payload: &Value) -> Vec<OutboundFrame> {
        let channel_id = match payload.get("channelId").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => return vec![],
        };
        let requested_name = payload
            .get("sessionName")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string();
        let expected_id = payload
            .get("expectedSessionIdentity")
            .and_then(|v| v.as_str());
        let existing_only = payload
            .get("existingOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let cols = payload.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
        let rows = payload.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
        let width_mode = payload
            .get("widthMode")
            .and_then(|v| v.as_str())
            .unwrap_or("adaptive-phone");
        let body_subscribed = payload
            .get("bodySubscribed")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let target_session = if let Some(exp) = expected_id {
            match self.pty.find_by_stable_id(exp) {
                Some(found) => found,
                None => {
                    return vec![OutboundFrame {
                        bulk: false,
                        text: json!({
                            "type": "mux-channel-closed",
                            "payload": {
                                "channelId": channel_id,
                                "reason": "expectedSessionIdentity not found",
                                "code": "session_identity_mismatch"
                            }
                        })
                        .to_string(),
                    }];
                }
            }
        } else {
            if !existing_only {
                let _ = self.pty.create_session(&requested_name, cols, rows);
            }
            requested_name
        };

        if width_mode == "adaptive-phone" {
            let _ = self.pty.resize(&target_session, cols, rows);
        }

        let (stable_id, snap) = match self.pty.snapshot(&target_session, None) {
            Some(pair) => pair,
            None => {
                return vec![OutboundFrame {
                    bulk: false,
                    text: json!({
                        "type": "mux-channel-closed",
                        "payload": {
                            "channelId": channel_id,
                            "reason": "session not found",
                            "code": "mux_channel_open_failed"
                        }
                    })
                    .to_string(),
                }];
            }
        };

        self.channels.insert(
            channel_id.clone(),
            ChannelAttachment {
                channel_id: channel_id.clone(),
                session_name: target_session.clone(),
                body_subscribed,
            },
        );

        let mut out = vec![
            OutboundFrame {
                bulk: false,
                text: json!({
                    "type": "mux-channel-opened",
                    "payload": {
                        "channelId": channel_id,
                        "sessionName": target_session,
                        "stableId": stable_id,
                        "capabilities": { "reliableInput": { "version": 1 } }
                    }
                })
                .to_string(),
            },
            OutboundFrame {
                bulk: false,
                text: json!({
                    "type": "mux-channel-message",
                    "payload": {
                        "channelId": channel_id,
                        "message": { "type": "title", "payload": target_session }
                    }
                })
                .to_string(),
            },
            OutboundFrame {
                bulk: false,
                text: json!({
                    "type": "mux-channel-message",
                    "payload": {
                        "channelId": channel_id,
                        "message": {
                            "type": "connected",
                            "payload": {
                                "sessionId": format!("{}:{}", self.transport_id, channel_id),
                                "daemonHostId": self.daemon_host_id,
                                "capabilities": { "reliableInput": { "version": 1 } }
                            }
                        }
                    }
                })
                .to_string(),
            },
        ];

        if body_subscribed {
            out.extend(self.build_buffer_sync_frames(&channel_id, &snap));
        }
        out
    }

    fn handle_channel_message(&mut self, payload: &Value) -> Vec<OutboundFrame> {
        let channel_id = match payload.get("channelId").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => return vec![],
        };
        let session_name = match self.channels.get(&channel_id) {
            Some(att) => att.session_name.clone(),
            None => return vec![],
        };
        let message = match payload.get("message") {
            Some(m) => m,
            None => return vec![],
        };
        let inner_type = message.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let inner_payload = message.get("payload").cloned().unwrap_or(Value::Null);

        match inner_type {
            "input" => {
                if let Some(raw) = inner_payload.as_str() {
                    let _ = self.pty.write_input(&session_name, raw.as_bytes());
                    return vec![];
                }
                let seq = inner_payload
                    .get("seq")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let data = inner_payload
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let bytes = data.as_bytes();
                let res = self.pty.write_input(&session_name, bytes);
                if seq.is_empty() {
                    return vec![];
                }
                let ack = match res {
                    Ok(()) => json!({
                        "type": "input-ack",
                        "payload": { "version": 1, "seq": seq, "accepted": true, "bytes": bytes.len() }
                    }),
                    Err(err) => json!({
                        "type": "input-ack",
                        "payload": { "version": 1, "seq": seq, "accepted": false, "bytes": 0, "error": err.to_string() }
                    }),
                };
                vec![OutboundFrame {
                    bulk: false,
                    text: json!({
                        "type": "mux-channel-message",
                        "payload": { "channelId": channel_id, "message": ack }
                    })
                    .to_string(),
                }]
            }
            "resize" => {
                let cols = inner_payload.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                let rows = inner_payload.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                let width_mode = inner_payload
                    .get("widthMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("adaptive-phone");
                if width_mode == "adaptive-phone" {
                    let _ = self.pty.resize(&session_name, cols, rows);
                }
                vec![]
            }
            "body-subscription" => {
                let subscribed = inner_payload
                    .get("subscribed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if let Some(att) = self.channels.get_mut(&channel_id) {
                    att.body_subscribed = subscribed;
                }
                if subscribed {
                    if let Some((_, snap)) = self.pty.snapshot(&session_name, None) {
                        return self.build_buffer_sync_frames(&channel_id, &snap);
                    }
                }
                vec![]
            }
            "buffer-head-request" => {
                if let Some((_, snap)) = self.pty.snapshot(&session_name, None) {
                    return vec![OutboundFrame {
                        bulk: false,
                        text: json!({
                            "type": "mux-channel-message",
                            "payload": {
                                "channelId": channel_id,
                                "message": {
                                    "type": "buffer-head",
                                    "payload": {
                                        "sessionId": session_name,
                                        "revision": snap.revision,
                                        "latestEndIndex": snap.end_index,
                                        "availableStartIndex": snap.available_start_index,
                                        "availableEndIndex": snap.available_end_index,
                                        "cursorKeysApp": snap.cursor_keys_app,
                                        "cursor": snap.cursor,
                                    }
                                }
                            }
                        })
                        .to_string(),
                    }];
                }
                vec![]
            }
            "buffer-sync-request" => {
                if let Some((_, snap)) = self.pty.snapshot(&session_name, None) {
                    return self.build_buffer_sync_frames(&channel_id, &snap);
                }
                vec![]
            }
            _ => vec![],
        }
    }

    pub fn build_updates_for_session(&self, session_name: &str) -> Vec<OutboundFrame> {
        let mut out = Vec::new();
        let attached: Vec<_> = self
            .channels
            .values()
            .filter(|c| c.session_name == session_name && c.body_subscribed)
            .collect();
        if attached.is_empty() {
            return out;
        }
        if let Some((_, snap)) = self.pty.snapshot(session_name, None) {
            for att in attached {
                out.extend(self.build_buffer_sync_frames(&att.channel_id, &snap));
            }
        }
        out
    }

    fn build_buffer_sync_frames(
        &self,
        channel_id: &str,
        snap: &crate::pty::BufferSnapshot,
    ) -> Vec<OutboundFrame> {
        let now = now_ms();
        let frame_start = snap.start_index;
        let frame_end = snap.end_index;
        let payload = json!({
            "type": "buffer-sync",
            "payload": {
                "revision": snap.revision,
                "startIndex": frame_start,
                "endIndex": frame_end,
                "frameStartIndex": frame_start,
                "frameEndIndex": frame_end,
                "frameChunkIndex": 0,
                "frameChunkCount": 1,
                "generatedAt": now,
                "requestSentAt": now,
                "availableStartIndex": snap.available_start_index,
                "availableEndIndex": snap.available_end_index,
                "cols": snap.cols,
                "rows": snap.rows,
                "cursorKeysApp": snap.cursor_keys_app,
                "cursor": snap.cursor,
                "lines": snap.lines,
            }
        });
        let text = json!({
            "type": "mux-channel-message",
            "payload": { "channelId": channel_id, "message": payload }
        })
        .to_string();
        if text.len() <= MAX_BUFFER_SYNC_BYTES || snap.lines.len() <= 1 {
            return vec![OutboundFrame { bulk: true, text }];
        }

        // Split lines into 2+ chunks if a single buffer-sync exceeds 128 KB
        let mid = snap.lines.len() / 2;
        let chunks = [&snap.lines[..mid], &snap.lines[mid..]];
        let count = chunks.len();
        chunks
            .iter()
            .enumerate()
            .map(|(idx, slice)| {
                let s = slice.first().map(|l| l.i).unwrap_or(frame_start);
                let e = slice.last().map(|l| l.i + 1).unwrap_or(frame_end);
                let msg = json!({
                    "type": "buffer-sync",
                    "payload": {
                        "revision": snap.revision,
                        "startIndex": s,
                        "endIndex": e,
                        "frameStartIndex": frame_start,
                        "frameEndIndex": frame_end,
                        "frameChunkIndex": idx,
                        "frameChunkCount": count,
                        "generatedAt": now,
                        "requestSentAt": now,
                        "availableStartIndex": snap.available_start_index,
                        "availableEndIndex": snap.available_end_index,
                        "cols": snap.cols,
                        "rows": snap.rows,
                        "cursorKeysApp": snap.cursor_keys_app,
                        "cursor": snap.cursor,
                        "lines": slice,
                    }
                });
                OutboundFrame {
                    bulk: true,
                    text: json!({
                        "type": "mux-channel-message",
                        "payload": { "channelId": channel_id, "message": msg }
                    })
                    .to_string(),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_mux_hello_and_ping_and_list_sessions() {
        let pty = Arc::new(PtyManager::new().expect("pty"));
        let mut mux = MuxConnectionState::new("test-host".to_string(), pty);

        let ready = mux.handle_text(r#"{"type":"mux-hello","payload":{"version":1,"clientInstanceId":"c1"}}"#);
        assert_eq!(ready.len(), 1);
        assert!(ready[0].text.contains("mux-ready"));
        assert!(ready[0].text.contains("test-host"));

        let pong = mux.handle_text(r#"{"type":"mux-ping","payload":{"sentAt":123}}"#);
        assert_eq!(pong.len(), 1);
        assert!(pong[0].text.contains("mux-pong"));

        let sessions = mux.handle_text(r#"{"type":"mux-target-message","payload":{"requestId":"r1","message":{"type":"list-sessions"}}}"#);
        assert_eq!(sessions.len(), 2);
        assert!(sessions[0].text.contains("main"));
    }
}
