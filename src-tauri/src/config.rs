//! Application Configuration
//! Handles saving and loading of app settings and routing state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// I/O Buffer size default
const DEFAULT_IO_BUFFER_SIZE: usize = 256;

/// Get config directory path
fn get_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("spectrum"))
}

/// Get config file path
fn get_config_path() -> Option<PathBuf> {
    get_config_dir().map(|p| p.join("config.json"))
}

/// Routing assignment for an output device
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OutputRouting {
    /// Device name (for matching on restart)
    pub device_name: String,
    /// Source channel assignments (left_ch, right_ch)
    pub sources: Vec<(usize, usize)>,
    /// Fader gains for each source
    pub fader_gains: Vec<f32>,
    /// Send gains for each source (send_index -> gain)
    pub send_gains: Vec<HashMap<usize, f32>>,
}

/// Send bus configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendConfig {
    /// Send label/name
    pub label: String,
}

/// Patch view position
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PatchViewState {
    /// Scroll position X
    pub scroll_x: f64,
    /// Scroll position Y  
    pub scroll_y: f64,
    /// Zoom level
    pub zoom: f64,
}

/// Master fader state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MasterState {
    /// Master fader gain (linear)
    pub gain: f32,
    /// Master mute state
    pub muted: bool,
}

impl Default for MasterState {
    fn default() -> Self {
        Self {
            gain: 1.0,
            muted: false,
        }
    }
}

/// Complete application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Config version (for future migrations)
    pub version: u32,
    /// I/O buffer size (CoreAudio)
    pub io_buffer_size: usize,
    /// Output routings by device name
    pub output_routings: HashMap<String, OutputRouting>,
    /// Send configurations
    pub sends: Vec<SendConfig>,
    /// Master fader state
    pub master: MasterState,
    /// Patch view state
    pub patch_view: PatchViewState,
    /// Last used output device names
    pub active_outputs: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            io_buffer_size: DEFAULT_IO_BUFFER_SIZE,
            output_routings: HashMap::new(),
            sends: vec![],
            master: MasterState::default(),
            patch_view: PatchViewState::default(),
            active_outputs: vec![],
        }
    }
}

impl AppConfig {
    /// Load configuration from disk
    pub fn load() -> Self {
        let path = match get_config_path() {
            Some(p) => p,
            None => {
                println!("[Config] Could not determine config path, using defaults");
                return Self::default();
            }
        };

        if !path.exists() {
            println!("[Config] No config file found, using defaults");
            return Self::default();
        }

        match fs::read_to_string(&path) {
            Ok(content) => {
                match serde_json::from_str::<AppConfig>(&content) {
                    Ok(config) => {
                        println!("[Config] Loaded configuration from {:?}", path);
                        config
                    }
                    Err(e) => {
                        eprintln!("[Config] Failed to parse config: {}", e);
                        Self::default()
                    }
                }
            }
            Err(e) => {
                eprintln!("[Config] Failed to read config: {}", e);
                Self::default()
            }
        }
    }

    /// Save configuration to disk
    pub fn save(&self) -> Result<(), String> {
        let dir = get_config_dir()
            .ok_or_else(|| "Could not determine config directory".to_string())?;
        
        let path = get_config_path()
            .ok_or_else(|| "Could not determine config path".to_string())?;

        // Create directory if needed
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        // Serialize and write
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        
        fs::write(&path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;

        println!("[Config] Saved configuration to {:?}", path);
        Ok(())
    }
}

// --- Global config state ---

use parking_lot::RwLock;
use std::sync::LazyLock;

static APP_CONFIG: LazyLock<RwLock<AppConfig>> = LazyLock::new(|| {
    RwLock::new(AppConfig::load())
});

/// Get I/O buffer size from saved config
pub fn get_saved_io_buffer_size() -> usize {
    APP_CONFIG.read().io_buffer_size
}

/// Save I/O buffer size
pub fn save_io_buffer_size(size: usize) -> Result<(), String> {
    let mut config = APP_CONFIG.write();
    config.io_buffer_size = size;
    config.save()
}

/// Get full config for frontend
pub fn get_config() -> AppConfig {
    APP_CONFIG.read().clone()
}

/// Update config from frontend
pub fn update_config(config: AppConfig) -> Result<(), String> {
    let mut current = APP_CONFIG.write();
    *current = config;
    current.save()
}

/// Save just the routing state
pub fn save_routing_state(
    output_routings: HashMap<String, OutputRouting>,
    active_outputs: Vec<String>,
) -> Result<(), String> {
    let mut config = APP_CONFIG.write();
    config.output_routings = output_routings;
    config.active_outputs = active_outputs;
    config.save()
}

/// Save master state
pub fn save_master_state(gain: f32, muted: bool) -> Result<(), String> {
    let mut config = APP_CONFIG.write();
    config.master = MasterState { gain, muted };
    config.save()
}

/// Save patch view state
pub fn save_patch_view_state(scroll_x: f64, scroll_y: f64, zoom: f64) -> Result<(), String> {
    let mut config = APP_CONFIG.write();
    config.patch_view = PatchViewState { scroll_x, scroll_y, zoom };
    config.save()
}
