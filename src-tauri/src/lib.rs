//! Spectrum - Prism Audio Mixer & Router
//!
//! This is the library entry point for Tauri.

mod audio;
mod prismd;

use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverStatus {
    pub connected: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
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
    Ok(DriverStatus {
        connected: prismd::is_connected(),
        sample_rate: 48000,
        buffer_size: 128,
    })
}

#[tauri::command]
async fn get_audio_levels(device_id: String) -> Result<Vec<f32>, String> {
    audio::get_levels(&device_id).map_err(|e| e.to_string())
}

// --- Plugin Entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_audio_devices,
            get_prism_clients,
            set_routing,
            set_app_routing,
            set_client_routing,
            get_driver_status,
            get_audio_levels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
