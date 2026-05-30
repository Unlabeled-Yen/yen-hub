mod auth;

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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![authenticate])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
