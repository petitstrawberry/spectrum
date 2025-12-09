//! Source Node - Input sources (Prism channels, external devices)

use super::buffer::AudioBuffer;
use super::node::{AudioNode, NodeType, PortId};
use serde::{Deserialize, Serialize};

/// ソースの識別
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SourceId {
    /// Prism 仮想デバイスのチャンネル
    #[serde(rename = "prism")]
    PrismChannel { channel: u8 },
    /// 外部入力デバイス
    #[serde(rename = "device")]
    InputDevice { device_id: u32, channel: u8 },
}

/// 入力ソースノード
///
/// Prism チャンネルまたは外部入力デバイスから音声を取得
pub struct SourceNode {
    /// ソースの識別情報
    source_id: SourceId,
    /// 表示ラベル
    label: String,
    /// 出力バッファ（モノラル = 1ポート）
    output_buffers: Vec<AudioBuffer>,
}

impl SourceNode {
    /// Create a new source node for a Prism channel
    pub fn new_prism(channel: u8, label: impl Into<String>) -> Self {
        Self {
            source_id: SourceId::PrismChannel { channel },
            label: label.into(),
            output_buffers: vec![AudioBuffer::new()],
        }
    }

    /// Create a new source node for an external input device
    pub fn new_device(device_id: u32, channel: u8, label: impl Into<String>) -> Self {
        Self {
            source_id: SourceId::InputDevice { device_id, channel },
            label: label.into(),
            output_buffers: vec![AudioBuffer::new()],
        }
    }

    /// Get the source ID
    pub fn source_id(&self) -> &SourceId {
        &self.source_id
    }

    /// Set the label
    pub fn set_label(&mut self, label: impl Into<String>) {
        self.label = label.into();
    }
}

impl AudioNode for SourceNode {
    fn node_type(&self) -> NodeType {
        NodeType::Source
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn input_port_count(&self) -> usize {
        0 // ソースは入力なし
    }

    fn output_port_count(&self) -> usize {
        self.output_buffers.len()
    }

    fn input_buffer(&self, _port: PortId) -> Option<&AudioBuffer> {
        None // ソースは入力バッファなし
    }

    fn input_buffer_mut(&mut self, _port: PortId) -> Option<&mut AudioBuffer> {
        None
    }

    fn output_buffer(&self, port: PortId) -> Option<&AudioBuffer> {
        self.output_buffers.get(port.index())
    }

    fn output_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer> {
        self.output_buffers.get_mut(port.index())
    }

    fn process(&mut self, frames: usize) {
        // Note: 実際の読み込みは GraphProcessor で行う
        // ここでは valid_frames を設定するのみ
        for buf in &mut self.output_buffers {
            buf.set_valid_frames(frames);
        }
    }

    fn clear_buffers(&mut self, frames: usize) {
        for buf in &mut self.output_buffers {
            buf.clear(frames);
        }
    }

    fn input_peak_levels(&self) -> Vec<f32> {
        Vec::new() // ソースは入力なし
    }

    fn output_peak_levels(&self) -> Vec<f32> {
        self.output_buffers
            .iter()
            .map(|b| b.cached_peak())
            .collect()
    }
}
