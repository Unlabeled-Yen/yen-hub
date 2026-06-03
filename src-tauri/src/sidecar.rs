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

/// Per-startup token authenticating webview → sidecar requests. Generated
/// fresh on every launch, lives only in process memory (Rust + Node + the
/// webview's JS heap). The webview fetches it once via the
/// `get_sidecar_token` Tauri command; subsequent fetch() calls include it
/// as `X-Yen-Token`. Other local processes can't read another process's
/// env or memory on macOS without special entitlements, so this raises the
/// bar against casual "any localhost process pokes 127.0.0.1" attacks.
/// Parse `~/.config/yen-hub/env` into a `HashMap<String, String>`. Missing
/// file = empty map. Malformed lines are silently skipped — the file is
/// user-edited and we'd rather degrade than crash on a typo.
fn load_env_file() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let path = match dirs_home() {
        Some(home) => home.join(".config/yen-hub/env"),
        None => return map,
    };
    let content = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return map,
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim().to_string();
        let mut value = line[eq + 1..].trim().to_string();
        // Strip optional surrounding quotes so `KEY="value with spaces"` works.
        if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            value = value[1..value.len() - 1].to_string();
        }
        if !key.is_empty() {
            map.insert(key, value);
        }
    }
    map
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn mint_sidecar_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("read /dev/urandom: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Spawn the Node sidecar pointed at the bundled `sidecar/server.js`,
/// wait for it to bind, then navigate `window` to it. Returns the
/// per-startup sidecar token so the caller can store it in Tauri state
/// and serve it to the webview via the `get_sidecar_token` command.
pub fn launch(app: &AppHandle, window: WebviewWindow) -> Result<String, String> {
    let port = pick_port().map_err(|e| format!("pick_port: {e}"))?;

    // Resolve the staged Next standalone tree (`src-tauri/sidecar/`),
    // bundled as Tauri `resources`.
    let server_js = app
        .path()
        .resolve("sidecar/server.js", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve server.js: {e}"))?;

    log::info!("yen sidecar: spawning node on :{port}");

    let session_password = ensure_session_secret(app)?;
    let sidecar_token = mint_sidecar_token()?;

    // CRITICAL: store the token in Tauri state BEFORE we navigate the
    // webview. If we wait until launch() returns (in lib.rs), the React
    // app inside the webview can mount and fire API requests against the
    // sidecar before the token-from-URL has propagated — middleware then
    // 403s every initial fetch. Storing early closes the race window.
    if let Some(state) = app.try_state::<crate::SidecarToken>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = sidecar_token.clone();
        }
    }

    // Env keys for the sidecar can come from EITHER:
    //   1. The launching process env (`pnpm tauri:dev` inherits the shell —
    //      ~/.zshrc exports flow through).
    //   2. A config file at `~/.config/yen-hub/env`. Used when the .app is
    //      launched from Finder/Applications, where the shell rc files are
    //      NOT sourced and process env is sparse.
    //
    // File format: plain `KEY=VALUE` lines, `#` comments allowed, blank
    // lines ignored. Values are NOT shell-expanded — what you write is
    // what gets passed.
    let env_overrides = load_env_file();
    let env_get = |k: &str| -> String {
        if let Some(v) = env_overrides.get(k) {
            return v.clone();
        }
        std::env::var(k).unwrap_or_default()
    };

    let vault_path = {
        let v = env_get("YEN_VAULT_PATH");
        if v.is_empty() {
            "/Users/yen/Desktop/Yen/Yen_Vault".to_string()
        } else {
            v
        }
    };
    let anthropic_key = env_get("ANTHROPIC_API_KEY");
    let kimi_key = env_get("KIMI_API_KEY");
    let kimi_base_url = env_get("KIMI_BASE_URL");
    let duffy_provider = env_get("DUFFY_PROVIDER");
    let duffy_model = env_get("DUFFY_MODEL");
    let twelve_data_key = env_get("TWELVE_DATA_KEY");

    log::info!(
        "yen sidecar: env loaded from file ({} keys); td={}, kimi={}, anthropic={}, duffy={}",
        env_overrides.len(),
        if !twelve_data_key.is_empty() { "yes" } else { "no" },
        if !kimi_key.is_empty() { "yes" } else { "no" },
        if !anthropic_key.is_empty() { "yes" } else { "no" },
        if !duffy_provider.is_empty() { duffy_provider.as_str() } else { "none" },
    );

    let mut sidecar = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("sidecar(node): {e}"))?
        .args([server_js.to_string_lossy().to_string()])
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("SESSION_PASSWORD", session_password)
        .env("YEN_HUB_TOKEN", &sidecar_token)
        .env("YEN_VAULT_PATH", vault_path);

    if !anthropic_key.is_empty() {
        sidecar = sidecar.env("ANTHROPIC_API_KEY", anthropic_key);
    }
    if !kimi_key.is_empty() {
        sidecar = sidecar.env("KIMI_API_KEY", kimi_key);
    }
    if !kimi_base_url.is_empty() {
        sidecar = sidecar.env("KIMI_BASE_URL", kimi_base_url);
    }
    if !duffy_provider.is_empty() {
        sidecar = sidecar.env("DUFFY_PROVIDER", duffy_provider);
    }
    if !duffy_model.is_empty() {
        sidecar = sidecar.env("DUFFY_MODEL", duffy_model);
    }
    if !twelve_data_key.is_empty() {
        sidecar = sidecar.env("TWELVE_DATA_KEY", twelve_data_key);
    }

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

    // Token transport (2026-06-02 / Slice 6.5):
    //
    // Pass the per-startup sidecar token as a `?_yt=` query parameter on
    // the initial navigation. The client-side `sidecar-token.ts` module
    // reads `window.location.search` at module load, stashes the token
    // into a module-level cache + sessionStorage, then strips the query
    // via history.replaceState so it doesn't appear in subsequent
    // navigations or screenshots.
    //
    // The sessionStorage path is what survives Cmd+R reload (the URL no
    // longer has the query at that point).
    let url_str = format!("http://127.0.0.1:{port}/?_yt={sidecar_token}");
    let url = url_str
        .parse()
        .map_err(|e| format!("parse url: {e}"))?;
    window.navigate(url).map_err(|e| format!("navigate: {e}"))?;

    Ok(sidecar_token)
}
