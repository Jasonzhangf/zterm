use crate::protocol::{MuxConnectionState, OutboundFrame};
use crate::pty::PtyManager;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

pub enum PeerSignalCmd {
    Signal(Value),
    Close,
}

pub struct WebRtcPeerManager {
    peers: HashMap<String, mpsc::Sender<PeerSignalCmd>>,
    daemon_host_id: String,
    pty: Arc<PtyManager>,
    signal_out_tx: mpsc::Sender<(String, Value)>,
}

impl WebRtcPeerManager {
    pub fn new(
        daemon_host_id: String,
        pty: Arc<PtyManager>,
        signal_out_tx: mpsc::Sender<(String, Value)>,
    ) -> Self {
        Self {
            peers: HashMap::new(),
            daemon_host_id,
            pty,
            signal_out_tx,
        }
    }

    pub async fn handle_signal(&mut self, peer_id: &str, msg: Value) {
        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if msg_type == "rtc-close" {
            self.close_peer(peer_id).await;
            return;
        }
        if msg_type == "rtc-init" {
            self.close_peer(peer_id).await;
            let tx = self.spawn_peer(peer_id.to_string());
            let _ = tx.send(PeerSignalCmd::Signal(msg)).await;
            return;
        }
        let tx = if let Some(existing) = self.peers.get(peer_id) {
            existing.clone()
        } else {
            self.spawn_peer(peer_id.to_string())
        };
        if tx.send(PeerSignalCmd::Signal(msg)).await.is_err() {
            self.peers.remove(peer_id);
        }
    }

    pub async fn close_peer(&mut self, peer_id: &str) {
        if let Some(tx) = self.peers.remove(peer_id) {
            let _ = tx.send(PeerSignalCmd::Close).await;
        }
    }

    fn spawn_peer(&mut self, peer_id: String) -> mpsc::Sender<PeerSignalCmd> {
        let (tx, rx) = mpsc::channel(64);
        self.peers.insert(peer_id.clone(), tx.clone());
        let daemon_host_id = self.daemon_host_id.clone();
        let pty = Arc::clone(&self.pty);
        let signal_out_tx = self.signal_out_tx.clone();
        tokio::spawn(async move {
            if let Err(err) =
                run_peer_loop(peer_id.clone(), daemon_host_id, pty, rx, signal_out_tx.clone()).await
            {
                let _ = signal_out_tx
                    .send((
                        peer_id,
                        json!({ "type": "rtc-error", "payload": { "message": err.to_string() } }),
                    ))
                    .await;
            }
        });
        tx
    }
}

fn discover_local_ipv4s() -> Vec<IpAddr> {
    let mut addrs = Vec::new();
    if let Ok(output) = std::process::Command::new("ip")
        .args(["-4", "-o", "addr", "show"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            for token in line.split_whitespace() {
                if let Some((ip_part, _prefix)) = token.split_once('/') {
                    if let Ok(ip) = ip_part.parse::<Ipv4Addr>() {
                        let octets = ip.octets();
                        let is_tailscale = octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127);
                        if !ip.is_loopback() && !is_tailscale {
                            let addr = IpAddr::V4(ip);
                            if !addrs.contains(&addr) {
                                addrs.push(addr);
                            }
                        }
                    }
                }
            }
        }
    }
    if addrs.is_empty() {
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect("1.1.1.1:80").is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if !local.ip().is_loopback() {
                        addrs.push(local.ip());
                    }
                }
            }
        }
    }
    if addrs.is_empty() {
        addrs.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    addrs
}

async fn run_peer_loop(
    peer_id: String,
    daemon_host_id: String,
    pty: Arc<PtyManager>,
    mut cmd_rx: mpsc::Receiver<PeerSignalCmd>,
    signal_out_tx: mpsc::Sender<(String, Value)>,
) -> Result<()> {
    let local_ips = discover_local_ipv4s();
    let mut sockets = Vec::new();
    let mut rtc = Rtc::new(Instant::now());

    for ip in &local_ips {
        if let Ok(sock) = UdpSocket::bind(SocketAddr::new(*ip, 0)).await {
            if let Ok(local_addr) = sock.local_addr() {
                if let Ok(cand) = Candidate::host(local_addr, Protocol::Udp) {
                    rtc.add_local_candidate(cand);
                    sockets.push((local_addr, Arc::new(sock)));
                }
            }
        }
    }
    if sockets.is_empty() {
        let sock = UdpSocket::bind("0.0.0.0:0").await?;
        let local_addr = sock.local_addr()?;
        if let Ok(cand) = Candidate::host(local_addr, Protocol::Udp) {
            rtc.add_local_candidate(cand);
        }
        sockets.push((local_addr, Arc::new(sock)));
    }

    let (pkt_tx, mut pkt_rx) = mpsc::channel::<(SocketAddr, SocketAddr, Vec<u8>)>(256);
    for (local_addr, sock) in &sockets {
        let sock = Arc::clone(sock);
        let local_addr = *local_addr;
        let pkt_tx = pkt_tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            while let Ok((n, source)) = sock.recv_from(&mut buf).await {
                if pkt_tx.send((local_addr, source, buf[..n].to_vec())).await.is_err() {
                    break;
                }
            }
        });
    }

    let mut mux = MuxConnectionState::new(daemon_host_id, Arc::clone(&pty));
    let mut pty_rx = pty.subscribe();
    let mut control_cid: Option<ChannelId> = None;
    let mut bulk_cid: Option<ChannelId> = None;

    loop {
        let timeout = match rtc.poll_output() {
            Ok(Output::Timeout(t)) => t,
            Ok(Output::Transmit(transmit)) => {
                if let Some((_, sock)) = sockets
                    .iter()
                    .find(|(addr, _)| *addr == transmit.source)
                    .or_else(|| sockets.first())
                {
                    let _ = sock.send_to(&transmit.contents, transmit.destination).await;
                }
                continue;
            }
            Ok(Output::Event(event)) => {
                match event {
                    Event::ChannelOpen(cid, label) => {
                        eprintln!("[webrtc {peer_id}] channel open: {label}");
                        if label == "zterm-bulk" {
                            bulk_cid = Some(cid);
                        } else if label == "zterm" {
                            control_cid = Some(cid);
                        }
                    }
                    Event::ChannelData(data) => {
                        if let Ok(text) = std::str::from_utf8(&data.data) {
                            let replies = mux.handle_text(text);
                            send_mux_frames(&mut rtc, control_cid, bulk_cid, replies);
                        }
                    }
                    Event::IceConnectionStateChange(state) => {
                        eprintln!("[webrtc {peer_id}] ice state: {state:?}");
                        if format!("{state:?}") == "Disconnected" {
                            break;
                        }
                    }
                    _ => {}
                }
                continue;
            }
            Err(_) => break,
        };

        let now = Instant::now();
        let sleep_dur = timeout
            .saturating_duration_since(now)
            .min(Duration::from_millis(250));

        tokio::select! {
            _ = tokio::time::sleep(sleep_dur) => {
                let _ = rtc.handle_input(Input::Timeout(Instant::now()));
            }
            Some((destination, source, packet)) = pkt_rx.recv() => {
                if let Ok(contents) = packet.as_slice().try_into() {
                    let _ = rtc.handle_input(Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination,
                            contents,
                        },
                    ));
                }
            }
            evt = pty_rx.recv() => {
                if let Ok(update) = evt {
                    if control_cid.is_some() {
                        let frames = mux.build_updates_for_session(&update.session_name);
                        send_mux_frames(&mut rtc, control_cid, bulk_cid, frames);
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(PeerSignalCmd::Close) | None => break,
                    Some(PeerSignalCmd::Signal(msg)) => {
                        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let payload = msg.get("payload").cloned().unwrap_or(Value::Null);
                        match msg_type {
                            "rtc-offer" => {
                                eprintln!("[webrtc {peer_id}] received rtc-offer (local_ips={local_ips:?})");
                                if let Some(sdp) = payload.get("sdp").and_then(|v| v.as_str()) {
                                    match SdpOffer::from_sdp_string(sdp) {
                                        Ok(offer) => match rtc.sdp_api().accept_offer(offer) {
                                            Ok(answer) => {
                                                let _ = signal_out_tx.send((
                                                    peer_id.clone(),
                                                    json!({
                                                        "type": "rtc-answer",
                                                        "payload": {
                                                            "type": "answer",
                                                            "sdp": answer.to_sdp_string()
                                                        }
                                                    }),
                                                )).await;
                                            }
                                            Err(e) => {
                                                let _ = signal_out_tx.send((
                                                    peer_id.clone(),
                                                    json!({ "type": "rtc-error", "payload": { "message": e.to_string() } }),
                                                )).await;
                                            }
                                        },
                                        Err(e) => {
                                            let _ = signal_out_tx.send((
                                                peer_id.clone(),
                                                json!({ "type": "rtc-error", "payload": { "message": e.to_string() } }),
                                            )).await;
                                        }
                                    }
                                }
                            }
                            "rtc-candidate" => {
                                if let Some(cand_str) = payload.get("candidate").and_then(|v| v.as_str()) {
                                    if !cand_str.trim().is_empty() {
                                        let normalized = cand_str.strip_prefix("a=").unwrap_or(cand_str);
                                        match Candidate::from_sdp_string(normalized) {
                                            Ok(cand) => {
                                                eprintln!("[webrtc {peer_id}] added remote candidate: {normalized}");
                                                rtc.add_remote_candidate(cand);
                                            }
                                            Err(e) => {
                                                eprintln!("[webrtc {peer_id}] bad remote candidate '{cand_str}': {e}");
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn send_mux_frames(
    rtc: &mut Rtc,
    control_cid: Option<ChannelId>,
    bulk_cid: Option<ChannelId>,
    frames: Vec<OutboundFrame>,
) {
    for frame in frames {
        let target_cid = if frame.bulk {
            bulk_cid.or(control_cid)
        } else {
            control_cid
        };
        if let Some(cid) = target_cid {
            if let Some(mut ch) = rtc.channel(cid) {
                let _ = ch.write(false, frame.text.as_bytes());
            }
        }
    }
}
