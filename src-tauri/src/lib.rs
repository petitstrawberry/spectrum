//! Spectrum - Prism Audio Mixer & Router
//!
//! This is the library entry point for Tauri.

mod audio;
mod prismd;

use serde::{Deserialize, Serialize};
use tauri::Manager;

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
pub struct PrismClient {
    pub pid: u32,
    pub client_id: u32,
    pub channel_offset: u32,
    pub process_name: Option<String>,
    pub responsible_pid: Option<u32>,
    pub responsible_name: Option<String>,
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
async fn get_prism_clients() -> Result<Vec<PrismClient>, String> {
    prismd::get_clients().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_driver_status() -> Result<DriverStatus, String> {
    // TODO: Implement actual driver status check
    Ok(DriverStatus {
        connected: true,
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
            get_driver_status,
            get_audio_levels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
