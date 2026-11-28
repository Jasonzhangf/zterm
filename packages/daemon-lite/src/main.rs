mod config;
mod protocol;
mod pty;
mod relay;
mod webrtc;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::fs;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "zterm-daemon-lite", version, about = "Lightweight Rust zterm daemon (no Node.js, pure Rust DTLS-SCTP)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the daemon in the foreground
    Run,
    /// Configure Relay credentials in ~/.zterm/config.json
    ConfigureRelay {
        #[arg(long)]
        relay_url: String,
        #[arg(long)]
        username: String,
        #[arg(long)]
        password_stdin: bool,
        #[arg(long)]
        host_id: String,
        #[arg(long)]
        device_name: Option<String>,
    },
    /// Show daemon status
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::ConfigureRelay {
            relay_url,
            username,
            password_stdin,
            host_id,
            device_name,
        } => config::configure_relay_cmd(relay_url, username, password_stdin, host_id, device_name),
        Commands::Status => {
            let cfg = config::load_config()?;
            let pid_path = cfg.zterm_dir.join("daemon-lite.pid");
            if let Ok(pid_str) = fs::read_to_string(&pid_path) {
                let pid = pid_str.trim();
                if !pid.is_empty() && std::path::Path::new(&format!("/proc/{pid}")).exists() {
                    println!("zterm daemon-lite running: pid={pid} hostId={}", cfg.daemon_host_id);
                    return Ok(());
                }
            }
            println!("zterm daemon-lite stopped");
            Ok(())
        }
        Commands::Run => {
            let cfg = config::load_config()?;
            fs::create_dir_all(&cfg.zterm_dir)?;
            let pid_path = cfg.zterm_dir.join("daemon-lite.pid");
            fs::write(&pid_path, format!("{}\n", std::process::id()))?;

            let pty = Arc::new(pty::PtyManager::new()?);
            println!(
                "zterm-daemon-lite v{} started (hostId={}, sessions={})",
                env!("CARGO_PKG_VERSION"),
                cfg.daemon_host_id,
                pty.list_sessions().len()
            );

            relay::run_relay_loop(cfg, pty).await;
            Ok(())
        }
    }
}
