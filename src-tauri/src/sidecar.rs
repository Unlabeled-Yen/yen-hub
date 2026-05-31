//! Production sidecar: spawn the bundled Node.js running our Next.js
//! standalone server, wait for it to bind, then point the webview at it.
//!
//! In dev (`cfg!(debug_assertions)`) we skip all of this — tauri.conf.json's
//! `devUrl` already covers `pnpm dev`.

use std::{
    fs,
    io::{self, Read},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::PathBuf,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_EVERY: Duration = Duration::from_millis(150);

/// Reserve an ephemeral port. There's a small race window between drop and
/// the child binding it, but for a single-process desktop app it's fine.
fn pick_port() -> io::Result<u16> {
    let l = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    let port = l.local_addr()?.port();
    drop(l);
    Ok(port)
}

/// iron-session needs a stable secret across runs. Generate one on first
/// launch into `~/Library/Application Support/com.yen.hub/session.key`
/// (0o600), then reuse it. Hex-encoded 48 bytes → 96 chars, comfortably
/// above the 32-char minimum.
fn ensure_session_secret(app: &AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let key_path = dir.join("session.key");

    if let Ok(existing) = fs::read_to_string(&key_path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 32 {
            return Ok(trimmed.to_string());
        }
    }

    let mut buf = [0u8; 48];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("read /dev/urandom: {e}"))?;
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    fs::write(&key_path, &hex).map_err(|e| format!("write session.key: {e}"))?;
    // 0o600 — owner read/write only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }
    log::info!("yen sidecar: generated session secret at {}", key_path.display());
    Ok(hex)
}

fn wait_until_ready(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr.into(), Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(POLL_EVERY);
    }
    Err(format!("sidecar did not bind :{port} within {READY_TIMEOUT:?}"))
}

/// Spawn the Node sidecar pointed at the bundled `sidecar/server.js`,
/// wait for it to bind, then navigate `window` to it.
pub fn launch(app: &AppHandle, window: WebviewWindow) -> Result<(), String> {
    let port = pick_port().map_err(|e| format!("pick_port: {e}"))?;

    // Resolve the staged Next standalone tree (`src-tauri/sidecar/`),
    // bundled as Tauri `resources`.
    let server_js = app
        .path()
        .resolve("sidecar/server.js", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve server.js: {e}"))?;

    log::info!("yen sidecar: spawning node on :{port}");

    let session_password = ensure_session_secret(app)?;

    let sidecar = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("sidecar(node): {e}"))?
        .args([server_js.to_string_lossy().to_string()])
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("SESSION_PASSWORD", session_password);

    let (mut rx, _child) = sidecar.spawn().map_err(|e| format!("spawn: {e}"))?;

    // Drain stdout/stderr in the background so the child doesn't block on
    // a full pipe, and so we get logs in the Tauri console.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) => log::info!(
                    "[next] {}",
                    String::from_utf8_lossy(&b).trim_end()
                ),
                CommandEvent::Stderr(b) => log::warn!(
                    "[next] {}",
                    String::from_utf8_lossy(&b).trim_end()
                ),
                CommandEvent::Terminated(payload) => {
                    log::error!("[next] terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    wait_until_ready(port)?;
    log::info!("yen sidecar: ready on :{port}, navigating webview");

    let url = format!("http://127.0.0.1:{port}/")
        .parse()
        .map_err(|e| format!("parse url: {e}"))?;
    window.navigate(url).map_err(|e| format!("navigate: {e}"))?;

    Ok(())
}
