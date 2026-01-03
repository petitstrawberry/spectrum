//! Data Transfer Objects for API

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// 基本型
// =============================================================================

/// ノードハンドル
pub type NodeHandle = u32;

/// エッジID
pub type EdgeId = u32;

/// ポートID
pub type PortId = u8;

// =============================================================================
// Source / Sink 識別
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SourceIdDto {
    #[serde(rename = "prism")]
    PrismChannel { channel: u8 },
    #[serde(rename = "device")]
    InputDevice { device_id: u32, channel: u8 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSinkDto {
    pub device_id: u32,
    pub channel_offset: u8,
    pub channel_count: u8,
}

// =============================================================================
// Node DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInstanceDto {
    pub instance_id: String,
    pub plugin_id: String,
    pub name: String,
    #[serde(default)]
    pub manufacturer: String,
    pub enabled: bool,
    /// Optional plugin fullState serialized as base64(plist binary)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NodeInfoDto {
    #[serde(rename = "source")]
    Source {
        handle: NodeHandle,
        #[serde(default)]
        stable_id: String,
        source_id: SourceIdDto,
        port_count: u8,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sub_label: Option<String>,
    },
    #[serde(rename = "bus")]
    Bus {
        handle: NodeHandle,
        #[serde(default)]
        stable_id: String,
        bus_id: String,
        label: String,
        port_count: u8,
        plugins: Vec<PluginInstanceDto>,
    },
    #[serde(rename = "sink")]
    Sink {
        handle: NodeHandle,
        #[serde(default)]
        stable_id: String,
        sink: OutputSinkDto,
        port_count: u8,
        label: String,
    },
}

// =============================================================================
// Edge DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeInfoDto {
    pub id: EdgeId,
    pub source: NodeHandle,
    pub source_port: PortId,
    pub target: NodeHandle,
    pub target_port: PortId,
    pub gain: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeGainUpdate {
    pub id: EdgeId,
    pub gain: f32,
}

// =============================================================================
// Graph DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphDto {
    pub nodes: Vec<NodeInfoDto>,
    pub edges: Vec<EdgeInfoDto>,
}

// =============================================================================
// Device DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputDeviceDto {
    pub id: String,
    pub device_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_uid: Option<String>,
    pub name: String,
    pub channel_count: u8,
    pub is_prism: bool,
    pub transport_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputDeviceDto {
    pub id: String,
    pub device_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subdevice_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
    pub channel_offset: u8,
    pub channel_count: u8,
    pub name: String,
    pub device_type: String,
    pub transport_type: String,
    pub icon_hint: String,
    pub is_aggregate_sub: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrismAppDto {
    pub pid: u32,
    pub name: String,
    pub channel_offset: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrismStatusDto {
    pub connected: bool,
    pub channels: u8,
    pub apps: Vec<PrismAppDto>,
}

// =============================================================================
// Plugin DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfoDto {
    pub plugin_id: String,
    pub name: String,
    pub manufacturer: String,
}

// =============================================================================
// Meter DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMeterDto {
    pub peak: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rms: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMeterDto {
    pub handle: NodeHandle,
    pub inputs: Vec<PortMeterDto>,
    pub outputs: Vec<PortMeterDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeMeterDto {
    pub edge_id: EdgeId,
    pub post_gain: PortMeterDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphMetersDto {
    pub nodes: Vec<NodeMeterDto>,
    pub edges: Vec<EdgeMeterDto>,
    pub timestamp: u64,
}

// =============================================================================
// State DTOs (永続化用)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePosition {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasTransformDto {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
}

fn is_empty_map_kv<K, V>(m: &HashMap<K, V>) -> bool {
    m.is_empty()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIStateDto {
    /// Stable-keyed node positions (preferred).
    /// Keys are strings like `source:prism:0`, `bus:<bus_id>`, etc.
    #[serde(default)]
    pub node_positions: HashMap<String, NodePosition>,

    /// Backward-compat: old handle-keyed positions.
    #[serde(default, skip_serializing_if = "is_empty_map_kv")]
    pub node_positions_by_handle: HashMap<NodeHandle, NodePosition>,

    /// Optional layout UI state (v1 parity): panel sizes and canvas pan/zoom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_sidebar_width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_sidebar_width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixer_height: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas_transform: Option<CanvasTransformDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphStateDto {
    pub version: u32,
    pub nodes: Vec<NodeInfoDto>,
    pub edges: Vec<EdgeInfoDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_state: Option<UIStateDto>,
}

// =============================================================================
// System DTOs
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatusDto {
    pub audio_running: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub cpu_load: f32,
}

// =============================================================================
// Conversions
// =============================================================================

impl From<crate::audio::source::SourceId> for SourceIdDto {
    fn from(source: crate::audio::source::SourceId) -> Self {
        match source {
            crate::audio::source::SourceId::PrismChannel { channel } => {
                SourceIdDto::PrismChannel { channel }
            }
            crate::audio::source::SourceId::InputDevice { device_id, channel } => {
                SourceIdDto::InputDevice { device_id, channel }
            }
        }
    }
}

impl From<SourceIdDto> for crate::audio::source::SourceId {
    fn from(dto: SourceIdDto) -> Self {
        match dto {
            SourceIdDto::PrismChannel { channel } => {
                crate::audio::source::SourceId::PrismChannel { channel }
            }
            SourceIdDto::InputDevice { device_id, channel } => {
                crate::audio::source::SourceId::InputDevice { device_id, channel }
            }
        }
    }
}

impl From<crate::audio::sink::SinkId> for OutputSinkDto {
    fn from(sink: crate::audio::sink::SinkId) -> Self {
        OutputSinkDto {
            device_id: sink.device_id,
            channel_offset: sink.channel_offset,
            channel_count: sink.channel_count,
        }
    }
}

impl From<OutputSinkDto> for crate::audio::sink::SinkId {
    fn from(dto: OutputSinkDto) -> Self {
        crate::audio::sink::SinkId {
            device_id: dto.device_id,
            channel_offset: dto.channel_offset,
            channel_count: dto.channel_count,
        }
    }
}

impl From<crate::audio::Edge> for EdgeInfoDto {
    fn from(edge: crate::audio::Edge) -> Self {
        EdgeInfoDto {
            id: edge.id.raw(),
            source: edge.source.raw(),
            source_port: edge.source_port.into(),
            target: edge.target.raw(),
            target_port: edge.target_port.into(),
            gain: edge.gain(),
            muted: edge.muted(),
        }
    }
}

impl From<crate::audio::GraphMeters> for GraphMetersDto {
    fn from(meters: crate::audio::GraphMeters) -> Self {
        GraphMetersDto {
            nodes: meters
                .nodes
                .into_iter()
                .map(|m| NodeMeterDto {
                    handle: m.handle.raw(),
                    inputs: m
                        .inputs
                        .into_iter()
                        .map(|p| PortMeterDto {
                            peak: p.peak,
                            rms: p.rms,
                        })
                        .collect(),
                    outputs: m
                        .outputs
                        .into_iter()
                        .map(|p| PortMeterDto {
                            peak: p.peak,
                            rms: p.rms,
                        })
                        .collect(),
                })
                .collect(),
            edges: meters
                .edges
                .into_iter()
                .map(|m| EdgeMeterDto {
                    edge_id: m.edge_id.raw(),
                    post_gain: PortMeterDto {
                        peak: m.post_gain.peak,
                        rms: m.post_gain.rms,
                    },
                })
                .collect(),
            timestamp: meters.timestamp,
        }
    }
}
