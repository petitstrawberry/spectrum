//! Bus Node - Effects bus with plugin chain

use super::buffer::AudioBuffer;
use super::node::{AudioNode, NodeType, PortId};
use crate::audio_unit::{get_au_manager, AudioUnitInstance};
use std::any::Any;
use std::sync::Arc;

/// Plugin instance info with AudioUnit integration
pub struct PluginInstance {
    pub instance_id: String,
    pub plugin_id: String,
    pub name: String,
    pub enabled: bool,
    /// Cached AudioUnit instance for lock-free audio processing
    au_instance: Option<Arc<AudioUnitInstance>>,
}

impl std::fmt::Debug for PluginInstance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginInstance")
            .field("instance_id", &self.instance_id)
            .field("plugin_id", &self.plugin_id)
            .field("name", &self.name)
            .field("enabled", &self.enabled)
            .field("au_instance", &self.au_instance.as_ref().map(|_| "AudioUnitInstance"))
            .finish()
    }
}

impl Clone for PluginInstance {
    fn clone(&self) -> Self {
        Self {
            instance_id: self.instance_id.clone(),
            plugin_id: self.plugin_id.clone(),
            name: self.name.clone(),
            enabled: self.enabled,
            // Re-fetch from manager to get Arc clone
            au_instance: get_au_manager().get_instance(&self.instance_id),
        }
    }
}

impl PluginInstance {
    /// Create a new plugin instance
    pub fn new(instance_id: String, plugin_id: String, name: String) -> Self {
        // Try to get the AudioUnit instance from the manager
        let au_instance = get_au_manager().get_instance(&instance_id);
        Self {
            instance_id,
            plugin_id,
            name,
            enabled: true,
            au_instance,
        }
    }

    /// Process audio through this plugin
    ///
    /// Returns true if processing was applied, false if bypassed/disabled
    pub fn process(&self, left: &mut [f32], right: &mut [f32]) -> bool {
        if !self.enabled {
            return false;
        }

        if let Some(ref au) = self.au_instance {
            // Process through AudioUnit
            if let Err(e) = au.process(left, right, 0.0) {
                // Log but don't fail - just bypass
                eprintln!("[BusNode] Plugin {} process error: {}", self.instance_id, e);
                return false;
            }
            true
        } else {
            false
        }
    }

    /// Refresh the AudioUnit instance reference
    pub fn refresh_au_instance(&mut self) {
        self.au_instance = get_au_manager().get_instance(&self.instance_id);
    }
}

/// エフェクトバスノード
///
/// 注意: fader/mute を持たない（Sends-on-Fader 原則）
/// レベル制御は入力/出力の Edge で行う
pub struct BusNode {
    /// バスの識別子
    bus_id: String,
    /// 表示ラベル
    label: String,
    /// 入力バッファ（ステレオ = 2ポート）
    input_buffers: Vec<AudioBuffer>,
    /// 出力バッファ（ステレオ = 2ポート）
    output_buffers: Vec<AudioBuffer>,
    /// プラグインチェーン (TODO: AudioUnit integration)
    plugin_chain: Vec<PluginInstance>,
}

impl BusNode {
    /// Create a new bus node
    pub fn new(bus_id: impl Into<String>, label: impl Into<String>, port_count: usize) -> Self {
        let port_count = port_count.max(1);
        Self {
            bus_id: bus_id.into(),
            label: label.into(),
            input_buffers: (0..port_count).map(|_| AudioBuffer::new()).collect(),
            output_buffers: (0..port_count).map(|_| AudioBuffer::new()).collect(),
            plugin_chain: Vec::new(),
        }
    }

    /// Create a stereo bus
    pub fn new_stereo(bus_id: impl Into<String>, label: impl Into<String>) -> Self {
        Self::new(bus_id, label, 2)
    }

    /// Get the bus ID
    pub fn bus_id(&self) -> &str {
        &self.bus_id
    }

    /// Set the label
    pub fn set_label(&mut self, label: impl Into<String>) {
        self.label = label.into();
    }

    /// Get plugin chain
    pub fn plugins(&self) -> &[PluginInstance] {
        &self.plugin_chain
    }

    /// Add a plugin to the chain
    pub fn add_plugin(&mut self, instance_id: String, plugin_id: String, name: String) {
        self.plugin_chain.push(PluginInstance::new(instance_id, plugin_id, name));
    }

    /// Remove a plugin from the chain
    pub fn remove_plugin(&mut self, instance_id: &str) -> Option<PluginInstance> {
        let pos = self
            .plugin_chain
            .iter()
            .position(|p| p.instance_id == instance_id)?;
        Some(self.plugin_chain.remove(pos))
    }

    /// Reorder plugins
    pub fn reorder_plugins(&mut self, instance_ids: &[String]) {
        let mut new_chain = Vec::with_capacity(instance_ids.len());
        for id in instance_ids {
            if let Some(pos) = self.plugin_chain.iter().position(|p| &p.instance_id == id) {
                new_chain.push(self.plugin_chain.remove(pos));
            }
        }
        // Append any remaining plugins not in the list
        new_chain.append(&mut self.plugin_chain);
        self.plugin_chain = new_chain;
    }

    /// Enable/disable (bypass) a plugin instance in this bus.
    ///
    /// Returns true if the instance was found.
    pub fn set_plugin_enabled(&mut self, instance_id: &str, enabled: bool) -> bool {
        if let Some(p) = self
            .plugin_chain
            .iter_mut()
            .find(|p| p.instance_id == instance_id)
        {
            p.enabled = enabled;
            true
        } else {
            false
        }
    }
}

impl AudioNode for BusNode {
    fn node_type(&self) -> NodeType {
        NodeType::Bus
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn input_port_count(&self) -> usize {
        self.input_buffers.len()
    }

    fn output_port_count(&self) -> usize {
        self.output_buffers.len()
    }

    fn input_buffer(&self, port: PortId) -> Option<&AudioBuffer> {
        self.input_buffers.get(port.index())
    }

    fn input_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer> {
        self.input_buffers.get_mut(port.index())
    }

    fn output_buffer(&self, port: PortId) -> Option<&AudioBuffer> {
        self.output_buffers.get(port.index())
    }

    fn output_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer> {
        self.output_buffers.get_mut(port.index())
    }

    fn process(&mut self, frames: usize) {
        // 入力 → 出力にコピー
        for i in 0..self.output_buffers.len() {
            if let Some(in_buf) = self.input_buffers.get(i) {
                self.output_buffers[i].copy_from(in_buf);
            }
            self.output_buffers[i].set_valid_frames(frames);
        }

        // プラグインチェーンを通す（ステレオ処理）
        if self.output_buffers.len() >= 2 && !self.plugin_chain.is_empty() {
            // Get raw pointers for left and right channels
            // We need to process both channels together for stereo plugins
            let left_ptr = self.output_buffers[0].samples_mut().as_mut_ptr();
            let right_ptr = self.output_buffers[1].samples_mut().as_mut_ptr();

            // Process through each enabled plugin in the chain
            for plugin in &self.plugin_chain {
                if plugin.enabled {
                    // Create slices from pointers for this iteration
                    // SAFETY: We have mutable access to output_buffers and frames is valid
                    unsafe {
                        let left = std::slice::from_raw_parts_mut(left_ptr, frames);
                        let right = std::slice::from_raw_parts_mut(right_ptr, frames);
                        plugin.process(left, right);
                    }
                }
            }
        }

        // Update peak levels and RMS
        for buf in &mut self.output_buffers {
            buf.update_meters();
        }
    }

    fn clear_buffers(&mut self, frames: usize) {
        for buf in &mut self.input_buffers {
            buf.clear(frames);
        }
        for buf in &mut self.output_buffers {
            buf.clear(frames);
        }
    }

    fn input_peak_levels(&self) -> Vec<f32> {
        self.input_buffers.iter().map(|b| b.cached_peak()).collect()
    }

    fn output_peak_levels(&self) -> Vec<f32> {
        self.output_buffers
            .iter()
            .map(|b| b.cached_peak())
            .collect()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
