use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorState {
    pub row_index: u16,
    pub col: u16,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompactIndexedLine {
    pub i: usize,
    pub t: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub s: Vec<(u16, u16, u16, u16, u16)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferSnapshot {
    pub revision: u64,
    pub start_index: usize,
    pub end_index: usize,
    pub available_start_index: usize,
    pub available_end_index: usize,
    pub cols: u16,
    pub rows: u16,
    pub cursor_keys_app: bool,
    pub cursor: CursorState,
    pub lines: Vec<CompactIndexedLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogEntry {
    pub name: String,
    pub backend: String,
    pub stable_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone)]
pub struct SessionUpdateEvent {
    pub session_name: String,
    pub revision: u64,
}

struct PtySessionState {
    name: String,
    stable_id: String,
    cols: u16,
    rows: u16,
    revision: u64,
    parser: vt100::Parser,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySessionState>>>,
    updates_tx: broadcast::Sender<SessionUpdateEvent>,
}

fn default_shell() -> String {
    for candidate in ["/bin/ash", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

fn make_stable_id(name: &str) -> String {
    let encoded = serde_json::json!({ "sessionName": name, "lite": true }).to_string();
    let escaped: String = url::form_urlencoded::byte_serialize(encoded.as_bytes()).collect();
    format!("tmux:v1:{escaped}")
}

fn color_to_code(color: vt100::Color) -> u16 {
    match color {
        vt100::Color::Default => 256,
        vt100::Color::Idx(idx) => idx as u16,
        vt100::Color::Rgb(r, g, b) => {
            // Map to nearest 256-color or default if needed; keep simple 16/256 compat
            let _ = (r, g, b);
            256
        }
    }
}

fn screen_to_snapshot(state: &PtySessionState, max_lines: Option<usize>) -> BufferSnapshot {
    let screen = state.parser.screen();
    let (rows, cols) = screen.size();
    let total_rows = rows as usize;
    let take_rows = max_lines.map(|m| m.min(total_rows)).unwrap_or(total_rows);
    let start_index = total_rows.saturating_sub(take_rows);
    let mut lines = Vec::with_capacity(take_rows);

    for row in start_index..total_rows {
        let mut text = String::new();
        let mut spans: Vec<(u16, u16, u16, u16, u16)> = Vec::new();
        let mut last_non_space_len = 0usize;

        for col in 0..cols {
            if let Some(cell) = screen.cell(row as u16, col) {
                let ch = cell.contents();
                let fg = color_to_code(cell.fgcolor());
                let bg = color_to_code(cell.bgcolor());
                let mut flags = 0u16;
                if cell.bold() { flags |= 1; }
                if cell.italic() { flags |= 2; }
                if cell.underline() { flags |= 4; }
                if cell.inverse() { flags |= 8; }

                if ch.is_empty() {
                    text.push(' ');
                } else {
                    text.push_str(&ch);
                    if ch != " " {
                        last_non_space_len = text.len();
                    }
                }
                if fg != 256 || bg != 256 || flags != 0 {
                    if let Some(last) = spans.last_mut() {
                        if last.1 == col && last.2 == fg && last.3 == bg && last.4 == flags {
                            last.1 = col + 1;
                            continue;
                        }
                    }
                    spans.push((col, col + 1, fg, bg, flags));
                }
            } else {
                text.push(' ');
            }
        }
        if spans.is_empty() {
            text.truncate(last_non_space_len);
        } else {
            text = text.trim_end().to_string();
        }
        lines.push(CompactIndexedLine {
            i: row,
            t: text,
            s: spans,
        });
    }

    let (cur_row, cur_col) = screen.cursor_position();
    BufferSnapshot {
        revision: state.revision,
        start_index,
        end_index: total_rows,
        available_start_index: 0,
        available_end_index: total_rows,
        cols,
        rows,
        cursor_keys_app: screen.application_cursor(),
        cursor: CursorState {
            row_index: cur_row,
            col: cur_col,
            visible: !screen.hide_cursor(),
        },
        lines,
    }
}

impl PtyManager {
    pub fn new() -> Result<Self> {
        let (updates_tx, _) = broadcast::channel(256);
        let mgr = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            updates_tx,
        };
        mgr.create_session("main", 80, 24)?;
        Ok(mgr)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionUpdateEvent> {
        self.updates_tx.subscribe()
    }

    pub fn create_session(&self, name: &str, cols: u16, rows: u16) -> Result<()> {
        let mut guard = self.sessions.lock().unwrap();
        if guard.contains_key(name) {
            return Ok(());
        }
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: rows.max(4),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let shell = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "C.UTF-8");
        let _child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to spawn shell {shell}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let stable_id = make_stable_id(name);
        let state = PtySessionState {
            name: name.to_string(),
            stable_id,
            cols: cols.max(20),
            rows: rows.max(4),
            revision: 1,
            parser: vt100::Parser::new(rows.max(4), cols.max(20), 1000),
            master: pair.master,
            writer,
        };
        guard.insert(name.to_string(), state);
        drop(guard);

        let sessions = Arc::clone(&self.sessions);
        let updates_tx = self.updates_tx.clone();
        let session_name = name.to_string();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let rev = {
                            let mut map = sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(&session_name) {
                                s.parser.process(&buf[..n]);
                                s.revision = s.revision.saturating_add(1);
                                Some(s.revision)
                            } else {
                                None
                            }
                        };
                        if let Some(revision) = rev {
                            let _ = updates_tx.send(SessionUpdateEvent {
                                session_name: session_name.clone(),
                                revision,
                            });
                        } else {
                            break;
                        }
                    }
                }
            }
        });
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionCatalogEntry> {
        let guard = self.sessions.lock().unwrap();
        let mut list: Vec<_> = guard
            .values()
            .map(|s| SessionCatalogEntry {
                name: s.name.clone(),
                backend: "tmux".to_string(),
                stable_id: s.stable_id.clone(),
                cwd: "/root".to_string(),
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub fn find_by_stable_id(&self, stable_id: &str) -> Option<String> {
        let guard = self.sessions.lock().unwrap();
        guard
            .values()
            .find(|s| s.stable_id == stable_id)
            .map(|s| s.name.clone())
    }

    pub fn snapshot(&self, name: &str, max_lines: Option<usize>) -> Option<(String, BufferSnapshot)> {
        let guard = self.sessions.lock().unwrap();
        guard
            .get(name)
            .map(|s| (s.stable_id.clone(), screen_to_snapshot(s, max_lines)))
    }

    pub fn write_input(&self, name: &str, data: &[u8]) -> Result<()> {
        let mut guard = self.sessions.lock().unwrap();
        let s = guard
            .get_mut(name)
            .with_context(|| format!("session not found: {name}"))?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, name: &str, cols: u16, rows: u16) -> Result<()> {
        let mut guard = self.sessions.lock().unwrap();
        let s = guard
            .get_mut(name)
            .with_context(|| format!("session not found: {name}"))?;
        let c = cols.max(20);
        let r = rows.max(4);
        if s.cols != c || s.rows != r {
            s.master.resize(PtySize {
                rows: r,
                cols: c,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            s.parser.set_size(r, c);
            s.cols = c;
            s.rows = r;
            s.revision = s.revision.saturating_add(1);
        }
        Ok(())
    }

    pub fn kill_session(&self, name: &str) -> bool {
        let mut guard = self.sessions.lock().unwrap();
        guard.remove(name).is_some()
    }
}
