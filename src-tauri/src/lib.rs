mod auth;
mod sidecar;

use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            // In production the webview boots into splash/index.html; spawn
            // the Node sidecar and re-navigate once it's ready. In dev,
            // tauri.conf.json's devUrl handles loading and we do nothing.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                if let Some(window) = app.get_webview_window("main") {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = sidecar::launch(&handle, window) {
                            log::error!("sidecar launch failed: {e}");
                            eprintln!("sidecar launch failed: {e}");
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![authenticate])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
