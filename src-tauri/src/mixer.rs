//! Audio Mixer State
//!
//! Legacy compatibility layer for existing UI code.
//! Delegates to route_config.rs and audio_graph.rs.
//!
//! ## Migration Status
//! This module is being phased out. New code should use:
//! - route_config.rs for routing configuration
//! - audio_graph.rs for audio processing and metering

use crate::audio_graph::{self, ChannelLevels as GraphChannelLevels, BusLevels as GraphBusLevels};
use crate::route_config::{self, SendConfig, BusConfig, SourceType, TargetType};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// =============================================================================
// Constants (re-export for compatibility)
// =============================================================================

pub const PRISM_CHANNELS: usize = route_config::PRISM_CHANNELS;
pub const MAX_BUSES: usize = route_config::MAX_BUSES;
pub const MAX_FRAMES: usize = audio_graph::MAX_FRAMES;

// =============================================================================
// Legacy Types (for UI compatibility)
// =============================================================================

/// Legacy send type (for UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Send {
    pub source_device: u32,
    pub source_channel: u32,
    pub target_device: String,
    pub target_channel: u32,
    pub level: f32,
    pub muted: bool,
}

impl Send {
    /// Convert to SendConfig
    pub fn to_config(&self) -> SendConfig {
        let id = format!("send_{}_{}_{}_{}", 
            self.source_device, 
            self.source_channel,
            route_config::hash_device_id(&self.target_device),
            self.target_channel
        );
        SendConfig {
            id,
            source_type: SourceType::Input,
            source_device: self.source_device,
            source_bus_id: String::new(),
            source_channel: self.source_channel,
            target_type: TargetType::Output,
            target_bus_id: String::new(),
            target_device: self.target_device.clone(),
            target_channel: self.target_channel,
            level: self.level,
            muted: self.muted,
        }
    }
}

/// Legacy bus send source type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendSourceType {
    Input,
    Bus,
}

/// Legacy bus send target type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendTargetType {
    Bus,
    Output,
}

/// Legacy bus send type (for UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusSend {
    pub source_type: BusSendSourceType,
    pub source_id: String,
    pub source_device: u32,
    pub source_channel: u32,
    pub target_type: BusSendTargetType,
    pub target_id: String,
    pub target_channel: u32,
    pub level: f32,
    pub muted: bool,
}

impl BusSend {
    /// Convert to SendConfig
    pub fn to_config(&self) -> SendConfig {
        let id = format!("bus_send_{:?}_{}_{}_{:?}_{}_{}",
            self.source_type, self.source_id, self.source_channel,
            self.target_type, self.target_id, self.target_channel
        );
        
        let (source_type, source_bus_id) = match self.source_type {
            BusSendSourceType::Input => (SourceType::Input, String::new()),
            BusSendSourceType::Bus => (SourceType::Bus, self.source_id.clone()),
        };
        
        let (target_type, target_bus_id, target_device) = match self.target_type {
            BusSendTargetType::Bus => (TargetType::Bus, self.target_id.clone(), String::new()),
            BusSendTargetType::Output => (TargetType::Output, String::new(), self.target_id.clone()),
        };
        
        SendConfig {
            id,
            source_type,
            source_device: self.source_device,
            source_bus_id,
            source_channel: self.source_channel,
            target_type,
            target_bus_id,
            target_device,
            target_channel: self.target_channel,
            level: self.level,
            muted: self.muted,
        }
    }
}

/// Legacy bus type (for UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bus {
    pub id: String,
    pub label: String,
    pub channels: u32,
    pub fader: f32,
    pub muted: bool,
    #[serde(default)]
    pub plugin_ids: Vec<String>,
}

impl Default for Bus {
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

impl Bus {
    /// Convert to BusConfig
    pub fn to_config(&self) -> BusConfig {
        BusConfig {
            id: self.id.clone(),
            label: self.label.clone(),
            channels: self.channels,
            fader: self.fader,
            muted: self.muted,
            plugin_ids: self.plugin_ids.clone(),
        }
    }

    /// Convert from BusConfig
    pub fn from_config(config: &BusConfig) -> Self {
        Self {
            id: config.id.clone(),
            label: config.label.clone(),
            channels: config.channels,
            fader: config.fader,
            muted: config.muted,
            plugin_ids: config.plugin_ids.clone(),
        }
    }
}

/// Level meters for a channel pair
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ChannelLevels {
    pub left_peak: f32,
    pub right_peak: f32,
}

impl From<GraphChannelLevels> for ChannelLevels {
    fn from(g: GraphChannelLevels) -> Self {
        Self {
            left_peak: g.left_peak,
            right_peak: g.right_peak,
        }
    }
}

/// Bus level meters
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct BusLevels {
    pub pre_left_peak: f32,
    pub pre_right_peak: f32,
    pub post_left_peak: f32,
    pub post_right_peak: f32,
}

impl From<GraphBusLevels> for BusLevels {
    fn from(g: GraphBusLevels) -> Self {
        Self {
            pre_left_peak: g.left_peak,
            pre_right_peak: g.right_peak,
            post_left_peak: g.left_peak,
            post_right_peak: g.right_peak,
        }
    }
}

/// Per-send level information
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct BusSendLevel {
    pub target: audio_graph::NodeId,
    pub target_ch: u8,
    pub post_left_peak: f32,
    pub post_right_peak: f32,
    pub send_level: f32,
    pub send_level_db: f32,
}

// =============================================================================
// Legacy Mixer State (Facade over route_config)
// =============================================================================

/// Global mixer state - facade over route_config
pub struct MixerState {
    /// Input levels (updated by audio_capture)
    pub input_levels: RwLock<[ChannelLevels; PRISM_CHANNELS / 2]>,
    /// Output levels (updated by audio_output)
    pub output_levels: RwLock<HashMap<String, Vec<ChannelLevels>>>,
    /// Sample rate
    pub sample_rate: RwLock<u32>,
    /// Buffer size
    pub buffer_size: RwLock<u32>,
}

impl Default for MixerState {
    fn default() -> Self {
        Self::new()
    }
}

impl MixerState {
    pub fn new() -> Self {
        Self {
            input_levels: RwLock::new([ChannelLevels::default(); PRISM_CHANNELS / 2]),
            output_levels: RwLock::new(HashMap::new()),
            sample_rate: RwLock::new(48000),
            buffer_size: RwLock::new(128),
        }
    }

    // =========================================================================
    // Send Operations (delegates to route_config)
    // =========================================================================

    /// Add or update a send
    pub fn set_send(&self, send: Send) {
        route_config::get_route_config().set_send(send.to_config());
    }

    /// Remove a send
    pub fn remove_send(&self, source_device: u32, source_channel: u32, target_device: &str, target_channel: u32) {
        let id = format!("send_{}_{}_{}_{}", 
            source_device, 
            source_channel,
            route_config::hash_device_id(target_device),
            target_channel
        );
        route_config::get_route_config().remove_send(&id);
    }

    /// Clear all sends
    pub fn clear_all_sends(&self) {
        route_config::get_route_config().clear_sends();
    }

    /// Get all sends (legacy format)
    pub fn get_sends(&self) -> Vec<Send> {
        route_config::get_route_config()
            .get_sends()
            .iter()
            .filter(|s| s.source_type == SourceType::Input && s.target_type == TargetType::Output)
            .map(|s| Send {
                source_device: s.source_device,
                source_channel: s.source_channel,
                target_device: s.target_device.clone(),
                target_channel: s.target_channel,
                level: s.level,
                muted: s.muted,
            })
            .collect()
    }

    /// Get all bus sends (legacy format)
    pub fn get_bus_sends(&self) -> Vec<BusSend> {
        route_config::get_route_config()
            .get_sends()
            .iter()
            .filter(|s| s.source_type == SourceType::Bus || s.target_type == TargetType::Bus)
            .map(|s| BusSend {
                source_type: match s.source_type {
                    SourceType::Input => BusSendSourceType::Input,
                    SourceType::Bus => BusSendSourceType::Bus,
                },
                source_id: if s.source_type == SourceType::Bus { 
                    s.source_bus_id.clone() 
                } else { 
                    String::new() 
                },
                source_device: s.source_device,
                source_channel: s.source_channel,
                target_type: match s.target_type {
                    TargetType::Bus => BusSendTargetType::Bus,
                    TargetType::Output => BusSendTargetType::Output,
                },
                target_id: if s.target_type == TargetType::Bus {
                    s.target_bus_id.clone()
                } else {
                    s.target_device.clone()
                },
                target_channel: s.target_channel,
                level: s.level,
                muted: s.muted,
            })
            .collect()
    }

    // =========================================================================
    // Bus Send Operations (delegates to route_config)
    // =========================================================================

    /// Add or update a bus send
    pub fn set_bus_send(&self, send: BusSend) {
        route_config::get_route_config().set_send(send.to_config());
    }

    /// Remove a bus send
    pub fn remove_bus_send(
        &self,
        source_type: BusSendSourceType,
        source_id: &str,
        source_device: u32,
        source_channel: u32,
        target_type: BusSendTargetType,
        target_id: &str,
        target_channel: u32,
    ) {
        let id = format!("bus_send_{:?}_{}_{}_{:?}_{}_{}",
            source_type, source_id, source_channel,
            target_type, target_id, target_channel
        );
        route_config::get_route_config().remove_send(&id);
    }

    // =========================================================================
    // Bus Operations (delegates to route_config)
    // =========================================================================

    /// Add a bus
    pub fn add_bus(&self, id: String, label: String, channels: u32) {
        let config = BusConfig {
            id,
            label,
            channels,
            fader: 1.0,
            muted: false,
            plugin_ids: Vec::new(),
        };
        route_config::get_route_config().add_bus(config);
    }

    /// Reserve a bus ID
    pub fn reserve_bus_id(&self) -> Option<String> {
        Some(route_config::get_route_config().reserve_bus_id())
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        route_config::get_route_config().remove_bus(bus_id);
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        route_config::get_route_config().set_bus_fader(bus_id, level.clamp(0.0, 1.0));
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        route_config::get_route_config().set_bus_mute(bus_id, muted);
    }

    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        route_config::get_route_config().set_bus_plugins(bus_id, plugin_ids);
    }

    /// Get bus plugin chain
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        route_config::get_route_config().get_bus_plugins(bus_id)
    }

    /// Get all buses (legacy format)
    pub fn get_buses(&self) -> Vec<Bus> {
        route_config::get_route_config()
            .get_buses()
            .iter()
            .map(Bus::from_config)
            .collect()
    }

    // =========================================================================
    // Fader Operations (delegates to route_config)
    // =========================================================================

    /// Set source fader (unused - sources don't have individual faders in Sends-on-Fader)
    pub fn set_source_fader(&self, _pair_index: usize, _level: f32) {
        // In Sends-on-Fader design, source faders are not used
        // Level is controlled via sends
    }

    /// Set source mute (unused)
    pub fn set_source_mute(&self, _pair_index: usize, _muted: bool) {
        // In Sends-on-Fader design, source mutes are not used
    }

    /// Set output master fader
    pub fn set_output_fader(&self, device_id: &str, db: f32) {
        route_config::get_route_config().set_output_fader(device_id, db);
    }

    // =========================================================================
    // Meter Operations (reads from audio_graph)
    // =========================================================================

    /// Get input levels
    pub fn get_input_levels(&self) -> [ChannelLevels; PRISM_CHANNELS / 2] {
        let meters = audio_graph::get_graph_manager().load_meters();
        let mut levels = [ChannelLevels::default(); PRISM_CHANNELS / 2];
        
        for (&node_id, &graph_levels) in meters.inputs.iter() {
            if let Some((device_id, pair_idx)) = node_id.input_info() {
                if device_id == 0 && (pair_idx as usize) < PRISM_CHANNELS / 2 {
                    levels[pair_idx as usize] = graph_levels.into();
                }
            }
        }
        
        levels
    }

    /// Get output levels for a device
    pub fn get_output_levels(&self, device_key: &str) -> Vec<ChannelLevels> {
        self.output_levels
            .read()
            .get(device_key)
            .cloned()
            .unwrap_or_default()
    }

    /// Update output levels (called from audio_output)
    pub fn try_update_output_levels(&self, device_key: &str, level: ChannelLevels) {
        if let Some(mut guard) = self.output_levels.try_write() {
            if let Some(existing) = guard.get_mut(device_key) {
                if existing.is_empty() {
                    existing.push(level);
                } else {
                    existing[0] = level;
                }
            } else {
                guard.insert(device_key.to_string(), vec![level]);
            }
        }
    }

    /// Get bus levels
    pub fn get_bus_levels(&self) -> Vec<(String, BusLevels, Vec<BusSendLevel>)> {
        let meters = audio_graph::get_graph_manager().load_meters();
        let buses = route_config::get_route_config().get_buses();
        
        buses.iter().filter_map(|bus| {
            if let Some(idx) = route_config::get_route_config().get_bus_index(&bus.id) {
                let levels = meters.buses.get(&(idx as u8))
                    .map(|&g| BusLevels::from(g))
                    .unwrap_or_default();
                Some((bus.id.clone(), levels, Vec::new()))
            } else {
                None
            }
        }).collect()
    }

    /// Update bus level (called from audio processor)
    pub fn update_bus_level(
        &self,
        _bus_idx: usize,
        _pre_left_peak: f32,
        _pre_right_peak: f32,
        _post_left_peak: f32,
        _post_right_peak: f32,
    ) {
        // Meters are now stored in audio_graph::GraphMeters
        // This is a no-op for compatibility
    }

    // =========================================================================
    // Sample Rate / Buffer Size
    // =========================================================================

    pub fn set_sample_rate(&self, rate: u32) {
        *self.sample_rate.write() = rate;
    }

    pub fn get_sample_rate(&self) -> u32 {
        *self.sample_rate.read()
    }

    pub fn set_buffer_size(&self, size: u32) {
        *self.buffer_size.write() = size;
    }

    pub fn get_buffer_size(&self) -> u32 {
        *self.buffer_size.read()
    }
}

// =============================================================================
// Global Instance
// =============================================================================

lazy_static::lazy_static! {
    pub static ref MIXER_STATE: Arc<MixerState> = Arc::new(MixerState::new());
}

/// Get global mixer state
pub fn get_mixer_state() -> Arc<MixerState> {
    Arc::clone(&MIXER_STATE)
}

/// Hash device ID (re-export for compatibility)
#[inline]
pub fn hash_device_id(device_id: &str) -> u64 {
    route_config::hash_device_id(device_id)
}
