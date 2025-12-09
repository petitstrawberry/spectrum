//! Metering types

use super::edge::EdgeId;
use super::node::NodeHandle;

/// Port meter (single channel)
#[derive(Debug, Clone, Default)]
pub struct PortMeter {
    pub peak: f32,
    pub rms: Option<f32>,
}

impl PortMeter {
    pub fn new(peak: f32) -> Self {
        Self { peak, rms: None }
    }

    pub fn with_rms(peak: f32, rms: f32) -> Self {
        Self {
            peak,
            rms: Some(rms),
        }
    }
}

/// Node meter (all ports)
#[derive(Debug, Clone)]
pub struct NodeMeter {
    pub handle: NodeHandle,
    pub inputs: Vec<PortMeter>,
    pub outputs: Vec<PortMeter>,
}

impl NodeMeter {
    pub fn new(handle: NodeHandle) -> Self {
        Self {
            handle,
            inputs: Vec::new(),
            outputs: Vec::new(),
        }
    }
}

/// Edge meter (post-gain level)
#[derive(Debug, Clone)]
pub struct EdgeMeter {
    pub edge_id: EdgeId,
    pub post_gain: PortMeter,
}

impl EdgeMeter {
    pub fn new(edge_id: EdgeId) -> Self {
        Self {
            edge_id,
            post_gain: PortMeter::default(),
        }
    }
}

/// All meters for the graph
#[derive(Debug, Clone, Default)]
pub struct GraphMeters {
    pub nodes: Vec<NodeMeter>,
    pub edges: Vec<EdgeMeter>,
    pub timestamp: u64,
}

impl GraphMeters {
    pub fn new() -> Self {
        Self::default()
    }
}
