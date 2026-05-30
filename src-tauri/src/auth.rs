//! Native macOS Touch ID via LocalAuthentication.framework.
//!
//! On macOS, presents only the native Touch Bar / sensor prompt — no
//! fullscreen system modal (which is the gap that drove ADR 0001).
//!
//! On other platforms, [`authenticate`] is unavailable and the Tauri
//! command surfaces a clear error so the React side can fall back.
//!
//! API surface from the React side:
//!   `invoke<bool>('authenticate', { reason: string })`
//!   -> `true` on success, throws on failure / unavailable.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("biometrics unavailable: {0}")]
    Unavailable(String),
    #[error("authentication failed: {0}")]
    Failed(String),
    #[error("internal channel closed before completion")]
    InternalChannel,
    #[error("not supported on this platform")]
    Unsupported,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::AuthError;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;

    /// Blocking — runs the LAContext call and waits for the system
    /// completion handler. Callers MUST run this off the main thread
    /// (Tauri command uses `tauri::async_runtime::spawn_blocking`).
    pub fn authenticate(reason: &str) -> Result<(), AuthError> {
        // SAFETY: LAContext::new returns a freshly-allocated context owned by
        // the caller; no aliasing concerns.
        let context: Retained<LAContext> = unsafe { LAContext::new() };

        // SAFETY: canEvaluatePolicy_error is safe to call on a valid
        // LAContext. Returns Result on the binding side.
        unsafe {
            context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .map_err(|e| AuthError::Unavailable(describe_error(&e)))?;
        }

        let reason_ns = NSString::from_str(reason);
        let (tx, rx) = mpsc::channel::<Result<(), AuthError>>();

        // The reply block is invoked by the system on an internal thread
        // after the user interacts with the Touch ID sensor (success,
        // failure, or cancel). We forward the outcome through a channel.
        //
        // SAFETY: The block is moved into the Objective-C runtime via
        // `evaluatePolicy_localizedReason_reply`. The closure only touches
        // `tx` (Send) and reads ObjC values via the supplied raw pointer
        // following standard ObjC nullability rules (error may be null).
        let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
            if success.as_bool() {
                let _ = tx.send(Ok(()));
                return;
            }
            let msg = if error.is_null() {
                "user cancelled or denied".to_string()
            } else {
                // SAFETY: reply contract gives us a borrowed NSError owned
                // by the runtime for the duration of this callback.
                unsafe { describe_error_raw(error) }
            };
            let _ = tx.send(Err(AuthError::Failed(msg)));
        });

        // SAFETY: evaluatePolicy_localizedReason_reply is the standard ObjC
        // call. We hand it a valid policy, a borrowed NSString, and a block
        // whose lifetime exceeds this call (RcBlock keeps a refcount).
        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &reason_ns,
                &reply,
            );
        }

        // Block this worker thread until the system reply arrives. Tauri's
        // spawn_blocking runs us off the main thread so this is safe.
        rx.recv().unwrap_or(Err(AuthError::InternalChannel))
    }

    fn describe_error(err: &NSError) -> String {
        err.localizedDescription().to_string()
    }

    /// SAFETY: caller must ensure `err` points to a live NSError owned by
    /// the calling runtime context (true inside the reply block).
    unsafe fn describe_error_raw(err: *mut NSError) -> String {
        let r: &NSError = &*err;
        r.localizedDescription().to_string()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::AuthError;
    pub fn authenticate(_reason: &str) -> Result<(), AuthError> {
        Err(AuthError::Unsupported)
    }
}

/// Public entry point — platform routes to the right `imp::authenticate`.
pub fn authenticate(reason: &str) -> Result<(), AuthError> {
    imp::authenticate(reason)
}
