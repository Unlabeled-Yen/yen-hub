mod auth;
mod sidecar;

use std::sync::Mutex;

use tauri::{Manager, State};

/// Per-startup token shared with the Node sidecar (passed via env
/// `YEN_HUB_TOKEN`). The webview fetches it via the `get_sidecar_token`
/// command and includes it as `X-Yen-Token` on /api requests. Empty until
/// the sidecar launch completes; the webview retries on empty.
#[derive(Default)]
pub struct SidecarToken(pub Mutex<String>);

/// Tauri command — native Touch ID prompt on macOS.
///
/// Called from React via `invoke<bool>('authenticate', { reason })`.
/// Returns `true` on success; throws (String) on any failure or cancel,
/// letting the React side stay silent (per silent-gate UX).
#[tauri::command]
async fn authenticate(reason: Option<String>) -> Result<bool, String> {
    let reason = reason.unwrap_or_else(|| "Unlock Yen".to_string());

    // The LAContext call blocks waiting for the system completion handler.
    // Run it off the async runtime so we don't stall the Tauri event loop.
    tauri::async_runtime::spawn_blocking(move || {
        auth::authenticate(&reason)
            .map(|_| true)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|join_err| format!("join error: {join_err}"))?
}

/// Tauri command — hand the webview the per-startup sidecar token.
///
/// Returns an empty string before `sidecar::launch()` has populated it; the
/// React-side helper polls until it's non-empty. In dev (`pnpm tauri dev`)
/// the sidecar is skipped and this returns the empty string, signalling
/// the middleware to bypass the token check.
#[tauri::command]
fn get_sidecar_token(token: State<'_, SidecarToken>) -> String {
    token.0.lock().map(|s| s.clone()).unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarToken::default())
        .setup(|app| {
            // In production the webview boots into splash/index.html; spawn
            // the Node sidecar and re-navigate once it's ready. In dev,
            // tauri.conf.json's devUrl handles loading and we do nothing.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                if let Some(window) = app.get_webview_window("main") {
                    tauri::async_runtime::spawn(async move {
                        match sidecar::launch(&handle, window) {
                            Ok(token) => {
                                if let Some(state) =
                                    handle.try_state::<SidecarToken>()
                                {
                                    if let Ok(mut guard) = state.0.lock() {
                                        *guard = token;
                                    }
                                }
                            }
                            Err(e) => {
                                log::error!("sidecar launch failed: {e}");
                                eprintln!("sidecar launch failed: {e}");
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![authenticate, get_sidecar_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
