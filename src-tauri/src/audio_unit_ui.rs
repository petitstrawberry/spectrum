//! AudioUnit UI Window
//!
//! This module delegates UI creation to Swift via FFI.
//! Replaces the previous pure Rust/ObjC implementation.

use std::ffi::{c_char, c_void, CString};
use objc2::runtime::AnyObject;

// FFI declarations matching the Swift exports
extern "C" {
    fn swift_open_audio_unit_ui(
        instance_id: *const c_char,
        au_ptr: *const c_void,
        is_v3: bool,
        plugin_name: *const c_char,
    ) -> i32;

    fn swift_close_audio_unit_ui(instance_id: *const c_char);

    fn swift_is_plugin_window_open(instance_id: *const c_char) -> bool;

    fn swift_close_all_plugin_windows();
}

/// Open a native window for an AudioUnit plugin's custom view
///
/// Delegates to Swift implementation.
/// Assumes `au_audio_unit` is an `AUAudioUnit` (V3) object pointer.
pub fn open_audio_unit_ui(
    instance_id: &str,
    au_audio_unit: *mut AnyObject,
    plugin_name: &str,
) -> Result<(), String> {
    let c_instance_id = CString::new(instance_id).map_err(|_| "Invalid instance ID")?;
    let c_plugin_name = CString::new(plugin_name).map_err(|_| "Invalid plugin name")?;

    // Since we are receiving *mut AnyObject, we assume it's an AUAudioUnit (V3).
    // If you need to support raw V2 AudioComponentInstance pointers,
    // you might need to change the signature or add a flag.
    let is_v3 = true;

    unsafe {
        let result = swift_open_audio_unit_ui(
            c_instance_id.as_ptr(),
            au_audio_unit as *const c_void,
            is_v3,
            c_plugin_name.as_ptr(),
        );

        if result == 0 {
            Ok(())
        } else {
            Err("Failed to open AudioUnit UI via Swift".to_string())
        }
    }
}

/// Close an AudioUnit UI window
pub fn close_audio_unit_ui(instance_id: &str) {
    let c_instance_id = match CString::new(instance_id) {
        Ok(s) => s,
        Err(_) => return,
    };

    unsafe {
        swift_close_audio_unit_ui(c_instance_id.as_ptr());
    }
}

/// Check if a plugin window is currently open
pub fn is_plugin_window_open(instance_id: &str) -> bool {
    let c_instance_id = match CString::new(instance_id) {
        Ok(s) => s,
        Err(_) => return false,
    };

    unsafe {
        swift_is_plugin_window_open(c_instance_id.as_ptr())
    }
}

/// Close all open plugin windows
pub fn close_all_plugin_windows() {
    unsafe {
        swift_close_all_plugin_windows();
    }
}

/// Clean up cached view controller when AudioUnit instance is removed
pub fn cleanup_cached_view_controller(instance_id: &str) {
    // Swift side manages lifecycle now, just ensure window is closed
    close_audio_unit_ui(instance_id);
}

/// Open plugin UI by instance_id only
///
/// This is a convenience wrapper that looks up the AudioUnit instance
/// and opens its UI. Must be called from main thread.
pub fn open_plugin_ui_by_instance_id(instance_id: &str) -> Result<(), String> {
    // Get the AudioUnit instance from manager
    let au_instance = crate::audio_unit::get_au_manager()
        .get_instance(instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {}", instance_id))?;

    // Get the AUAudioUnit pointer
    let au_audio_unit = au_instance
        .get_au_audio_unit()
        .ok_or_else(|| "AudioUnit not initialized".to_string())?;

    let plugin_name = au_instance.info.name.clone();

    // Open the UI
    open_audio_unit_ui(instance_id, au_audio_unit, &plugin_name)
}
