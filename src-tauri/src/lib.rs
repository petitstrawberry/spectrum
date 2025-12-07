//! Spectrum - Prism Audio Mixer & Router
//!
//! This is the library entry point for Tauri.

mod audio;
mod audio_capture;
mod audio_output;
mod audio_unit;
mod audio_unit_ui;
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
    pub transport_type: String,  // "builtin", "usb", "bluetooth", "hdmi", "displayport", "airplay", "thunderbolt", "pci", "virtual", "unknown"
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
/// Update a send connection (1ch unit)
#[tauri::command]
fn update_mixer_send(
    source_device: u32,
    source_channel: u32,
    target_device: String,
    target_channel: u32,
    level: f32,
    muted: bool,
) {
    router::update_send(source_device, source_channel, target_device, target_channel, level, muted);
}

/// Remove a send connection (1ch unit)
#[tauri::command]
fn remove_mixer_send(source_device: u32, source_channel: u32, target_device: String, target_channel: u32) {
    router::remove_send(source_device, source_channel, &target_device, target_channel);
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

// --- Bus Commands ---

/// Bus info for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusInfo {
    pub id: String,
    pub label: String,
    pub channels: u32,
    pub fader: f32,
    pub muted: bool,
}

/// Add a new bus
#[tauri::command]
fn add_bus(id: String, label: String, channels: u32) {
    let mixer_state = mixer::get_mixer_state();
    mixer_state.add_bus(id, label, channels);
}

/// Remove a bus
#[tauri::command]
fn remove_bus(bus_id: String) {
    let mixer_state = mixer::get_mixer_state();
    mixer_state.remove_bus(&bus_id);
}

/// Set bus fader level (0.0-1.0)
#[tauri::command]
fn set_bus_fader(bus_id: String, level: f32) {
    let mixer_state = mixer::get_mixer_state();
    mixer_state.set_bus_fader(&bus_id, level);
}

/// Set bus mute state
#[tauri::command]
fn set_bus_mute(bus_id: String, muted: bool) {
    let mixer_state = mixer::get_mixer_state();
    mixer_state.set_bus_mute(&bus_id, muted);
}

/// Get all buses
#[tauri::command]
fn get_buses() -> Vec<BusInfo> {
    let mixer_state = mixer::get_mixer_state();
    mixer_state.get_buses()
        .into_iter()
        .map(|b| BusInfo {
            id: b.id,
            label: b.label,
            channels: b.channels,
            fader: b.fader,
            muted: b.muted,
        })
        .collect()
}

/// Add or update a bus send (Input -> Bus, Bus -> Bus, or Bus -> Output)
/// source_type: "input" or "bus"
/// target_type: "bus" or "output"
#[tauri::command]
fn update_bus_send(
    source_type: String,
    source_id: String,
    source_device: u32,
    source_channel: u32,
    target_type: String,
    target_id: String,
    target_channel: u32,
    level: f32,
    muted: bool,
) {
    let src_type = match source_type.as_str() {
        "input" => mixer::BusSendSourceType::Input,
        "bus" => mixer::BusSendSourceType::Bus,
        _ => {
            println!("[Spectrum] Invalid source_type: {}", source_type);
            return;
        }
    };
    let tgt_type = match target_type.as_str() {
        "bus" => mixer::BusSendTargetType::Bus,
        "output" => mixer::BusSendTargetType::Output,
        _ => {
            println!("[Spectrum] Invalid target_type: {}", target_type);
            return;
        }
    };
    
    let send = mixer::BusSend {
        source_type: src_type,
        source_id,
        source_device,
        source_channel,
        target_type: tgt_type,
        target_id,
        target_channel,
        level,
        muted,
    };
    
    let mixer_state = mixer::get_mixer_state();
    mixer_state.set_bus_send(send);
}

/// Remove a bus send
#[tauri::command]
fn remove_bus_send(
    source_type: String,
    source_id: String,
    source_device: u32,
    source_channel: u32,
    target_type: String,
    target_id: String,
    target_channel: u32,
) {
    let src_type = match source_type.as_str() {
        "input" => mixer::BusSendSourceType::Input,
        "bus" => mixer::BusSendSourceType::Bus,
        _ => return,
    };
    let tgt_type = match target_type.as_str() {
        "bus" => mixer::BusSendTargetType::Bus,
        "output" => mixer::BusSendTargetType::Output,
        _ => return,
    };
    
    let mixer_state = mixer::get_mixer_state();
    mixer_state.remove_bus_send(
        src_type,
        &source_id,
        source_device,
        source_channel,
        tgt_type,
        &target_id,
        target_channel,
    );
}

// --- AudioUnit Commands ---

/// AudioUnit plugin info for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioUnitPluginInfo {
    pub id: String,
    pub name: String,
    pub manufacturer: String,
    pub plugin_type: String,
    pub sandbox_safe: bool,
}

/// Get all effect AudioUnits
#[tauri::command]
fn get_effect_audio_units() -> Vec<AudioUnitPluginInfo> {
    audio_unit::get_effect_audio_units()
        .into_iter()
        .map(|au| AudioUnitPluginInfo {
            id: au.id,
            name: au.name,
            manufacturer: au.manufacturer,
            plugin_type: au.plugin_type,
            sandbox_safe: au.sandbox_safe,
        })
        .collect()
}

/// Get all instrument AudioUnits
#[tauri::command]
fn get_instrument_audio_units() -> Vec<AudioUnitPluginInfo> {
    audio_unit::get_instrument_audio_units()
        .into_iter()
        .map(|au| AudioUnitPluginInfo {
            id: au.id,
            name: au.name,
            manufacturer: au.manufacturer,
            plugin_type: au.plugin_type,
            sandbox_safe: au.sandbox_safe,
        })
        .collect()
}

/// Create an AudioUnit instance
#[tauri::command]
fn create_audio_unit_instance(plugin_id: String) -> Result<String, String> {
    // Find the plugin info first
    let effects = audio_unit::get_effect_audio_units();
    let instruments = audio_unit::get_instrument_audio_units();
    
    let info = effects.iter()
        .chain(instruments.iter())
        .find(|au| au.id == plugin_id)
        .ok_or_else(|| format!("Plugin not found: {}", plugin_id))?;
    
    audio_unit::get_au_manager().create_instance(info)
}

/// Remove an AudioUnit instance
#[tauri::command]
fn remove_audio_unit_instance(instance_id: String) -> bool {
    audio_unit::get_au_manager().remove_instance(&instance_id)
}

/// Set AudioUnit instance enabled state
#[tauri::command]
fn set_audio_unit_enabled(instance_id: String, enabled: bool) -> bool {
    audio_unit::get_au_manager().set_enabled(&instance_id, enabled)
}

/// AudioUnit instance info for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioUnitInstanceInfo {
    pub instance_id: String,
    pub plugin_id: String,
    pub name: String,
    pub manufacturer: String,
    pub plugin_type: String,
    pub enabled: bool,
}

/// List all AudioUnit instances
#[tauri::command]
fn list_audio_unit_instances() -> Vec<AudioUnitInstanceInfo> {
    audio_unit::get_au_manager().list_instances()
        .into_iter()
        .map(|(id, info, enabled)| AudioUnitInstanceInfo {
            instance_id: id,
            plugin_id: info.id,
            name: info.name,
            manufacturer: info.manufacturer,
            plugin_type: info.plugin_type,
            enabled,
        })
        .collect()
}

/// Open AudioUnit plugin UI window
#[tauri::command]
fn open_audio_unit_ui(instance_id: String) -> Result<(), String> {
    let manager = audio_unit::get_au_manager();
    let instance = manager.get_instance(&instance_id)
        .ok_or_else(|| format!("AudioUnit instance not found: {}", instance_id))?;
    
    let instance = instance.read();
    let handle = instance.get_handle();
    let name = instance.info.name.clone();
    
    audio_unit_ui::open_audio_unit_ui(&instance_id, handle, &name)
}

/// Close AudioUnit plugin UI window
#[tauri::command]
fn close_audio_unit_ui(instance_id: String) {
    audio_unit_ui::close_audio_unit_ui(&instance_id);
}

/// Check if AudioUnit plugin UI window is open
#[tauri::command]
fn is_audio_unit_ui_open(instance_id: String) -> bool {
    audio_unit_ui::is_plugin_window_open(&instance_id)
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

/// Saved plugin data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPlugin {
    pub id: String,
    pub name: String,
    pub manufacturer: String,
    #[serde(rename = "type")]
    pub plugin_type: String,
    pub enabled: bool,
}

/// Saved node data (serializable version of frontend NodeData)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNode {
    pub id: String,
    pub library_id: String,
    pub node_type: String,
    pub label: String,
    pub sub_label: Option<String>,
    pub icon_name: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    pub volume: f64,
    pub muted: bool,
    pub channel_count: u32,
    pub channel_offset: Option<u32>,
    pub source_type: Option<String>,
    pub device_id: Option<u32>,
    pub device_name: Option<String>,
    pub channel_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<SavedPlugin>>,
}

/// Saved connection data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub from_node_id: String,
    pub from_channel: u32,
    pub to_node_id: String,
    pub to_channel: u32,
    pub send_level: f64,
    pub muted: bool,
    pub stereo_linked: Option<bool>,
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
    #[serde(default)]
    pub saved_nodes: Vec<SavedNode>,
    #[serde(default)]
    pub saved_connections: Vec<SavedConnection>,
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
        saved_nodes: cfg.saved_nodes.into_iter().map(|n| SavedNode {
            id: n.id,
            library_id: n.library_id,
            node_type: n.node_type,
            label: n.label,
            sub_label: n.sub_label,
            icon_name: n.icon_name,
            color: n.color,
            x: n.x,
            y: n.y,
            volume: n.volume,
            muted: n.muted,
            channel_count: n.channel_count,
            channel_offset: n.channel_offset,
            source_type: n.source_type,
            device_id: n.device_id,
            device_name: n.device_name,
            channel_mode: n.channel_mode,
            bus_id: n.bus_id,
            plugins: n.plugins.map(|ps| ps.into_iter().map(|p| SavedPlugin {
                id: p.id,
                name: p.name,
                manufacturer: p.manufacturer,
                plugin_type: p.plugin_type,
                enabled: p.enabled,
            }).collect()),
        }).collect(),
        saved_connections: cfg.saved_connections.into_iter().map(|c| SavedConnection {
            id: c.id,
            from_node_id: c.from_node_id,
            from_channel: c.from_channel,
            to_node_id: c.to_node_id,
            to_channel: c.to_channel,
            send_level: c.send_level,
            muted: c.muted,
            stereo_linked: c.stereo_linked,
        }).collect(),
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
        saved_nodes: state.saved_nodes.into_iter().map(|n| config::SavedNode {
            id: n.id,
            library_id: n.library_id,
            node_type: n.node_type,
            label: n.label,
            sub_label: n.sub_label,
            icon_name: n.icon_name,
            color: n.color,
            x: n.x,
            y: n.y,
            volume: n.volume,
            muted: n.muted,
            channel_count: n.channel_count,
            channel_offset: n.channel_offset,
            source_type: n.source_type,
            device_id: n.device_id,
            device_name: n.device_name,
            channel_mode: n.channel_mode,
            bus_id: n.bus_id,
            plugins: n.plugins.map(|ps| ps.into_iter().map(|p| config::SavedPlugin {
                id: p.id,
                name: p.name,
                manufacturer: p.manufacturer,
                plugin_type: p.plugin_type,
                enabled: p.enabled,
            }).collect()),
        }).collect(),
        saved_connections: state.saved_connections.into_iter().map(|c| config::SavedConnection {
            id: c.id,
            from_node_id: c.from_node_id,
            from_channel: c.from_channel,
            to_node_id: c.to_node_id,
            to_channel: c.to_channel,
            send_level: c.send_level,
            muted: c.muted,
            stereo_linked: c.stereo_linked,
        }).collect(),
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

/// Open Prism.app (companion app for channel assignment)
/// Uses URL scheme prism://popup for popup mode
#[tauri::command]
fn open_prism_app() -> Result<bool, String> {
    use std::process::Command;
    
    // First check if Prism.app is already running
    let output = Command::new("pgrep")
        .args(["-f", "Prism.app"])
        .output();
    
    if let Ok(out) = output {
        if !out.stdout.is_empty() {
            // Already running, send deep link to activate popup mode
            let result = Command::new("open")
                .arg("prism://popup?size=800x600")
                .spawn();
            
            if result.is_ok() {
                println!("[Spectrum] Prism.app already running, sent popup deep link");
                return Ok(true);
            }
            
            // Fallback: bring to front using AppleScript
            let _ = Command::new("osascript")
                .args(["-e", "tell application \"Prism\" to activate"])
                .spawn();
            println!("[Spectrum] Prism.app already running, activated");
            return Ok(true);
        }
    }
    
    // Try to open via URL scheme first (this registers/opens Prism.app)
    match Command::new("open")
        .arg("prism://popup?size=800x600")
        .spawn()
    {
        Ok(_) => {
            println!("[Spectrum] Opened Prism.app via URL scheme (popup mode)");
            return Ok(true);
        }
        Err(e) => {
            println!("[Spectrum] URL scheme failed: {}, trying fallback...", e);
        }
    }
    
    // Fallback: Try common locations for Prism.app
    let possible_paths = [
        "/Applications/Prism.app",
        "~/Applications/Prism.app",
        // Development build location
        "../prism-app/src-tauri/target/release/bundle/macos/Prism.app",
        "../prism-app/src-tauri/target/debug/bundle/macos/Prism.app",
    ];
    
    for path in &possible_paths {
        let expanded_path = shellexpand::tilde(path);
        if std::path::Path::new(expanded_path.as_ref()).exists() {
            match Command::new("open")
                .args(["-a", expanded_path.as_ref()])
                .spawn()
            {
                Ok(_) => {
                    println!("[Spectrum] Opened Prism.app from {}", expanded_path);
                    return Ok(true);
                }
                Err(e) => {
                    eprintln!("[Spectrum] Failed to open Prism.app: {}", e);
                }
            }
        }
    }
    
    // Fallback: try opening by name (if in PATH or registered)
    match Command::new("open")
        .args(["-a", "Prism"])
        .spawn()
    {
        Ok(_) => {
            println!("[Spectrum] Opened Prism.app by name");
            Ok(true)
        }
        Err(e) => {
            Err(format!("Could not find or open Prism.app: {}", e))
        }
    }
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
            // Bus commands
            add_bus,
            remove_bus,
            set_bus_fader,
            set_bus_mute,
            get_buses,
            update_bus_send,
            remove_bus_send,
            // AudioUnit commands
            get_effect_audio_units,
            get_instrument_audio_units,
            create_audio_unit_instance,
            remove_audio_unit_instance,
            set_audio_unit_enabled,
            list_audio_unit_instances,
            open_audio_unit_ui,
            close_audio_unit_ui,
            is_audio_unit_ui_open,
            // Config commands
            get_app_state,
            save_app_state,
            restart_app,
            open_prism_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
