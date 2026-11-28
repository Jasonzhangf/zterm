use crate::config::DaemonConfig;
use crate::protocol::MuxConnectionState;
use crate::pty::PtyManager;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

fn is_authorized(req: &Request, expected_token: &str) -> bool {
    if expected_token.is_empty() {
        return true;
    }
    if let Some(auth_header) = req.headers().get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth_header.strip_prefix("Bearer ").or_else(|| auth_header.strip_prefix("bearer ")) {
            if token.trim() == expected_token {
                return true;
            }
        }
    }
    if let Some(query) = req.uri().query() {
        for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
            if k == "token" && v == expected_token {
                return true;
            }
        }
    }
    false
}

async fn handle_ws_client(
    stream: TcpStream,
    daemon_host_id: String,
    auth_token: String,
    pty: Arc<PtyManager>,
) {
    let ws_stream = match tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
            if is_authorized(req, &auth_token) {
                Ok(res)
            } else {
                let mut err_res = ErrorResponse::new(Some("Unauthorized".to_string()));
                *err_res.status_mut() = StatusCode::UNAUTHORIZED;
                Err(err_res)
            }
        },
    )
    .await
    {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let (mut write, mut read) = ws_stream.split();
    let mut mux = MuxConnectionState::new(daemon_host_id, Arc::clone(&pty));
    let mut pty_rx = pty.subscribe();

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let replies = mux.handle_text(&text);
                        for frame in replies {
                            if write.send(Message::Text(frame.text)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if write.send(Message::Pong(data)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    _ => {}
                }
            }
            evt = pty_rx.recv() => {
                if let Ok(update) = evt {
                    if !mux.channels.is_empty() {
                        let frames = mux.build_updates_for_session(&update.session_name);
                        for frame in frames {
                            if write.send(Message::Text(frame.text)).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

pub async fn run_ws_server(cfg: DaemonConfig, pty: Arc<PtyManager>) {
    let bind_addr = format!("0.0.0.0:{}", cfg.port);
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => {
            println!("ws mux server listening on {bind_addr}");
            l
        }
        Err(err) => {
            eprintln!("failed to bind ws mux server on {bind_addr}: {err}");
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let host_id = cfg.daemon_host_id.clone();
                let token = cfg.auth_token.clone();
                let pty_ref = Arc::clone(&pty);
                tokio::spawn(async move {
                    handle_ws_client(stream, host_id, token, pty_ref).await;
                });
            }
            Err(err) => {
                eprintln!("ws accept error: {err}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}
