mod auth;
mod sidecar;

use std::sync::Mutex;

use tauri::{Manager, RunEvent, State, WindowEvent};

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
            // macOS-standard window behaviour (2026-06-03):
            // - Cmd+W / red traffic-light = hide the window, keep app alive
            // - Cmd+Q = quit the app (handled below in RunEvent::ExitRequested)
            //
            // Without this, Tauri's default is to terminate the app when the
            // last window closes — which surprises macOS users.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        #[cfg(target_os = "macos")]
                        {
                            api.prevent_close();
                            let _ = w.hide();
                        }
                        // Other platforms keep default close-quits behaviour.
                        #[cfg(not(target_os = "macos"))]
                        let _ = (api, &w);
                    }
                });

                // Disable native macOS fullscreen entirely. The green
                // traffic-light button, the ⌃⌘F shortcut, and any
                // programmatic setFullscreen call all become no-ops.
                // Done because (a) native fullscreen moves the window
                // into its own Space which kills our `transparent:true`
                // (no desktop to show through), and (b) we suspect the
                // native-fullscreen transition is what triggers the
                // window-resize ghost residue this build has been
                // chasing. The user's ⌘⇧F max-in-place hotkey in
                // reload-hotkey.tsx remains the only "fullscreen" path,
                // and it stays a regular window so transparency works.
                //
                // NSWindowCollectionBehaviorFullScreenNone = 1 << 9.
                #[cfg(target_os = "macos")]
                {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;
                    if let Ok(ns_window) = window.ns_window() {
                        unsafe {
                            let obj = ns_window as *mut AnyObject;
                            let _: () = msg_send![
                                obj,
                                setCollectionBehavior: 1u64 << 9
                            ];
                        }
                    }
                }
            }

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
                                log::error!("yen sidecar launch failed: {e}");
                            }
                        }
                    });
                } else {
                    log::error!("yen sidecar: could not get main webview window");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![authenticate, get_sidecar_token])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // macOS dock click reopens hidden window.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
