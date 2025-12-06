//! Spectrum - Prism Audio Mixer & Router
//!
//! This is the library entry point for Tauri.

mod audio;
mod audio_capture;
mod audio_output;
mod config;
mod mixer;
mod prismd;
mod router;
mod vdsp;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Re-export prismd types
pub use prismd::{ClientInfo, RoutingUpdate, ClientRoutingUpdate};

// --- Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub channels: u32,
    pub is_input: bool,
    pub is_output: bool,
    pub device_type: String,  // "prism", "virtual", "builtin", "external"
    pub input_channels: u32,
    pub output_channels: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverStatus {
    pub connected: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
}

/// Level data for a stereo channel pair
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelData {
    pub left_rms: f32,
    pub right_rms: f32,
    pub left_peak: f32,
    pub right_peak: f32,
}

/// All levels response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllLevels {
    pub input: Vec<LevelData>,
    pub output: std::collections::HashMap<String, Vec<LevelData>>,
}

// --- Tauri Commands ---

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    audio::get_devices().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_prism_clients() -> Result<Vec<ClientInfo>, String> {
    prismd::get_clients().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_routing(pid: i32, offset: u32) -> Result<RoutingUpdate, String> {
    prismd::set_routing(pid, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_app_routing(app_name: String, offset: u32) -> Result<Vec<RoutingUpdate>, String> {
    prismd::set_app_routing(app_name, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_client_routing(client_id: u32, offset: u32) -> Result<ClientRoutingUpdate, String> {
    prismd::set_client_routing(client_id, offset).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_driver_status() -> Result<DriverStatus, String> {
    let connected = prismd::is_connected() || router::is_prism_available();
    let sample_rate = router::get_sample_rate();
    let buffer_size = router::get_buffer_size();

    Ok(DriverStatus {
        connected,
        sample_rate,
        buffer_size,
    })
}

#[tauri::command]
async fn get_audio_levels(device_id: String) -> Result<Vec<f32>, String> {
    audio::get_levels(&device_id).map_err(|e| e.to_string())
}

// --- Mixer/Router Commands ---

/// Get all input levels (32 stereo pairs from Prism)
#[tauri::command]
fn get_input_levels() -> Vec<LevelData> {
    // Use real audio capture if running, otherwise fallback to simulated
    if audio_capture::is_capture_running() {
        // Update mixer state from real capture data
        audio_capture::update_mixer_levels();

        // Get real captured levels
        audio_capture::get_capture_levels()
            .into_iter()
            .map(|l| LevelData {
                left_rms: l.left_rms,
                right_rms: l.right_rms,
                left_peak: l.left_peak,
                right_peak: l.right_peak,
            })
            .collect()
    } else {
        // Fallback to simulated levels for testing without Prism device
        router::simulate_levels();

        let mixer_state = mixer::get_mixer_state();
        let levels = mixer_state.get_input_levels();

        levels.iter()
            .map(|l| LevelData {
                left_rms: l.left_rms,
                right_rms: l.right_rms,
                left_peak: l.left_peak,
                right_peak: l.right_peak,
            })
            .collect()
    }
}

/// Get output levels for a specific device
#[tauri::command]
fn get_output_device_levels(device_id: String) -> Vec<LevelData> {
    router::get_output_levels(&device_id)
        .into_iter()
        .map(|(left_rms, right_rms, left_peak, right_peak)| LevelData {
            left_rms,
            right_rms,
            left_peak,
            right_peak,
        })
        .collect()
}

/// Update a send connection
#[tauri::command]
fn update_mixer_send(
    source_offset: u32,
    target_device: String,
    target_pair: u32,
    level: f32,
    muted: bool,
) {
    router::update_send(source_offset, target_device, target_pair, level, muted);
}

/// Remove a send connection
#[tauri::command]
fn remove_mixer_send(source_offset: u32, target_device: String, target_pair: u32) {
    router::remove_send(source_offset, &target_device, target_pair);
}

/// Set source channel fader (0-100)
#[tauri::command]
fn set_source_volume(pair_index: u32, level: f32) {
    router::set_source_fader(pair_index as usize, level);
}

/// Set source channel mute
#[tauri::command]
fn set_source_mute(pair_index: u32, muted: bool) {
    router::set_source_mute(pair_index as usize, muted);
}

/// Set output device master fader (dB value: -inf to +6)
#[tauri::command]
fn set_output_volume(device_id: String, level: f32) {
    router::set_output_fader(&device_id, level);
}

/// Check if Prism device is available
#[tauri::command]
fn is_prism_available() -> bool {
    router::is_prism_available()
}

/// Start audio capture from Prism device
#[tauri::command]
fn start_audio_capture() -> Result<bool, String> {
    audio_capture::start_capture().map_err(|e| e.to_string())
}

/// Stop audio capture
#[tauri::command]
fn stop_audio_capture() {
    audio_capture::stop_capture();
}

/// Check if audio capture is running
#[tauri::command]
fn is_audio_capture_running() -> bool {
    audio_capture::is_capture_running()
}

// --- Generic Input Device Capture Commands ---

/// Input device info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputDeviceInfo {
    pub device_id: u32,
    pub name: String,
    pub channels: u32,
    pub is_prism: bool,
}

/// Active capture info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveCaptureInfo {
    pub device_id: u32,
    pub name: String,
    pub channel_count: usize,
    pub is_prism: bool,
}

/// Get list of available input devices
#[tauri::command]
fn get_input_devices() -> Vec<InputDeviceInfo> {
    audio_capture::get_input_devices()
        .into_iter()
        .map(|(id, name, channels, is_prism)| InputDeviceInfo {
            device_id: id,
            name,
            channels,
            is_prism,
        })
        .collect()
}

/// Start capture from a specific input device
#[tauri::command]
fn start_input_capture(device_id: u32) -> Result<bool, String> {
    audio_capture::start_input_capture(device_id)
}

/// Stop capture from a specific input device
#[tauri::command]
fn stop_input_capture(device_id: u32) {
    audio_capture::stop_input_capture(device_id);
}

/// Stop all input captures
#[tauri::command]
fn stop_all_input_captures() {
    audio_capture::stop_all_captures();
}

/// Get list of active input captures
#[tauri::command]
fn get_active_input_captures() -> Vec<ActiveCaptureInfo> {
    audio_capture::get_active_captures()
        .into_iter()
        .map(|(device_id, name, channel_count, is_prism)| ActiveCaptureInfo {
            device_id,
            name,
            channel_count,
            is_prism,
        })
        .collect()
}

/// Check if a specific input device is being captured
#[tauri::command]
fn is_input_device_capturing(device_id: u32) -> bool {
    audio_capture::is_device_capturing(device_id)
}

/// Get levels for a specific input device
#[tauri::command]
fn get_input_device_levels(device_id: u32) -> Vec<LevelData> {
    audio_capture::get_input_device_levels(device_id)
        .into_iter()
        .map(|l| LevelData {
            left_rms: l.left_rms,
            right_rms: l.right_rms,
            left_peak: l.left_peak,
            right_peak: l.right_peak,
        })
        .collect()
}

/// Start audio output to a device
#[tauri::command]
fn start_audio_output(device_id: u32) -> Result<(), String> {
    audio_output::start_output(device_id)
}

/// Stop audio output to a device
#[tauri::command]
fn stop_audio_output(device_id: u32) {
    audio_output::stop_output(device_id);
}

/// Find output device by name
#[tauri::command]
fn find_output_device(name: String) -> Option<u32> {
    audio_output::find_output_device(&name)
}

/// Start output to default audio device
#[tauri::command]
fn start_default_output() -> Result<(), String> {
    audio_output::start_default_output()
}

/// Get current I/O buffer size setting
#[tauri::command]
fn get_buffer_size() -> usize {
    audio_capture::get_io_buffer_size()
}

/// Set CoreAudio I/O buffer size (saved for next app start)
/// This directly affects latency - lower values = less latency but more CPU
/// Note: Changes take effect after application restart
#[tauri::command]
async fn set_buffer_size(size: usize) -> Result<(), String> {
    // Validate buffer size (must be power of 2, between 32 and 2048)
    if size < 32 || size > 2048 {
        return Err("Buffer size must be between 32 and 2048".to_string());
    }
    if !size.is_power_of_two() {
        return Err("Buffer size must be a power of 2".to_string());
    }

    // Save to config file (will be loaded on next start)
    config::save_io_buffer_size(size)?;

    // Set for current session (though restart is required)
    audio_capture::set_io_buffer_size(size);

    println!("[Spectrum] I/O buffer size set to {} samples ({:.1}ms) - will apply on restart",
             size, size as f64 / 48.0);
    Ok(())
}

// --- Config Commands ---

/// Output routing info for saving
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputRoutingInfo {
    pub device_name: String,
    pub sources: Vec<(usize, usize)>,
    pub fader_gains: Vec<f32>,
    pub send_gains: Vec<HashMap<usize, f32>>,
}

/// App state for save/restore
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub io_buffer_size: usize,
    pub output_routings: HashMap<String, OutputRoutingInfo>,
    pub active_outputs: Vec<String>,
    pub master_gain: f32,
    pub master_muted: bool,
    pub patch_scroll_x: f64,
    pub patch_scroll_y: f64,
    pub patch_zoom: f64,
}

/// Get saved app state
#[tauri::command]
fn get_app_state() -> AppState {
    let cfg = config::get_config();
    AppState {
        io_buffer_size: cfg.io_buffer_size,
        output_routings: cfg.output_routings.into_iter().map(|(k, v)| {
            (k, OutputRoutingInfo {
                device_name: v.device_name,
                sources: v.sources,
                fader_gains: v.fader_gains,
                send_gains: v.send_gains,
            })
        }).collect(),
        active_outputs: cfg.active_outputs,
        master_gain: cfg.master.gain,
        master_muted: cfg.master.muted,
        patch_scroll_x: cfg.patch_view.scroll_x,
        patch_scroll_y: cfg.patch_view.scroll_y,
        patch_zoom: cfg.patch_view.zoom,
    }
}

/// Save app state
#[tauri::command]
async fn save_app_state(state: AppState) -> Result<(), String> {
    let cfg = config::AppConfig {
        version: 1,
        io_buffer_size: state.io_buffer_size,
        output_routings: state.output_routings.into_iter().map(|(k, v)| {
            (k, config::OutputRouting {
                device_name: v.device_name,
                sources: v.sources,
                fader_gains: v.fader_gains,
                send_gains: v.send_gains,
            })
        }).collect(),
        sends: vec![],
        master: config::MasterState {
            gain: state.master_gain,
            muted: state.master_muted,
        },
        patch_view: config::PatchViewState {
            scroll_x: state.patch_scroll_x,
            scroll_y: state.patch_scroll_y,
            zoom: state.patch_zoom,
        },
        active_outputs: state.active_outputs,
    };
    config::update_config(cfg)?;
    println!("[Spectrum] App state saved");
    Ok(())
}

/// Restart the application
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    println!("[Spectrum] Restarting application...");
    app.restart();
}

// --- Plugin Entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Load saved I/O buffer size from config
            let saved_buffer_size = config::get_saved_io_buffer_size();
            audio_capture::set_io_buffer_size(saved_buffer_size);
            println!("[Spectrum] Loaded I/O buffer size from config: {} samples", saved_buffer_size);

            // Try to start audio capture on app launch
            match audio_capture::start_capture() {
                Ok(true) => {
                    println!("[Spectrum] Audio capture started from Prism device");

                    // Also start output to default device for routing
                    if let Err(e) = audio_output::start_default_output() {
                        eprintln!("[Spectrum] Failed to start default output: {}", e);
                    } else {
                        println!("[Spectrum] Default audio output started");
                    }
                }
                Ok(false) => {
                    println!("[Spectrum] No Prism device found, using simulated levels");
                }
                Err(e) => {
                    eprintln!("[Spectrum] Failed to start audio capture: {}", e);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_audio_devices,
            get_prism_clients,
            set_routing,
            set_app_routing,
            set_client_routing,
            get_driver_status,
            get_audio_levels,
            // Mixer/Router commands
            get_input_levels,
            get_output_device_levels,
            update_mixer_send,
            remove_mixer_send,
            set_source_volume,
            set_source_mute,
            set_output_volume,
            is_prism_available,
            // Audio capture commands (legacy Prism)
            start_audio_capture,
            stop_audio_capture,
            is_audio_capture_running,
            // Generic input device capture commands
            get_input_devices,
            start_input_capture,
            stop_input_capture,
            stop_all_input_captures,
            get_active_input_captures,
            is_input_device_capturing,
            get_input_device_levels,
            // Audio output commands
            start_audio_output,
            stop_audio_output,
            find_output_device,
            start_default_output,
            get_buffer_size,
            set_buffer_size,
            // Config commands
            get_app_state,
            save_app_state,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
