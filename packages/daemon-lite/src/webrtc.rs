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
                        if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() {
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
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("100.100.100.100:80").is_ok() {
            if let Ok(local) = sock.local_addr() {
                let ip = local.ip();
                if !ip.is_loopback() && !ip.is_unspecified() && !addrs.contains(&ip) {
                    addrs.push(ip);
                }
            }
        }
        if sock.connect("1.1.1.1:80").is_ok() {
            if let Ok(local) = sock.local_addr() {
                let ip = local.ip();
                if !ip.is_loopback() && !ip.is_unspecified() && !addrs.contains(&ip) {
                    addrs.push(ip);
                }
            }
        }
    }
    if addrs.is_empty() {
        addrs.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    addrs
}

fn parse_stun_xor_mapped_ipv4(packet: &[u8], txn_id: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < 20 {
        return None;
    }
    // STUN Binding Success Response (0x0101) + Magic Cookie (0x2112A442)
    if packet[0] != 0x01 || packet[1] != 0x01 {
        return None;
    }
    if packet[4..8] != [0x21, 0x12, 0xA4, 0x42] || &packet[8..20] != txn_id {
        return None;
    }
    let msg_len = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let end = (20 + msg_len).min(packet.len());
    let mut pos = 20;
    while pos + 4 <= end {
        let attr_type = u16::from_be_bytes([packet[pos], packet[pos + 1]]);
        let attr_len = u16::from_be_bytes([packet[pos + 2], packet[pos + 3]]) as usize;
        pos += 4;
        if pos + attr_len > end {
            break;
        }
        // XOR-MAPPED-ADDRESS (0x0020), IPv4 family (0x01)
        if attr_type == 0x0020 && attr_len >= 8 && packet[pos + 1] == 0x01 {
            let port = u16::from_be_bytes([packet[pos + 2], packet[pos + 3]]) ^ 0x2112;
            let ip = Ipv4Addr::new(
                packet[pos + 4] ^ 0x21,
                packet[pos + 5] ^ 0x12,
                packet[pos + 6] ^ 0xA4,
                packet[pos + 7] ^ 0x42,
            );
            return Some(SocketAddr::new(IpAddr::V4(ip), port));
        }
        // MAPPED-ADDRESS (0x0001), IPv4 family (0x01)
        if attr_type == 0x0001 && attr_len >= 8 && packet[pos + 1] == 0x01 {
            let port = u16::from_be_bytes([packet[pos + 2], packet[pos + 3]]);
            let ip = Ipv4Addr::new(packet[pos + 4], packet[pos + 5], packet[pos + 6], packet[pos + 7]);
            return Some(SocketAddr::new(IpAddr::V4(ip), port));
        }
        pos += (attr_len + 3) & !3;
    }
    None
}

async fn gather_stun_srflx(sock: &UdpSocket) -> Option<SocketAddr> {
    let txn_id: [u8; 12] = rand_txn_id();
    let mut req = [0u8; 20];
    req[0] = 0x00;
    req[1] = 0x01; // Binding Request
    req[4..8].copy_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
    req[8..20].copy_from_slice(&txn_id);

    for host in ["stun.cloudflare.com:3478", "stun.l.google.com:19302"] {
        if let Ok(mut addrs) = tokio::net::lookup_host(host).await {
            if let Some(target) = addrs.find(|a| a.is_ipv4()) {
                let _ = sock.send_to(&req, target).await;
                let mut buf = [0u8; 512];
                if let Ok(Ok((n, _))) =
                    tokio::time::timeout(Duration::from_millis(450), sock.recv_from(&mut buf)).await
                {
                    if let Some(mapped) = parse_stun_xor_mapped_ipv4(&buf[..n], &txn_id) {
                        return Some(mapped);
                    }
                }
            }
        }
    }
    None
}

fn rand_txn_id() -> [u8; 12] {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut id = [0u8; 12];
    id[..8].copy_from_slice(&nanos.to_le_bytes()[..8]);
    id[8..12].copy_from_slice(&std::process::id().to_le_bytes());
    id
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
    // Bind one wildcard UDP socket for STUN srflx discovery and outbound TURN/NAT traffic.
    if let Ok(wan_sock) = UdpSocket::bind("0.0.0.0:0").await {
        if let Ok(wan_local) = wan_sock.local_addr() {
            let base_ip = local_ips
                .iter()
                .find(|ip| {
                    if let IpAddr::V4(v4) = ip {
                        let o = v4.octets();
                        !(o[0] == 100 && o[1] >= 64 && o[1] <= 127)
                    } else {
                        false
                    }
                })
                .copied()
                .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
            let base_addr = SocketAddr::new(base_ip, wan_local.port());
            if let Some(srflx_addr) = gather_stun_srflx(&wan_sock).await {
                if let Ok(cand) = Candidate::server_reflexive(srflx_addr, base_addr, Protocol::Udp) {
                    rtc.add_local_candidate(cand);
                }
            }
            sockets.push((base_addr, Arc::new(wan_sock)));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stun_xor_mapped_ipv4_response() {
        let txn_id = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        // XOR port 45678 ^ 0x2112, IP 38.76.197.22 ^ [0x21, 0x12, 0xA4, 0x42]
        let xport = (45678u16 ^ 0x2112).to_be_bytes();
        let xip = [38 ^ 0x21, 76 ^ 0x12, 197 ^ 0xA4, 22 ^ 0x42];
        let mut pkt = vec![
            0x01, 0x01, 0x00, 12, // Binding Success Response, len 12
            0x21, 0x12, 0xA4, 0x42, // Magic Cookie
        ];
        pkt.extend_from_slice(&txn_id);
        pkt.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]); // XOR-MAPPED-ADDRESS, len 8, IPv4
        pkt.extend_from_slice(&xport);
        pkt.extend_from_slice(&xip);

        assert_eq!(
            parse_stun_xor_mapped_ipv4(&pkt, &txn_id),
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::new(38, 76, 197, 22)), 45678))
        );
    }

    #[test]
    fn rejects_mismatched_stun_txn_id() {
        let txn_id = [1u8; 12];
        let mut pkt = vec![0x01, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42];
        pkt.extend_from_slice(&[2u8; 12]);
        assert_eq!(parse_stun_xor_mapped_ipv4(&pkt, &txn_id), None);
    }

    #[test]
    fn parses_wrtc_relay_candidate() {
        let s = "candidate:1255221804 1 udp 41885439 159.75.134.56 49219 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag JrUT network-id 1 network-cost 50";
        let res = Candidate::from_sdp_string(s);
        println!("PARSED: {res:?}");
        assert!(res.is_ok(), "failed: {res:?}");
    }
}
