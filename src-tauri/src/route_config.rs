//! Route Configuration
//!
//! Single source of truth for audio routing configuration.
//! Converts UI routing settings to audio_graph::AudioGraph.
//!
//! ## Responsibilities
//! - Store routing configuration (sends, buses)
//! - Convert config to audio_graph::AudioGraph
//! - Provide Tauri commands for UI interaction
//!
//! ## This module does NOT:
//! - Process audio (that's audio_graph::GraphProcessor)
//! - Store buffers (that's audio_graph::GraphProcessor)
//! - Store meters (that's audio_graph::GraphMeters)

use crate::audio_graph::{self, AudioGraph, BusData, Edge, NodeId};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

// =============================================================================
// Constants
// =============================================================================

/// Maximum number of Prism channels (32 stereo pairs = 64 mono channels)
pub const PRISM_CHANNELS: usize = 64;

/// Maximum number of buses
pub const MAX_BUSES: usize = 32;

// =============================================================================
// Send Configuration Types
// =============================================================================

/// Source type for sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceType {
    /// Input device channel
    Input,
    /// Bus output
    Bus,
}

/// Target type for sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetType {
    /// Bus input
    Bus,
    /// Output device channel
    Output,
}

/// A single send connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendConfig {
    /// Unique ID for this send
    pub id: String,
    
    /// Source type
    pub source_type: SourceType,
    /// Source device ID (for Input type, 0 = Prism)
    pub source_device: u32,
    /// Source bus ID (for Bus type)
    pub source_bus_id: String,
    /// Source channel index (mono channel, 0-based)
    pub source_channel: u32,
    
    /// Target type
    pub target_type: TargetType,
    /// Target bus ID (for Bus type)
    pub target_bus_id: String,
    /// Target device ID string (for Output type)
    pub target_device: String,
    /// Target channel index (mono channel, 0-based)
    pub target_channel: u32,
    
    /// Send level (linear gain, 0.0 to 1.0+)
    pub level: f32,
    /// Muted
    pub muted: bool,
}

impl Default for SendConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            source_type: SourceType::Input,
            source_device: 0,
            source_bus_id: String::new(),
            source_channel: 0,
            target_type: TargetType::Output,
            target_bus_id: String::new(),
            target_device: String::new(),
            target_channel: 0,
            level: 1.0,
            muted: false,
        }
    }
}

/// Bus configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusConfig {
    /// Bus identifier (e.g., "bus_1")
    pub id: String,
    /// Display label
    pub label: String,
    /// Number of channels (typically 2 for stereo)
    pub channels: u32,
    /// Bus fader level (linear, 0.0 to 1.0)
    pub fader: f32,
    /// Muted
    pub muted: bool,
    /// Plugin chain (AudioUnit instance IDs)
    pub plugin_ids: Vec<String>,
}

impl Default for BusConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            channels: 2,
            fader: 1.0,
            muted: false,
            plugin_ids: Vec::new(),
        }
    }
}

// =============================================================================
// Route Configuration State
// =============================================================================

/// Main routing configuration state
pub struct RouteConfig {
    /// All send connections
    sends: RwLock<Vec<SendConfig>>,
    /// All bus configurations (indexed by position)
    buses: RwLock<Vec<BusConfig>>,
    /// Bus ID to index mapping
    bus_id_to_idx: RwLock<HashMap<String, usize>>,
    /// Output device faders (device_id -> linear gain)
    output_faders: RwLock<HashMap<String, f32>>,
    /// Version counter for change detection
    version: AtomicU64,
}

impl RouteConfig {
    pub fn new() -> Self {
        Self {
            sends: RwLock::new(Vec::new()),
            buses: RwLock::new(Vec::with_capacity(MAX_BUSES)),
            bus_id_to_idx: RwLock::new(HashMap::new()),
            output_faders: RwLock::new(HashMap::new()),
            version: AtomicU64::new(0),
        }
    }

    /// Get current version
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Increment version (call after any change)
    fn bump_version(&self) {
        self.version.fetch_add(1, Ordering::Release);
    }

    // =========================================================================
    // Send Operations
    // =========================================================================

    /// Add or update a send
    pub fn set_send(&self, send: SendConfig) {
        let mut sends = self.sends.write();
        
        // Find existing send by ID
        if let Some(existing) = sends.iter_mut().find(|s| s.id == send.id) {
            *existing = send;
        } else {
            sends.push(send);
        }
        drop(sends);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Remove a send by ID
    pub fn remove_send(&self, send_id: &str) {
        let mut sends = self.sends.write();
        sends.retain(|s| s.id != send_id);
        drop(sends);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Get all sends
    pub fn get_sends(&self) -> Vec<SendConfig> {
        self.sends.read().clone()
    }

    /// Clear all sends
    pub fn clear_sends(&self) {
        let mut sends = self.sends.write();
        sends.clear();
        drop(sends);
        
        self.bump_version();
        self.rebuild_graph();
    }

    // =========================================================================
    // Bus Operations
    // =========================================================================

    /// Add a bus
    pub fn add_bus(&self, bus: BusConfig) -> Option<usize> {
        if bus.id.is_empty() {
            return None;
        }

        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();

        // Check if already exists
        if id_map.contains_key(&bus.id) {
            // Update existing
            if let Some(&idx) = id_map.get(&bus.id) {
                if idx < buses.len() {
                    buses[idx] = bus;
                    drop(buses);
                    drop(id_map);
                    self.bump_version();
                    self.rebuild_graph();
                    return Some(idx);
                }
            }
            return None;
        }

        // Add new
        let idx = buses.len();
        if idx >= MAX_BUSES {
            return None;
        }

        id_map.insert(bus.id.clone(), idx);
        buses.push(bus);
        
        drop(buses);
        drop(id_map);
        
        self.bump_version();
        self.rebuild_graph();
        Some(idx)
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();
        let mut sends = self.sends.write();

        if let Some(&idx) = id_map.get(bus_id) {
            // Remove sends referencing this bus
            sends.retain(|s| {
                let source_ok = !(s.source_type == SourceType::Bus && s.source_bus_id == bus_id);
                let target_ok = !(s.target_type == TargetType::Bus && s.target_bus_id == bus_id);
                source_ok && target_ok
            });

            // Remove bus
            if idx < buses.len() {
                buses.remove(idx);
            }
            id_map.remove(bus_id);

            // Rebuild index map
            id_map.clear();
            for (i, bus) in buses.iter().enumerate() {
                id_map.insert(bus.id.clone(), i);
            }
        }

        drop(sends);
        drop(buses);
        drop(id_map);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Get bus by ID
    pub fn get_bus(&self, bus_id: &str) -> Option<BusConfig> {
        let buses = self.buses.read();
        let id_map = self.bus_id_to_idx.read();
        
        if let Some(&idx) = id_map.get(bus_id) {
            buses.get(idx).cloned()
        } else {
            None
        }
    }

    /// Get bus index by ID
    pub fn get_bus_index(&self, bus_id: &str) -> Option<usize> {
        self.bus_id_to_idx.read().get(bus_id).copied()
    }

    /// Get all buses
    pub fn get_buses(&self) -> Vec<BusConfig> {
        self.buses.read().clone()
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        let mut buses = self.buses.write();
        let id_map = self.bus_id_to_idx.read();
        
        if let Some(&idx) = id_map.get(bus_id) {
            if let Some(bus) = buses.get_mut(idx) {
                bus.fader = level.clamp(0.0, 2.0);
            }
        }
        
        drop(buses);
        drop(id_map);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        let mut buses = self.buses.write();
        let id_map = self.bus_id_to_idx.read();
        
        if let Some(&idx) = id_map.get(bus_id) {
            if let Some(bus) = buses.get_mut(idx) {
                bus.muted = muted;
            }
        }
        
        drop(buses);
        drop(id_map);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        let mut buses = self.buses.write();
        let id_map = self.bus_id_to_idx.read();
        
        if let Some(&idx) = id_map.get(bus_id) {
            if let Some(bus) = buses.get_mut(idx) {
                bus.plugin_ids = plugin_ids;
            }
        }
        
        drop(buses);
        drop(id_map);
        
        self.bump_version();
        self.rebuild_graph();
    }

    /// Get bus plugins
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        let buses = self.buses.read();
        let id_map = self.bus_id_to_idx.read();
        
        if let Some(&idx) = id_map.get(bus_id) {
            if let Some(bus) = buses.get(idx) {
                return bus.plugin_ids.clone();
            }
        }
        Vec::new()
    }

    /// Reserve a new bus ID
    pub fn reserve_bus_id(&self) -> String {
        let buses = self.buses.read();
        let next_num = buses.len() + 1;
        format!("bus_{}", next_num)
    }

    // =========================================================================
    // Output Fader Operations
    // =========================================================================

    /// Set output device fader (dB to linear conversion)
    pub fn set_output_fader(&self, device_id: &str, db: f32) {
        let gain = if db <= -100.0 {
            0.0
        } else {
            10.0_f32.powf(db / 20.0).clamp(0.0, 2.0)
        };
        
        self.output_faders.write().insert(device_id.to_string(), gain);
        self.bump_version();
        self.rebuild_graph();
    }

    /// Get output fader (linear gain)
    pub fn get_output_fader(&self, device_id: &str) -> f32 {
        self.output_faders.read().get(device_id).copied().unwrap_or(1.0)
    }

    // =========================================================================
    // Graph Building
    // =========================================================================

    /// Build AudioGraph from current configuration and update GraphManager
    pub fn rebuild_graph(&self) {
        let sends = self.sends.read();
        let buses = self.buses.read();
        let id_map = self.bus_id_to_idx.read();
        let output_faders = self.output_faders.read();

        let mut edges: Vec<Edge> = Vec::with_capacity(sends.len());

        // Process each send
        for send in sends.iter() {
            // Skip muted or zero-level sends
            if send.muted || send.level <= 0.0001 {
                continue;
            }

            // Build source NodeId
            let source = match send.source_type {
                SourceType::Input => {
                    let pair_idx = (send.source_channel / 2) as u8;
                    NodeId::input(send.source_device, pair_idx)
                }
                SourceType::Bus => {
                    if let Some(&bus_idx) = id_map.get(&send.source_bus_id) {
                        // Check if source bus is muted
                        if let Some(bus) = buses.get(bus_idx) {
                            if bus.muted {
                                continue;
                            }
                        }
                        NodeId::bus(bus_idx as u8)
                    } else {
                        continue; // Unknown bus
                    }
                }
            };

            // Build target NodeId
            let target = match send.target_type {
                TargetType::Bus => {
                    if let Some(&bus_idx) = id_map.get(&send.target_bus_id) {
                        NodeId::bus(bus_idx as u8)
                    } else {
                        continue; // Unknown bus
                    }
                }
                TargetType::Output => {
                    // Apply output fader
                    let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
                    if output_gain <= 0.0001 {
                        continue;
                    }
                    
                    let device_hash = audio_graph::hash_device_id(&send.target_device);
                    let pair_idx = (send.target_channel / 2) as u8;
                    NodeId::output(device_hash, pair_idx)
                }
            };

            // Calculate effective gain (send level only, no bus fader)
            let mut gain = send.level;

            // Apply output fader if target is output
            if send.target_type == TargetType::Output {
                let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
                gain *= output_gain;
            }

            // Create edge
            edges.push(Edge {
                source,
                target,
                gain,
                source_ch: (send.source_channel % 2) as u8,
                target_ch: (send.target_channel % 2) as u8,
                muted: false,
            });
        }

        // Build bus data
        let mut bus_data: HashMap<u8, BusData> = HashMap::new();
        for (idx, bus) in buses.iter().enumerate() {
            if !bus.id.is_empty() {
                bus_data.insert(idx as u8, BusData {
                    plugin_ids: bus.plugin_ids.clone(),
                });
            }
        }

        // Create AudioGraph and update manager
        let graph = AudioGraph::new(edges.clone(), bus_data.clone());
        audio_graph::get_graph_manager().update_graph(graph);
    }
}

impl Default for RouteConfig {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Global Instance
// =============================================================================

static ROUTE_CONFIG: std::sync::LazyLock<RouteConfig> =
    std::sync::LazyLock::new(RouteConfig::new);

/// Get the global route configuration
pub fn get_route_config() -> &'static RouteConfig {
    &ROUTE_CONFIG
}

// =============================================================================
// Legacy Compatibility Layer (for gradual migration)
// =============================================================================

/// Hash device ID string (re-export from audio_graph)
#[inline]
pub fn hash_device_id(device_id: &str) -> u64 {
    audio_graph::hash_device_id(device_id)
}
