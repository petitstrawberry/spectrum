//! Audio Graph Engine
//!
//! Clean implementation of DAG-based audio routing.
//! Sends-on-Fader design: all level control is done via edges, not nodes.
//!
//! ## Design Principles
//! - Nodes are just buffers + processing (no faders on nodes)
//! - Edges control all routing and levels (Sends-on-Fader)
//! - Topological sort ensures correct processing order
//! - Lock-free reads via ArcSwap for audio callback safety
//!
//! ## Node Types
//! - Input: Audio source (Prism device, external input)
//! - Bus: Effect processing (plugin chain)
//! - Output: Audio destination (speakers, headphones)
//!
//! ## Metering
//! - All metering is computed inside the graph processor
//! - Meters are stored per-node and accessible via GraphManager
//! - UI can poll meters without blocking audio

use crate::vdsp::VDsp;
use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

// =============================================================================
// Constants
// =============================================================================

/// Maximum frames per buffer (matches CoreAudio typical max)
pub const MAX_FRAMES: usize = 4096;

/// Maximum number of nodes in the graph
pub const MAX_NODES: usize = 256;

/// Maximum number of edges in the graph
pub const MAX_EDGES: usize = 1024;

// =============================================================================
// Node Identification
// =============================================================================

/// Compact node identifier (16-bit)
///
/// Encoding:
/// - 0x0000-0x0FFF: Input nodes (device_id[4bit] << 8 | pair_idx[8bit])
/// - 0x1000-0x1FFF: Bus nodes (0x1000 | bus_idx[8bit])
/// - 0x2000-0x2FFF: Output nodes (0x2000 | hash8[8bit] << 4 | pair_idx[4bit])
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct NodeId(pub u16);

impl NodeId {
    pub const INVALID: NodeId = NodeId(0xFFFF);

    /// Create input node ID
    #[inline]
    pub fn input(device_id: u32, pair_idx: u8) -> Self {
        let dev = (device_id as u16 & 0x0F) << 8;
        NodeId(dev | (pair_idx as u16))
    }

    /// Create bus node ID
    #[inline]
    pub fn bus(bus_idx: u8) -> Self {
        NodeId(0x1000 | (bus_idx as u16))
    }

    /// Create output node ID
    #[inline]
    pub fn output(device_hash: u64, pair_idx: u8) -> Self {
        let hash_part = ((device_hash as u16) & 0x00FF) << 4;
        NodeId(0x2000 | hash_part | (pair_idx as u16 & 0x0F))
    }

    /// Check if this is an input node
    #[inline]
    pub fn is_input(&self) -> bool {
        self.0 < 0x1000
    }

    /// Check if this is a bus node
    #[inline]
    pub fn is_bus(&self) -> bool {
        self.0 >= 0x1000 && self.0 < 0x2000
    }

    /// Check if this is an output node
    #[inline]
    pub fn is_output(&self) -> bool {
        self.0 >= 0x2000
    }

    /// Get input info (device_id, pair_idx) if this is an input node
    #[inline]
    pub fn input_info(&self) -> Option<(u32, u8)> {
        if self.is_input() {
            let device_id = ((self.0 >> 8) & 0x0F) as u32;
            let pair_idx = (self.0 & 0xFF) as u8;
            Some((device_id, pair_idx))
        } else {
            None
        }
    }

    /// Get bus index if this is a bus node
    #[inline]
    pub fn bus_idx(&self) -> Option<u8> {
        if self.is_bus() {
            Some((self.0 & 0x00FF) as u8)
        } else {
            None
        }
    }

    /// Get output pair index if this is an output node
    #[inline]
    pub fn output_pair_idx(&self) -> Option<u8> {
        if self.is_output() {
            Some((self.0 & 0x0F) as u8)
        } else {
            None
        }
    }

    /// Check if this output node matches the given device hash
    #[inline]
    pub fn matches_output_device(&self, device_hash: u64) -> bool {
        if !self.is_output() {
            return false;
        }
        let stored_hash = (self.0 >> 4) & 0x00FF;
        let expected_hash = (device_hash as u16) & 0x00FF;
        stored_hash == expected_hash
    }
}

// =============================================================================
// Edge (Connection with Level Control)
// =============================================================================

/// Edge represents a connection between two nodes with level control.
/// This is the core of Sends-on-Fader design - all level adjustment happens here.
#[derive(Debug, Clone, Copy)]
pub struct Edge {
    /// Source node
    pub source: NodeId,
    /// Target node
    pub target: NodeId,
    /// Send level (linear gain, 0.0 to 2.0+)
    pub gain: f32,
    /// Source channel within the node (0=left, 1=right)
    pub source_ch: u8,
    /// Target channel within the node (0=left, 1=right)
    pub target_ch: u8,
    /// Whether this edge is muted
    pub muted: bool,
}

impl Edge {
    /// Create a new edge with default settings
    pub fn new(source: NodeId, target: NodeId) -> Self {
        Self {
            source,
            target,
            gain: 1.0,
            source_ch: 0,
            target_ch: 0,
            muted: false,
        }
    }

    /// Check if this edge is active (not muted and has significant gain)
    #[inline]
    pub fn is_active(&self) -> bool {
        !self.muted && self.gain > 0.0001
    }
}

impl Default for Edge {
    fn default() -> Self {
        Self {
            source: NodeId::INVALID,
            target: NodeId::INVALID,
            gain: 1.0,
            source_ch: 0,
            target_ch: 0,
            muted: false,
        }
    }
}

// =============================================================================
// Node Buffer
// =============================================================================

/// Stereo audio buffer for a node
#[derive(Clone)]
pub struct NodeBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
    pub valid_frames: usize,
}

impl NodeBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
            valid_frames: 0,
        }
    }

    /// Clear the buffer
    #[inline]
    pub fn clear(&mut self, frames: usize) {
        let n = frames.min(MAX_FRAMES);
        self.left[..n].fill(0.0);
        self.right[..n].fill(0.0);
        self.valid_frames = n;
    }

    /// Get channel buffer by index (0=left, 1=right)
    #[inline]
    pub fn channel(&self, ch: u8) -> &[f32; MAX_FRAMES] {
        if ch == 0 { &self.left } else { &self.right }
    }

    /// Get mutable channel buffer by index
    #[inline]
    pub fn channel_mut(&mut self, ch: u8) -> &mut [f32; MAX_FRAMES] {
        if ch == 0 { &mut self.left } else { &mut self.right }
    }
}

impl Default for NodeBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Metering Types
// =============================================================================

/// Peak levels for a stereo channel
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ChannelLevels {
    pub left_peak: f32,
    pub right_peak: f32,
}

/// Bus metering (pre and post in Sends-on-Fader are the same since no bus fader)
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct BusLevels {
    pub left_peak: f32,
    pub right_peak: f32,
}

/// Send metering (level after edge gain)
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SendLevel {
    pub target: NodeId,
    pub left_peak: f32,
    pub right_peak: f32,
    pub gain: f32,
    pub gain_db: f32,
}

/// All meters for the graph (atomically swappable)
#[derive(Clone, Default)]
pub struct GraphMeters {
    /// Input node meters
    pub inputs: HashMap<NodeId, ChannelLevels>,
    /// Bus node meters
    pub buses: HashMap<u8, BusLevels>,
    /// Output node meters
    pub outputs: HashMap<NodeId, ChannelLevels>,
    /// Send meters (indexed by source node, then target)
    pub sends: HashMap<NodeId, Vec<SendLevel>>,
}

// =============================================================================
// Bus Data (Plugin Chain)
// =============================================================================

/// Bus-specific data (plugin chain)
#[derive(Debug, Clone, Default)]
pub struct BusData {
    /// Plugin instance IDs in processing order
    pub plugin_ids: Vec<String>,
}

// =============================================================================
// Audio Graph (Immutable after construction)
// =============================================================================

/// Immutable audio graph - swap entire graph when routing changes
#[derive(Clone)]
pub struct AudioGraph {
    /// All edges in the graph
    edges: Vec<Edge>,
    /// Topologically sorted processing order
    processing_order: Vec<NodeId>,
    /// Bus data (plugin chains)
    bus_data: HashMap<u8, BusData>,
}

impl Default for AudioGraph {
    fn default() -> Self {
        Self {
            edges: Vec::new(),
            processing_order: Vec::new(),
            bus_data: HashMap::new(),
        }
    }
}

impl AudioGraph {
    /// Create a new audio graph from edges and bus data
    pub fn new(edges: Vec<Edge>, bus_data: HashMap<u8, BusData>) -> Self {
        // Extract all nodes from edges
        let mut nodes_set: HashSet<NodeId> = HashSet::new();
        for edge in &edges {
            if edge.is_active() {
                nodes_set.insert(edge.source);
                nodes_set.insert(edge.target);
            }
        }

        // Topological sort
        let processing_order = Self::topological_sort(&nodes_set, &edges);

        Self {
            edges,
            processing_order,
            bus_data,
        }
    }

    /// Topological sort using Kahn's algorithm
    fn topological_sort(nodes: &HashSet<NodeId>, edges: &[Edge]) -> Vec<NodeId> {
        let mut in_degree: HashMap<NodeId, usize> = HashMap::new();
        let mut adj: HashMap<NodeId, Vec<NodeId>> = HashMap::new();

        // Initialize
        for &node in nodes {
            in_degree.insert(node, 0);
            adj.insert(node, Vec::new());
        }

        // Build adjacency list and count in-degrees
        for edge in edges {
            if !edge.is_active() {
                continue;
            }
            if let Some(deg) = in_degree.get_mut(&edge.target) {
                *deg += 1;
            }
            if let Some(neighbors) = adj.get_mut(&edge.source) {
                if !neighbors.contains(&edge.target) {
                    neighbors.push(edge.target);
                }
            }
        }

        // Kahn's algorithm
        let mut queue: VecDeque<NodeId> = VecDeque::new();
        for (&node, &deg) in &in_degree {
            if deg == 0 {
                queue.push_back(node);
            }
        }

        let mut order = Vec::with_capacity(nodes.len());
        while let Some(node) = queue.pop_front() {
            order.push(node);

            if let Some(neighbors) = adj.get(&node) {
                for &neighbor in neighbors {
                    if let Some(deg) = in_degree.get_mut(&neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }

        // Handle cycles (add remaining nodes at end)
        if order.len() < nodes.len() {
            for &node in nodes {
                if !order.contains(&node) {
                    order.push(node);
                }
            }
        }

        order
    }

    /// Get processing order
    #[inline]
    pub fn processing_order(&self) -> &[NodeId] {
        &self.processing_order
    }

    /// Get all edges
    #[inline]
    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// Get edges targeting a specific node
    pub fn edges_to(&self, target: NodeId) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter(move |e| e.is_active() && e.target == target)
    }

    /// Get bus data for a bus index
    #[inline]
    pub fn bus_data(&self, bus_idx: u8) -> Option<&BusData> {
        self.bus_data.get(&bus_idx)
    }

    /// Check if graph is empty
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.processing_order.is_empty()
    }
}

// =============================================================================
// Graph Processor (Stateful - holds buffers)
// =============================================================================

/// Processes audio through the graph
pub struct GraphProcessor {
    /// Node buffers
    buffers: HashMap<NodeId, NodeBuffer>,
    /// Temporary buffer for mixing operations
    temp_buffer: Box<[f32; MAX_FRAMES]>,
    /// Current meters (updated during processing)
    meters: GraphMeters,
}

impl GraphProcessor {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::with_capacity(64),
            temp_buffer: Box::new([0.0; MAX_FRAMES]),
            meters: GraphMeters::default(),
        }
    }

    /// Get or create a buffer for a node
    fn get_buffer(&mut self, node: NodeId) -> &mut NodeBuffer {
        self.buffers.entry(node).or_insert_with(NodeBuffer::new)
    }

    /// Get buffer for reading (after processing)
    pub fn read_buffer(&self, node: NodeId) -> Option<&NodeBuffer> {
        self.buffers.get(&node)
    }

    /// Get current meters
    pub fn meters(&self) -> &GraphMeters {
        &self.meters
    }

    /// Process the entire graph for one audio callback
    /// Also computes all meters internally
    ///
    /// Arguments:
    /// - graph: The audio graph to process
    /// - frames: Number of frames to process
    /// - read_input: Callback to read input audio (device_id, pair_idx, left, right) -> frames_read
    /// - process_bus: Callback to process bus plugins (bus_idx, left, right)
    pub fn process<FInput, FBus>(
        &mut self,
        graph: &AudioGraph,
        frames: usize,
        mut read_input: FInput,
        mut process_bus: FBus,
    ) where
        FInput: FnMut(u32, u8, &mut [f32], &mut [f32]) -> usize,
        FBus: FnMut(u8, &mut [f32], &mut [f32]),
    {
        let frames = frames.min(MAX_FRAMES);

        // Clear meters for this cycle
        self.meters = GraphMeters::default();

        // Process nodes in topological order
        for &node_id in graph.processing_order() {
            // Clear the node buffer first
            let buffer = self.get_buffer(node_id);
            buffer.clear(frames);

            if node_id.is_input() {
                // Input node: read from input device
                if let Some((device_id, pair_idx)) = node_id.input_info() {
                    let buffer = self.get_buffer(node_id);
                    let count = read_input(
                        device_id,
                        pair_idx,
                        &mut buffer.left[..frames],
                        &mut buffer.right[..frames],
                    );
                    buffer.valid_frames = count;

                    // Calculate input meter
                    if count > 0 {
                        let left_peak = VDsp::peak(&buffer.left[..count]);
                        let right_peak = VDsp::peak(&buffer.right[..count]);
                        self.meters.inputs.insert(node_id, ChannelLevels { left_peak, right_peak });
                    }
                }
            } else if node_id.is_bus() {
                // Bus node: mix from incoming edges, then process plugins
                let send_levels = self.mix_incoming_with_meters(graph, node_id, frames);

                // Store send meters for this bus
                if !send_levels.is_empty() {
                    self.meters.sends.insert(node_id, send_levels);
                }

                // Process plugins
                if let Some(bus_idx) = node_id.bus_idx() {
                    let buffer = self.get_buffer(node_id);
                    if buffer.valid_frames > 0 {
                        process_bus(
                            bus_idx,
                            &mut buffer.left[..frames],
                            &mut buffer.right[..frames],
                        );

                        // Calculate bus meter (post-plugin)
                        let valid = buffer.valid_frames.min(frames);
                        let left_peak = VDsp::peak(&buffer.left[..valid]);
                        let right_peak = VDsp::peak(&buffer.right[..valid]);
                        self.meters.buses.insert(bus_idx, BusLevels { left_peak, right_peak });
                    }
                }
            } else if node_id.is_output() {
                // Output node: mix from incoming edges
                let send_levels = self.mix_incoming_with_meters(graph, node_id, frames);

                // Store send meters for outputs
                if !send_levels.is_empty() {
                    self.meters.sends.insert(node_id, send_levels);
                }

                // Calculate output meter
                let buffer = self.get_buffer(node_id);
                if buffer.valid_frames > 0 {
                    let valid = buffer.valid_frames.min(frames);
                    let left_peak = VDsp::peak(&buffer.left[..valid]);
                    let right_peak = VDsp::peak(&buffer.right[..valid]);
                    self.meters.outputs.insert(node_id, ChannelLevels { left_peak, right_peak });
                }
            }
        }
    }

    /// Mix audio from all incoming edges to a target node (with metering)
    fn mix_incoming_with_meters(&mut self, graph: &AudioGraph, target: NodeId, frames: usize) -> Vec<SendLevel> {
        // Collect source data first to avoid borrow conflicts
        let mut sources: Vec<(NodeId, f32, u8, [f32; MAX_FRAMES], usize)> = Vec::new();

        for edge in graph.edges_to(target) {
            if let Some(src_buf) = self.buffers.get(&edge.source) {
                if src_buf.valid_frames == 0 {
                    continue;
                }

                let gain = edge.gain;
                if gain < 0.0001 {
                    continue;
                }

                // Copy source channel data
                let src_data = src_buf.channel(edge.source_ch);
                let valid = src_buf.valid_frames.min(frames);

                let mut local_buffer = [0.0f32; MAX_FRAMES];
                local_buffer[..valid].copy_from_slice(&src_data[..valid]);

                sources.push((edge.source, gain, edge.target_ch, local_buffer, valid));
            }
        }

        // Now mix into target buffer and calculate send meters
        let mut send_levels = Vec::with_capacity(sources.len());
        let target_buf = self.get_buffer(target);

        for (source, gain, target_ch, src_data, valid) in sources {
            // Calculate send level (after gain)
            let peak = VDsp::peak(&src_data[..valid]);
            let left_peak = if target_ch == 0 { peak * gain } else { 0.0 };
            let right_peak = if target_ch == 1 { peak * gain } else { 0.0 };

            send_levels.push(SendLevel {
                target,
                left_peak,
                right_peak,
                gain,
                gain_db: if gain < 0.0001 { -100.0 } else { 20.0 * gain.log10() },
            });

            // Mix into target buffer
            let dst = target_buf.channel_mut(target_ch);
            VDsp::mix_add(&src_data[..valid], gain, &mut dst[..valid]);
            target_buf.valid_frames = target_buf.valid_frames.max(valid);
        }

        send_levels
    }

    /// Mix audio from all incoming edges to a target node (without metering - legacy)
    fn mix_incoming(&mut self, graph: &AudioGraph, target: NodeId, frames: usize) {
        let _ = self.mix_incoming_with_meters(graph, target, frames);
    }

    /// Write output to interleaved buffer
    pub fn write_to_interleaved(
        &self,
        node_id: NodeId,
        output: &mut [f32],
        output_channels: usize,
        frames: usize,
    ) {
        if let Some(buffer) = self.buffers.get(&node_id) {
            if buffer.valid_frames == 0 {
                return;
            }

            let valid = buffer.valid_frames.min(frames);
            let pair_idx = node_id.output_pair_idx().unwrap_or(0) as usize;
            let left_ch = pair_idx * 2;
            let right_ch = left_ch + 1;

            // Write left channel
            if left_ch < output_channels {
                for i in 0..valid {
                    let out_idx = i * output_channels + left_ch;
                    if out_idx < output.len() {
                        output[out_idx] += buffer.left[i];
                    }
                }
            }

            // Write right channel
            if right_ch < output_channels {
                for i in 0..valid {
                    let out_idx = i * output_channels + right_ch;
                    if out_idx < output.len() {
                        output[out_idx] += buffer.right[i];
                    }
                }
            }
        }
    }
}

impl Default for GraphProcessor {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Graph Manager (Thread-safe state management)
// =============================================================================

/// Thread-safe manager for audio graph
/// Uses ArcSwap for lock-free reads in audio callback
pub struct GraphManager {
    /// Current graph (atomically swappable)
    graph: ArcSwap<AudioGraph>,
    /// Graph processor (protected by RwLock - only audio thread writes)
    processor: parking_lot::RwLock<GraphProcessor>,
    /// Latest meters (atomically swappable for UI reads)
    meters: ArcSwap<GraphMeters>,
}

impl GraphManager {
    pub fn new() -> Self {
        Self {
            graph: ArcSwap::from_pointee(AudioGraph::default()),
            processor: parking_lot::RwLock::new(GraphProcessor::new()),
            meters: ArcSwap::from_pointee(GraphMeters::default()),
        }
    }

    /// Update the graph (call from main thread when routing changes)
    pub fn update_graph(&self, graph: AudioGraph) {
        self.graph.store(Arc::new(graph));
    }

    /// Get current graph for reading
    pub fn load_graph(&self) -> arc_swap::Guard<Arc<AudioGraph>> {
        self.graph.load()
    }

    /// Get processor for audio callback (try_write to avoid blocking)
    pub fn try_processor(&self) -> Option<parking_lot::RwLockWriteGuard<'_, GraphProcessor>> {
        self.processor.try_write()
    }

    /// Get current meters (lock-free read for UI)
    pub fn load_meters(&self) -> arc_swap::Guard<Arc<GraphMeters>> {
        self.meters.load()
    }

    /// Update meters from processor (call after processing in audio callback)
    pub fn store_meters(&self, meters: GraphMeters) {
        self.meters.store(Arc::new(meters));
    }

    /// Process audio (called from audio callback)
    pub fn process<FInput, FBus>(
        &self,
        frames: usize,
        read_input: FInput,
        process_bus: FBus,
    ) -> bool
    where
        FInput: FnMut(u32, u8, &mut [f32], &mut [f32]) -> usize,
        FBus: FnMut(u8, &mut [f32], &mut [f32]),
    {
        let graph = self.graph.load();

        if graph.is_empty() {
            return false;
        }

        if let Some(mut processor) = self.processor.try_write() {
            processor.process(&graph, frames, read_input, process_bus);
            // Store meters for UI access
            self.meters.store(Arc::new(processor.meters().clone()));
            true
        } else {
            false
        }
    }
}

impl Default for GraphManager {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Global Instance
// =============================================================================

/// Global graph manager instance
static GRAPH_MANAGER: std::sync::LazyLock<GraphManager> =
    std::sync::LazyLock::new(|| GraphManager::new());

/// Get the global graph manager
pub fn get_graph_manager() -> &'static GraphManager {
    &GRAPH_MANAGER
}

// =============================================================================
// Utility Functions
// =============================================================================

/// Fast hash for device ID string
#[inline]
pub fn hash_device_id(device_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    device_id.hash(&mut hasher);
    hasher.finish()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_id_input() {
        let id = NodeId::input(0, 5);
        assert!(id.is_input());
        assert!(!id.is_bus());
        assert!(!id.is_output());
        assert_eq!(id.input_info(), Some((0, 5)));
    }

    #[test]
    fn test_node_id_bus() {
        let id = NodeId::bus(3);
        assert!(!id.is_input());
        assert!(id.is_bus());
        assert!(!id.is_output());
        assert_eq!(id.bus_idx(), Some(3));
    }

    #[test]
    fn test_node_id_output() {
        let id = NodeId::output(0x12345678, 2);
        assert!(!id.is_input());
        assert!(!id.is_bus());
        assert!(id.is_output());
        assert_eq!(id.output_pair_idx(), Some(2));
    }

    #[test]
    fn test_topological_sort() {
        // Input -> Bus -> Output
        let edges = vec![
            Edge { source: NodeId::input(0, 0), target: NodeId::bus(0), gain: 1.0, source_ch: 0, target_ch: 0, muted: false },
            Edge { source: NodeId::input(0, 0), target: NodeId::bus(0), gain: 1.0, source_ch: 1, target_ch: 1, muted: false },
            Edge { source: NodeId::bus(0), target: NodeId::output(0, 0), gain: 1.0, source_ch: 0, target_ch: 0, muted: false },
            Edge { source: NodeId::bus(0), target: NodeId::output(0, 0), gain: 1.0, source_ch: 1, target_ch: 1, muted: false },
        ];

        let graph = AudioGraph::new(edges, HashMap::new());
        let order = graph.processing_order();

        // Input should come before Bus, Bus should come before Output
        let input_pos = order.iter().position(|&n| n == NodeId::input(0, 0)).unwrap();
        let bus_pos = order.iter().position(|&n| n == NodeId::bus(0)).unwrap();
        let output_pos = order.iter().position(|&n| n == NodeId::output(0, 0)).unwrap();

        assert!(input_pos < bus_pos);
        assert!(bus_pos < output_pos);
    }
}
