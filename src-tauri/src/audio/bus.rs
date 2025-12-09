//! Bus Node - Effects bus with plugin chain

use super::buffer::AudioBuffer;
use super::node::{AudioNode, NodeType, PortId};
use std::any::Any;

/// Plugin instance info (placeholder - will connect to audio_unit.rs)
#[derive(Debug, Clone)]
pub struct PluginInstance {
    pub instance_id: String,
    pub plugin_id: String,
    pub name: String,
    pub enabled: bool,
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
        self.plugin_chain.push(PluginInstance {
            instance_id,
            plugin_id,
            name,
            enabled: true,
        });
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

        // TODO: プラグインチェーンを通す
        // for plugin in &mut self.plugin_chain {
        //     if plugin.enabled {
        //         plugin.process(&mut self.output_buffers, frames);
        //     }
        // }

        // Update peak levels
        for buf in &mut self.output_buffers {
            buf.update_peak();
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
