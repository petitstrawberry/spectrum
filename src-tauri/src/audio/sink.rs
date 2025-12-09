//! Sink Node - Output destinations

use super::buffer::AudioBuffer;
use super::node::{AudioNode, NodeType, PortId};
use serde::{Deserialize, Serialize};
use std::any::Any;

/// 出力先の識別
///
/// 重要: 仮想デバイスの概念はここで実装
/// - 集約デバイスのサブデバイスは個別の SinkId として表現
/// - 通常デバイスは channel_offset = 0
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SinkId {
    /// 実際の CoreAudio デバイス ID
    pub device_id: u32,
    /// デバイス内でのチャンネルオフセット
    /// 集約デバイスのサブデバイスを区別するために使用
    pub channel_offset: u8,
    /// このシンクが担当するチャンネル数
    pub channel_count: u8,
}

impl SinkId {
    /// Create a simple sink (non-aggregate device)
    pub fn new(device_id: u32, channel_count: u8) -> Self {
        Self {
            device_id,
            channel_offset: 0,
            channel_count,
        }
    }

    /// Create a sink for aggregate sub-device
    pub fn with_offset(device_id: u32, channel_offset: u8, channel_count: u8) -> Self {
        Self {
            device_id,
            channel_offset,
            channel_count,
        }
    }
}

/// 出力先ノード
///
/// 物理デバイスまたは仮想デバイスへの出力
pub struct SinkNode {
    /// 出力先の識別情報
    sink_id: SinkId,
    /// 表示ラベル
    label: String,
    /// 入力バッファ（チャンネル数分）
    input_buffers: Vec<AudioBuffer>,
}

impl SinkNode {
    /// Create a new sink node
    pub fn new(sink_id: SinkId, label: impl Into<String>) -> Self {
        let channel_count = sink_id.channel_count as usize;
        Self {
            sink_id,
            label: label.into(),
            input_buffers: (0..channel_count).map(|_| AudioBuffer::new()).collect(),
        }
    }

    /// Create a stereo sink
    pub fn new_stereo(device_id: u32, label: impl Into<String>) -> Self {
        Self::new(SinkId::new(device_id, 2), label)
    }

    /// Get the sink ID
    pub fn sink_id(&self) -> &SinkId {
        &self.sink_id
    }

    /// Get device ID
    pub fn device_id(&self) -> u32 {
        self.sink_id.device_id
    }

    /// Get channel offset
    pub fn channel_offset(&self) -> u8 {
        self.sink_id.channel_offset
    }

    /// Set the label
    pub fn set_label(&mut self, label: impl Into<String>) {
        self.label = label.into();
    }

    /// Get input buffer samples for output (used by output callback)
    pub fn get_output_samples(&self, port: usize) -> Option<&[f32]> {
        self.input_buffers.get(port).map(|b| b.samples())
    }
}

impl AudioNode for SinkNode {
    fn node_type(&self) -> NodeType {
        NodeType::Sink
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn input_port_count(&self) -> usize {
        self.input_buffers.len()
    }

    fn output_port_count(&self) -> usize {
        0 // シンクは出力なし
    }

    fn input_buffer(&self, port: PortId) -> Option<&AudioBuffer> {
        self.input_buffers.get(port.index())
    }

    fn input_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer> {
        self.input_buffers.get_mut(port.index())
    }

    fn output_buffer(&self, _port: PortId) -> Option<&AudioBuffer> {
        None // シンクは出力バッファなし
    }

    fn output_buffer_mut(&mut self, _port: PortId) -> Option<&mut AudioBuffer> {
        None
    }

    fn process(&mut self, frames: usize) {
        // シンクの処理は output callback で行う
        // ここでは入力バッファのピークを更新するのみ
        for buf in &mut self.input_buffers {
            buf.set_valid_frames(frames);
            buf.update_peak();
        }
    }

    fn clear_buffers(&mut self, frames: usize) {
        for buf in &mut self.input_buffers {
            buf.clear(frames);
        }
    }

    fn input_peak_levels(&self) -> Vec<f32> {
        self.input_buffers.iter().map(|b| b.cached_peak()).collect()
    }

    fn output_peak_levels(&self) -> Vec<f32> {
        Vec::new() // シンクは出力なし
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
