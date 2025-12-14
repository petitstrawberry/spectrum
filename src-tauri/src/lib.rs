//! Spectrum - Prism Audio Mixer & Router
//!
//! v2 Architecture: Pure Sends-on-Fader Design
//!
//! This is the library entry point for Tauri.

// =============================================================================
// v2 Modules (New Architecture)
// =============================================================================

pub mod audio;      // AudioGraph, AudioNode, Edge, Meters
pub mod api;        // Tauri commands and DTOs
pub mod capture;    // Input audio capture
pub mod device;     // Device enumeration

// =============================================================================
// Legacy Modules (To be deprecated/refactored)
// =============================================================================

mod audio_capture;  // Legacy capture (wrapped by capture module)
mod audio_unit;     // AudioUnit plugin management
mod audio_unit_ui;  // AudioUnit UI
pub mod prismd;     // Prism daemon communication
mod vdsp;           // vDSP hardware acceleration

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

static DID_EXIT_FLUSH: AtomicBool = AtomicBool::new(false);

// Re-export prismd types
pub use prismd::{ClientInfo, ClientRoutingUpdate, RoutingUpdate};

// =============================================================================
// Legacy Types (For backward compatibility)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub channels: u32,
    pub is_input: bool,
    pub is_output: bool,
    pub device_type: String,
    pub input_channels: u32,
    pub output_channels: u32,
    pub transport_type: String,
    #[serde(default)]
    pub is_aggregate: bool,
    #[serde(default)]
    pub sub_devices: Vec<SubDeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubDeviceInfo {
    pub id: String,
    pub name: String,
    pub output_channels: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverStatus {
    pub connected: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelData {
    pub left_peak: f32,
    pub right_peak: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllLevels {
    pub input: Vec<LevelData>,
    pub output: HashMap<String, Vec<LevelData>>,
}

// =============================================================================
// Shared App State
// =============================================================================

/// Latest UI state snapshot from the frontend, stored in memory.
/// Used to persist once on app exit without writing on every UI change.
#[derive(Default)]
pub struct UiStateCache(pub Mutex<Option<api::dto::UIStateDto>>);

// =============================================================================
// v2 API Commands (New)
// =============================================================================

// Device Commands
pub use api::get_input_devices;
pub use api::get_output_devices;
pub use api::get_prism_status;

// Graph Commands
pub use api::add_source_node;
pub use api::add_bus_node;
pub use api::add_sink_node;
pub use api::remove_node;
pub use api::add_edge;
pub use api::remove_edge;
pub use api::get_graph;

// Edge Commands (Hot Path)
pub use api::set_edge_gain;
pub use api::set_edge_muted;
pub use api::set_edge_gains_batch;

// Plugin Commands
pub use api::get_available_plugins;
pub use api::add_plugin_to_bus;
pub use api::remove_plugin_from_bus;
pub use api::reorder_plugins;
pub use api::set_plugin_enabled;
pub use api::open_plugin_ui;
pub use api::close_plugin_ui;

// Meter Commands
pub use api::get_meters;
pub use api::get_node_meters;
pub use api::get_edge_meters;

// State Commands
pub use api::save_graph_state;
pub use api::load_graph_state;
pub use api::persist_state;
pub use api::persist_state_background;
pub use api::restore_state;
pub use api::set_ui_state_cache;

// System Commands
pub use api::start_audio;
pub use api::stop_audio;
pub use api::stop_output_runtime;
pub use api::get_system_status;
pub use api::open_prism_app;
pub use api::set_buffer_size;
pub use api::get_app_icon_by_pid;
// Output runtime
pub use api::get_output_runtime;
// Output master
pub use api::set_output_gain;
pub use api::set_output_channel_gain;

// =============================================================================
// Legacy Commands (For backward compatibility)
// =============================================================================

#[tauri::command]
async fn get_prism_clients() -> Result<Vec<ClientInfo>, String> {
    prismd::get_clients().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_routing(pid: i32, offset: u32) -> Result<RoutingUpdate, String> {
    prismd::set_routing(pid, offset)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_app_routing(app_name: String, offset: u32) -> Result<Vec<RoutingUpdate>, String> {
    prismd::set_app_routing(app_name, offset)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_client_routing(client_id: u32, offset: u32) -> Result<ClientRoutingUpdate, String> {
    prismd::set_client_routing(client_id, offset)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_driver_status() -> Result<DriverStatus, String> {
    let connected = prismd::is_connected() || capture::is_capture_running();

    Ok(DriverStatus {
        connected,
        sample_rate: 48000, // TODO: Get from config
        buffer_size: capture::get_io_buffer_size() as u32,
    })
}

#[tauri::command]
fn start_audio_capture() -> Result<bool, String> {
    capture::start_capture().map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_audio_capture() {
    capture::stop_capture();
}

#[tauri::command]
fn is_audio_capture_running() -> bool {
    capture::is_capture_running()
}

#[tauri::command]
fn is_prism_available() -> bool {
    capture::find_prism_device().is_some()
}

// Input device commands (using new capture module)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputDeviceInfo {
    pub device_id: u32,
    pub name: String,
    pub channels: u32,
    pub is_prism: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveCaptureInfo {
    pub device_id: u32,
    pub name: String,
    pub channel_count: usize,
    pub is_prism: bool,
}

#[tauri::command]
fn get_input_devices_legacy() -> Vec<InputDeviceInfo> {
    capture::get_input_devices()
        .into_iter()
        .map(|(id, name, channels, is_prism)| InputDeviceInfo {
            device_id: id,
            name,
            channels,
            is_prism,
        })
        .collect()
}

#[tauri::command]
fn start_input_capture(device_id: u32) -> Result<bool, String> {
    capture::start_input_capture(device_id)
}

#[tauri::command]
fn stop_input_capture(device_id: u32) {
    capture::stop_input_capture(device_id);
}

#[tauri::command]
fn get_active_captures() -> Vec<ActiveCaptureInfo> {
    capture::get_active_captures()
        .into_iter()
        .map(|(id, name, ch, is_prism)| ActiveCaptureInfo {
            device_id: id,
            name,
            channel_count: ch,
            is_prism,
        })
        .collect()
}

#[tauri::command]
fn is_device_capturing(device_id: u32) -> bool {
    capture::is_device_capturing(device_id)
}

// Buffer size commands

#[tauri::command]
fn set_io_buffer_size(size: u32) -> Result<(), String> {
    capture::set_io_buffer_size(size as usize);
    Ok(())
}

#[tauri::command]
fn get_io_buffer_size() -> u32 {
    capture::get_io_buffer_size() as u32
}

// Plugin commands (legacy wrappers)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub manufacturer: String,
    pub component_type: String,
}

#[tauri::command]
fn get_plugins() -> Vec<PluginInfo> {
    audio_unit::get_effect_audio_units()
        .into_iter()
        .map(|p| PluginInfo {
            id: p.id,
            name: p.name,
            manufacturer: p.manufacturer,
            component_type: p.plugin_type,
        })
        .collect()
}

// Prism process info

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrismProcess {
    pub pid: u32,
    pub name: String,
    pub channel_offset: u32,
}

#[tauri::command]
fn get_processes() -> Vec<PrismProcess> {
    prismd::get_processes()
        .into_iter()
        .map(|p| PrismProcess {
            pid: p.pid,
            name: p.name,
            channel_offset: p.channel_offset,
        })
        .collect()
}

// =============================================================================
// Tauri App Builder
// =============================================================================

/// Generate Tauri command handlers
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(UiStateCache::default())
        .setup(|_app| {
            // IMPORTANT: Do not block `setup` with CoreAudio init.
            // Blocking here delays first paint and results in a white window.
            println!("[Spectrum] Scheduling audio engine init...");

            tauri::async_runtime::spawn_blocking(|| {
                println!("[Spectrum] Initializing audio engine...");

                // Start capture first so the initial output can render actual audio.
                if let Err(e) = crate::capture::start_capture() {
                    eprintln!("[Spectrum] Warning: Failed to start capture on startup: {}", e);
                }

                // Find preferred output device (aggregate or system default)
                if let Some(device_id) = crate::device::find_preferred_output_device() {
                    match crate::audio::output::start_output_v2(device_id) {
                        Ok(_) => {
                            let channels = crate::device::get_device_output_channels(device_id);
                            println!("[Spectrum] Audio engine initialized successfully");
                            println!(
                                "[Spectrum] Using output device: {} ({} channels)",
                                device_id, channels
                            );
                        }
                        Err(e) => {
                            eprintln!("[Spectrum] Warning: Failed to initialize audio engine: {}", e);
                            eprintln!("[Spectrum] The app will start without audio output.");

                            // Best-effort cleanup if output fails.
                            crate::capture::stop_capture();
                        }
                    }
                } else {
                    eprintln!("[Spectrum] Warning: No suitable output device found");
                    eprintln!("[Spectrum] The app will start without audio output.");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // v2 API - Device
            get_input_devices,
            get_output_devices,
            get_prism_status,
            // v2 API - Graph
            add_source_node,
            add_bus_node,
            add_sink_node,
            remove_node,
            add_edge,
            remove_edge,
            get_graph,
            // v2 API - Edge
            set_edge_gain,
            set_edge_muted,
            set_edge_gains_batch,
            // v2 API - Plugin
            get_available_plugins,
            add_plugin_to_bus,
            remove_plugin_from_bus,
            reorder_plugins,
            set_plugin_enabled,
            open_plugin_ui,
            close_plugin_ui,
            // v2 API - Meter
            get_meters,
            get_node_meters,
            get_edge_meters,
            // v2 API - State
            save_graph_state,
            load_graph_state,
            persist_state,
            persist_state_background,
            restore_state,
            set_ui_state_cache,
            // v2 API - System
            start_audio,
            stop_audio,
            stop_output_runtime,
            get_system_status,
            open_prism_app,
            get_app_icon_by_pid,
            set_buffer_size,
            // v2 API - Output runtime
            get_output_runtime,
            // v2 API - Output master
            set_output_gain,
            set_output_channel_gain,
            // Legacy commands
            get_prism_clients,
            set_routing,
            set_app_routing,
            set_client_routing,
            get_driver_status,
            start_audio_capture,
            stop_audio_capture,
            is_audio_capture_running,
            is_prism_available,
            get_input_devices_legacy,
            start_input_capture,
            stop_input_capture,
            get_active_captures,
            is_device_capturing,
            set_io_buffer_size,
            get_io_buffer_size,
            get_plugins,
            get_processes,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Save state only when the app is exiting (Cmd+Q, Quit menu, etc.).
        // Do NOT save on window close.
        let should_flush = matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit { .. }
        );
        if !should_flush {
            return;
        }

        // Ensure we only flush once even if both events fire.
        if DID_EXIT_FLUSH.swap(true, Ordering::SeqCst) {
            return;
        }

        let ui_state = match app_handle.state::<UiStateCache>().0.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        };

        println!(
            "[Spectrum] Exit flush: ui_state_cached={}",
            if ui_state.is_some() { "yes" } else { "no" }
        );

        // Best-effort synchronous flush; runs during shutdown.
        let _ = tauri::async_runtime::block_on(async { crate::api::persist_state(ui_state).await });
    });
}
