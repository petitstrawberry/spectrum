//! Audio Mixer Engine
//! Uses Accelerate vDSP for hardware-accelerated mixing
//! Lock-free design using ArcSwap for audio callback safety
//!
//! ## Unified Audio Graph
//! All audio routing is represented as a directed acyclic graph (DAG):
//! - Input nodes: Read from input devices (Prism, external inputs)
//! - Bus nodes: Process audio with effects
//! - Output nodes: Write to output devices
//!
//! The graph is topologically sorted for linear processing order.
//! Each node has a buffer that holds one frame of audio data.

use crate::vdsp::VDsp;
use arc_swap::ArcSwap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

/// Maximum number of Prism channels (32 stereo pairs = 64 mono channels)
pub const PRISM_CHANNELS: usize = 64;
/// Maximum number of output devices
pub const MAX_OUTPUTS: usize = 16;
/// Maximum stereo pairs per output (e.g., 32 for a 64ch device)
pub const MAX_OUTPUT_PAIRS: usize = 32;
/// Maximum number of sends
pub const MAX_SENDS: usize = 1024;
/// Maximum number of buses
pub const MAX_BUSES: usize = 32;
/// Bus channels (stereo)
pub const BUS_CHANNELS: usize = 2;
/// Maximum frames per buffer
pub const MAX_FRAMES: usize = 4096;
/// Maximum nodes in audio graph
pub const MAX_GRAPH_NODES: usize = 256;
/// Maximum edges in audio graph
pub const MAX_GRAPH_EDGES: usize = 1024;

// ============================================================================
// Unified Audio Graph
// ============================================================================

/// Node type in the audio graph
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioNodeType {
    /// Input source (device_id, channel_pair_index)
    /// device_id 0 = Prism, other = external input device
    Input { device_id: u32, pair_idx: u8 },
    /// Effect bus (bus_index)
    Bus { bus_idx: u8 },
    /// Output destination (device_id_hash, channel_pair_index)
    Output { device_hash: u64, pair_idx: u8 },
}

/// Compact node ID for efficient storage (u16)
/// Encoding:
/// - 0x0000-0x00FF: Input nodes (high byte = device_id, low byte = pair_idx) - simplified
/// - 0x0100-0x01FF: Bus nodes (low byte = bus_idx)
/// - 0x0200-0xFFFF: Output nodes (encoded device_hash + pair_idx)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct NodeId(pub u16);

impl NodeId {
    pub const INVALID: NodeId = NodeId(0xFFFF);

    /// Create input node ID
    #[inline]
    pub fn input(device_id: u32, pair_idx: u8) -> Self {
        // For simplicity: device_id in bits 8-11, pair_idx in bits 0-7
        // This limits device_id to 0-15 and pair_idx to 0-255
        let dev = (device_id as u16 & 0x0F) << 8;
        NodeId(dev | (pair_idx as u16))
    }

    /// Create bus node ID
    #[inline]
    pub fn bus(bus_idx: u8) -> Self {
        NodeId(0x1000 | (bus_idx as u16))
    }

    /// Create output node ID
    /// Format: 0x2XXX where XXX encodes device hash (upper 8 bits) + pair_idx (lower 4 bits)
    #[inline]
    pub fn output(device_hash: u64, pair_idx: u8) -> Self {
        // Use lower 8 bits of hash << 4, plus pair_idx in lower 4 bits
        // This gives us 0x2000 + (hash8 << 4) + pair4
        // Range: 0x2000 - 0x2FFF
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

    /// Get bus index if this is a bus node
    #[inline]
    pub fn bus_idx(&self) -> Option<u8> {
        if self.is_bus() {
            Some((self.0 & 0x00FF) as u8)
        } else {
            None
        }
    }

    /// Get input info if this is an input node
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

    /// Check if this output node matches the given device hash
    #[inline]
    pub fn matches_output_device(&self, device_hash: u64) -> bool {
        if !self.is_output() {
            return false;
        }
        // Extract the hash part from NodeId (8 bits) and compare with device_hash's lower 8 bits
        let stored_hash = (self.0 >> 4) & 0x00FF;
        let expected_hash = (device_hash as u16) & 0x00FF;
        stored_hash == expected_hash
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
}

/// Edge in the audio graph (source -> target with gain)
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub gain: f32,
    /// Source channel within the node (0=left, 1=right for stereo nodes)
    pub source_ch: u8,
    /// Target channel within the node (0=left, 1=right for stereo nodes)
    pub target_ch: u8,
    pub active: bool,
}

/// Audio buffer for a single node (stereo)
#[derive(Clone)]
pub struct NodeBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
    pub valid_frames: usize,
    pub processed_at: u64,
}

impl NodeBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
            valid_frames: 0,
            processed_at: 0,
        }
    }

    #[inline]
    pub fn clear(&mut self, frames: usize) {
        let n = frames.min(MAX_FRAMES);
        self.left[..n].fill(0.0);
        self.right[..n].fill(0.0);
        self.valid_frames = n;
    }
}

impl Default for NodeBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Unified audio graph for routing and processing
/// Immutable after construction - swap entire graph when routing changes
#[derive(Clone)]
pub struct AudioGraph {
    /// All edges in the graph
    pub edges: Vec<AudioEdge>,
    /// Topologically sorted processing order (node IDs)
    pub processing_order: Vec<NodeId>,
    /// Bus definitions (for plugin processing)
    pub buses: Vec<Bus>,
    /// Source faders (per stereo pair)
    pub source_faders: [f32; PRISM_CHANNELS / 2],
    /// Source mutes (per stereo pair)
    pub source_mutes: [bool; PRISM_CHANNELS / 2],
}

impl Default for AudioGraph {
    fn default() -> Self {
        Self {
            edges: Vec::new(),
            processing_order: Vec::new(),
            buses: Vec::new(),
            source_faders: [1.0; PRISM_CHANNELS / 2],
            source_mutes: [false; PRISM_CHANNELS / 2],
        }
    }
}

impl AudioGraph {
    /// Build graph from sends and bus_sends
    pub fn build(
        sends: &[SendCompact],
        bus_sends: &[BusSendCompact],
        buses: &[Bus],
        source_faders: [f32; PRISM_CHANNELS / 2],
        source_mutes: [bool; PRISM_CHANNELS / 2],
    ) -> Self {
        let mut edges = Vec::with_capacity(sends.len() + bus_sends.len());
        let mut nodes_set = std::collections::HashSet::new();

        // Process direct sends (Input -> Output)
        for send in sends.iter() {
            if !send.active {
                continue;
            }
            let pair_idx = (send.source_channel / 2) as u8;
            let source = NodeId::input(send.source_device, pair_idx);
            let target_pair = (send.target_channel / 2) as u8;
            let target = NodeId::output(send.target_device_hash, target_pair);

            nodes_set.insert(source);
            nodes_set.insert(target);

            edges.push(AudioEdge {
                source,
                target,
                gain: send.level,
                source_ch: (send.source_channel % 2) as u8,
                target_ch: (send.target_channel % 2) as u8,
                active: true,
            });
        }

        // Process bus sends
        for send in bus_sends.iter() {
            if !send.active {
                continue;
            }

            let source = if send.source_type == 0 {
                // Input -> Bus or Input -> Output
                let pair_idx = (send.source_channel / 2) as u8;
                NodeId::input(send.source_device, pair_idx)
            } else {
                // Bus -> Bus or Bus -> Output
                NodeId::bus(send.source_bus_idx)
            };

            let target = if send.target_type == 0 {
                // -> Bus
                NodeId::bus(send.target_bus_idx)
            } else {
                // -> Output
                let pair_idx = (send.target_channel / 2) as u8;
                NodeId::output(send.target_device_hash, pair_idx)
            };

            nodes_set.insert(source);
            nodes_set.insert(target);

            edges.push(AudioEdge {
                source,
                target,
                gain: send.level,
                source_ch: (send.source_channel % 2) as u8,
                target_ch: (send.target_channel % 2) as u8,
                active: true,
            });
        }

        // Topological sort using Kahn's algorithm
        let processing_order = Self::topological_sort(&nodes_set, &edges);

        Self {
            edges,
            processing_order,
            buses: buses.to_vec(),
            source_faders,
            source_mutes,
        }
    }

    /// Topological sort of nodes using Kahn's algorithm
    fn topological_sort(
        nodes: &std::collections::HashSet<NodeId>,
        edges: &[AudioEdge],
    ) -> Vec<NodeId> {
        use std::collections::VecDeque;

        // Build adjacency list and in-degree count
        let mut in_degree: HashMap<NodeId, usize> = HashMap::new();
        let mut adj: HashMap<NodeId, Vec<NodeId>> = HashMap::new();

        for node in nodes.iter() {
            in_degree.insert(*node, 0);
            adj.insert(*node, Vec::new());
        }

        for edge in edges.iter() {
            if !edge.active {
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

        // Initialize queue with nodes that have in-degree 0
        let mut queue: VecDeque<NodeId> = VecDeque::new();
        for (node, &deg) in in_degree.iter() {
            if deg == 0 {
                queue.push_back(*node);
            }
        }

        // Process queue
        let mut order = Vec::with_capacity(nodes.len());
        while let Some(node) = queue.pop_front() {
            order.push(node);

            if let Some(neighbors) = adj.get(&node) {
                for &neighbor in neighbors.iter() {
                    if let Some(deg) = in_degree.get_mut(&neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }

        // If not all nodes are in order, there's a cycle - add remaining nodes
        if order.len() < nodes.len() {
            for node in nodes.iter() {
                if !order.contains(node) {
                    order.push(*node);
                }
            }
        }

        order
    }

    /// Get all edges that target a specific node
    #[inline]
    pub fn edges_to(&self, target: NodeId) -> impl Iterator<Item = &AudioEdge> {
        self.edges.iter().filter(move |e| e.active && e.target == target)
    }
}

// ============================================================================
// Graph Processor - Processes audio through the graph
// ============================================================================

/// Global shared graph processor (single instance for all devices)
pub struct GraphProcessor {
    /// Node buffers indexed by NodeId
    node_buffers: HashMap<NodeId, NodeBuffer>,
    /// Temporary buffer for mixing
    temp_buffer: Box<[f32; MAX_FRAMES]>,
    /// Last processed sample counter
    last_processed_at: u64,
    /// Number of frames in the last processing
    last_frames: usize,
}

impl GraphProcessor {
    pub fn new() -> Self {
        Self {
            node_buffers: HashMap::with_capacity(64),
            temp_buffer: Box::new([0.0; MAX_FRAMES]),
            last_processed_at: 0,
            last_frames: 0,
        }
    }

    /// Check if already processed for this sample counter
    #[inline]
    pub fn is_processed(&self, sample_counter: u64) -> bool {
        self.last_processed_at == sample_counter && sample_counter > 0
    }

    /// Get or create a buffer for a node
    fn get_or_create_buffer(&mut self, node: NodeId) -> &mut NodeBuffer {
        self.node_buffers.entry(node).or_insert_with(NodeBuffer::new)
    }

    /// Process the audio graph for one frame (called once per sample_counter)
    /// Only processes Input and Bus nodes - Output nodes are filled in for ALL devices
    pub fn process(
        &mut self,
        graph: &AudioGraph,
        frames: usize,
        sample_counter: u64,
        read_input: impl Fn(u32, u8, &mut [f32], &mut [f32]) -> usize,
        process_bus_plugins: impl Fn(u8, &mut [f32], &mut [f32]),
    ) {
        // Skip if already processed
        if self.is_processed(sample_counter) {
            return;
        }

        let frames = frames.min(MAX_FRAMES);
        self.last_frames = frames;
        self.last_processed_at = sample_counter;

        // Process nodes in topological order
        for &node_id in graph.processing_order.iter() {
            // Clear the node buffer
            let buffer = self.get_or_create_buffer(node_id);
            buffer.clear(frames);

            if node_id.is_input() {
                // Input node: read from input device
                if let Some((device_id, pair_idx)) = node_id.input_info() {
                    // Check if muted
                    let muted = if (pair_idx as usize) < graph.source_mutes.len() {
                        graph.source_mutes[pair_idx as usize]
                    } else {
                        false
                    };

                    if !muted {
                        let buffer = self.get_or_create_buffer(node_id);
                        let count = read_input(
                            device_id,
                            pair_idx,
                            &mut buffer.left[..frames],
                            &mut buffer.right[..frames],
                        );
                        buffer.valid_frames = count;
                        buffer.processed_at = sample_counter;
                    }
                }
            } else if node_id.is_bus() {
                // Bus node: mix from all incoming edges, then apply plugins
                let bus_idx = node_id.bus_idx().unwrap_or(0);

                // Check if bus is muted
                let bus_muted = graph.buses.get(bus_idx as usize)
                    .map(|b| b.muted)
                    .unwrap_or(false);

                if !bus_muted {
                    // Mix from all sources
                    for edge in graph.edges_to(node_id) {
                        // First pass: calculate gain and copy source data to temp buffer
                        let (valid, gain, local_buffer) = {
                            let src_buf = match self.node_buffers.get(&edge.source) {
                                Some(buf) if buf.valid_frames > 0 => buf,
                                _ => continue,
                            };

                            // Get source fader if it's an input
                            let fader = if edge.source.is_input() {
                                if let Some((_, pair_idx)) = edge.source.input_info() {
                                    if (pair_idx as usize) < graph.source_faders.len() {
                                        graph.source_faders[pair_idx as usize]
                                    } else {
                                        1.0
                                    }
                                } else {
                                    1.0
                                }
                            } else if edge.source.is_bus() {
                                // Get bus fader
                                if let Some(src_bus_idx) = edge.source.bus_idx() {
                                    graph.buses.get(src_bus_idx as usize)
                                        .map(|b| b.fader)
                                        .unwrap_or(1.0)
                                } else {
                                    1.0
                                }
                            } else {
                                1.0
                            };

                            let gain = edge.gain * fader;
                            if gain < 0.0001 {
                                continue;
                            }

                            // Copy source data to local buffer (stack allocation)
                            let src_data = if edge.source_ch == 0 { &src_buf.left } else { &src_buf.right };
                            let valid = src_buf.valid_frames.min(frames);

                            // Copy to stack-local buffer to avoid borrow conflicts
                            let mut local_buffer = [0.0f32; MAX_FRAMES];
                            local_buffer[..valid].copy_from_slice(&src_data[..valid]);

                            (valid, gain, local_buffer)
                        };

                        // Second pass: mix from local buffer to target
                        if valid > 0 {
                            let buffer = self.get_or_create_buffer(node_id);
                            let dst = if edge.target_ch == 0 { &mut buffer.left } else { &mut buffer.right };

                            VDsp::mix_add(&local_buffer[..valid], gain, &mut dst[..valid]);
                            buffer.valid_frames = buffer.valid_frames.max(valid);
                        }
                    }

                    // Apply plugins
                    let buffer = self.get_or_create_buffer(node_id);
                    if buffer.valid_frames > 0 {
                        process_bus_plugins(bus_idx, &mut buffer.left[..frames], &mut buffer.right[..frames]);
                        buffer.processed_at = sample_counter;
                    }
                }
            } else if node_id.is_output() {
                // Output node: mix from all incoming edges (for ALL output devices)
                // Clear buffer first
                let buffer = self.get_or_create_buffer(node_id);
                buffer.clear(frames);

                // Mix from all sources
                for edge in graph.edges_to(node_id) {
                    // First pass: calculate gain and copy source data
                    let (valid, gain, local_buffer) = {
                        let src_buf = match self.node_buffers.get(&edge.source) {
                            Some(buf) if buf.valid_frames > 0 => buf,
                            _ => continue,
                        };

                        // Get source fader
                        let fader = if edge.source.is_input() {
                            if let Some((_, pair_idx)) = edge.source.input_info() {
                                if (pair_idx as usize) < graph.source_faders.len() {
                                    graph.source_faders[pair_idx as usize]
                                } else {
                                    1.0
                                }
                            } else {
                                1.0
                            }
                        } else if edge.source.is_bus() {
                            if let Some(src_bus_idx) = edge.source.bus_idx() {
                                graph.buses.get(src_bus_idx as usize)
                                    .map(|b| b.fader)
                                    .unwrap_or(1.0)
                            } else {
                                1.0
                            }
                        } else {
                            1.0
                        };

                        let gain = edge.gain * fader;
                        if gain < 0.0001 {
                            continue;
                        }

                        // Copy source data
                        let src_data = if edge.source_ch == 0 { &src_buf.left } else { &src_buf.right };
                        let valid = src_buf.valid_frames.min(frames);

                        let mut local_buffer = [0.0f32; MAX_FRAMES];
                        local_buffer[..valid].copy_from_slice(&src_data[..valid]);

                        (valid, gain, local_buffer)
                    };

                    // Second pass: mix to output buffer
                    if valid > 0 {
                        let buffer = self.get_or_create_buffer(node_id);
                        let dst = if edge.target_ch == 0 { &mut buffer.left } else { &mut buffer.right };

                        VDsp::mix_add(&local_buffer[..valid], gain, &mut dst[..valid]);
                        buffer.valid_frames = buffer.valid_frames.max(valid);
                        buffer.processed_at = sample_counter;
                    }
                }
            }
        }
    }

    /// Get the buffer for a node (for reading after processing)
    pub fn get_buffer(&self, node: NodeId) -> Option<&NodeBuffer> {
        self.node_buffers.get(&node)
    }

    /// Mix output from the graph to an interleaved output buffer
    pub fn mix_to_output(
        &self,
        graph: &AudioGraph,
        target_device_hash: u64,
        target_pair_idx: u8,
        output_buffer: &mut [f32],
        output_channels: usize,
        frames: usize,
    ) {
        let target = NodeId::output(target_device_hash, target_pair_idx);

        for edge in graph.edges_to(target) {
            if let Some(src_buf) = self.node_buffers.get(&edge.source) {
                if src_buf.valid_frames == 0 {
                    continue;
                }

                // Get source fader
                let fader = if edge.source.is_input() {
                    if let Some((_, pair_idx)) = edge.source.input_info() {
                        if (pair_idx as usize) < graph.source_faders.len() {
                            graph.source_faders[pair_idx as usize]
                        } else {
                            1.0
                        }
                    } else {
                        1.0
                    }
                } else if edge.source.is_bus() {
                    if let Some(bus_idx) = edge.source.bus_idx() {
                        graph.buses.get(bus_idx as usize)
                            .map(|b| b.fader)
                            .unwrap_or(1.0)
                    } else {
                        1.0
                    }
                } else {
                    1.0
                };

                let gain = edge.gain * fader;
                if gain < 0.0001 {
                    continue;
                }

                let src_data = if edge.source_ch == 0 { &src_buf.left } else { &src_buf.right };
                let valid = src_buf.valid_frames.min(frames);

                // Target channel in the output device
                let target_ch = (target_pair_idx as usize * 2) + edge.target_ch as usize;
                if target_ch < output_channels {
                    VDsp::mix_to_interleaved(
                        &src_data[..valid],
                        gain,
                        output_buffer,
                        target_ch,
                        output_channels,
                        valid,
                    );
                }
            }
        }
    }
}

/// Global single graph processor (shared by all output devices)
static GLOBAL_GRAPH_PROCESSOR: std::sync::LazyLock<Arc<RwLock<GraphProcessor>>> =
    std::sync::LazyLock::new(|| Arc::new(RwLock::new(GraphProcessor::new())));

/// Get the global graph processor
pub fn get_graph_processor() -> Arc<RwLock<GraphProcessor>> {
    Arc::clone(&GLOBAL_GRAPH_PROCESSOR)
}

// ============================================================================
// Pre-computed Output Buffers (for audio callbacks to read)
// ============================================================================

/// Ring buffer size for output (about 170ms at 48kHz)
const OUTPUT_RING_SIZE: usize = 8192;

/// Output ring buffer for a specific output device + pair
/// Uses atomic counters for lock-free SPSC (single producer, single consumer)
/// The counters track total samples written/read, actual position is counter % SIZE
pub struct OutputRingBuffer {
    left: UnsafeCell<Box<[f32; OUTPUT_RING_SIZE]>>,
    right: UnsafeCell<Box<[f32; OUTPUT_RING_SIZE]>>,
    /// Total samples written (monotonically increasing, wraps at usize::MAX)
    write_count: AtomicUsize,
    /// Total samples read (monotonically increasing, wraps at usize::MAX)
    read_count: AtomicUsize,
}

// SAFETY: SPSC ring buffer - producer only writes, consumer only reads
// The atomic counters ensure proper synchronization
unsafe impl std::marker::Send for OutputRingBuffer {}
unsafe impl std::marker::Sync for OutputRingBuffer {}

impl OutputRingBuffer {
    pub fn new() -> Self {
        Self {
            left: UnsafeCell::new(Box::new([0.0; OUTPUT_RING_SIZE])),
            right: UnsafeCell::new(Box::new([0.0; OUTPUT_RING_SIZE])),
            write_count: AtomicUsize::new(0),
            read_count: AtomicUsize::new(0),
        }
    }

    /// Write samples to the ring buffer (called by processing thread ONLY)
    /// Returns number of frames written
    /// SPSC: Only producer writes, never touches read_count
    pub fn write(&self, left: &[f32], right: &[f32]) -> usize {
        let frames = left.len().min(right.len());
        if frames == 0 {
            return 0;
        }
        
        let wc = self.write_count.load(Ordering::Relaxed);
        let rc = self.read_count.load(Ordering::Acquire);
        
        // Calculate available space
        let buffered = wc.wrapping_sub(rc);
        let max_buffer = OUTPUT_RING_SIZE - 1;
        let available_space = max_buffer.saturating_sub(buffered);
        
        // Only write what we have space for (never modify read_count!)
        let to_write = frames.min(available_space);
        
        if to_write == 0 {
            // Buffer full - skip this write (will cause audio glitch but maintains sync)
            return 0;
        }
        
        // SAFETY: Single producer, we own the write side
        let left_buf = unsafe { &mut *self.left.get() };
        let right_buf = unsafe { &mut *self.right.get() };
        
        let wp = wc % OUTPUT_RING_SIZE;
        for i in 0..to_write {
            let idx = (wp + i) % OUTPUT_RING_SIZE;
            left_buf[idx] = left[i];
            right_buf[idx] = right[i];
        }
        
        // Update write count with release semantics
        self.write_count.store(wc.wrapping_add(to_write), Ordering::Release);
        
        to_write
    }

    /// Read samples from the ring buffer (called by device callback ONLY)
    /// Returns the number of frames actually read
    pub fn read(&self, left_out: &mut [f32], right_out: &mut [f32]) -> usize {
        let frames = left_out.len().min(right_out.len());
        let rc = self.read_count.load(Ordering::Relaxed);
        let wc = self.write_count.load(Ordering::Acquire);
        
        // Available samples = written - read (using wrapping arithmetic)
        let available = wc.wrapping_sub(rc);
        
        // Sanity check: if available > SIZE, something is wrong
        let available = if available > OUTPUT_RING_SIZE {
            0 // Treat as empty
        } else {
            available
        };
        
        let to_read = frames.min(available);
        
        // SAFETY: Single consumer, we own the read side
        let left_buf = unsafe { &*self.left.get() };
        let right_buf = unsafe { &*self.right.get() };
        
        let rp = rc % OUTPUT_RING_SIZE;
        for i in 0..to_read {
            let idx = (rp + i) % OUTPUT_RING_SIZE;
            left_out[i] = left_buf[idx];
            right_out[i] = right_buf[idx];
        }
        
        // Zero-fill if not enough data (underrun)
        for i in to_read..frames {
            left_out[i] = 0.0;
            right_out[i] = 0.0;
        }
        
        // Update read count
        if to_read > 0 {
            self.read_count.store(rc.wrapping_add(to_read), Ordering::Release);
        }
        
        to_read
    }

    /// Get available samples for reading (data in buffer)
    pub fn available_read(&self) -> usize {
        let rc = self.read_count.load(Ordering::Relaxed);
        let wc = self.write_count.load(Ordering::Acquire);
        let available = wc.wrapping_sub(rc);
        if available > OUTPUT_RING_SIZE { 0 } else { available }
    }
    
    /// Get available space for writing (free slots in buffer)
    pub fn available_write(&self) -> usize {
        let wc = self.write_count.load(Ordering::Relaxed);
        let rc = self.read_count.load(Ordering::Acquire);
        let buffered = wc.wrapping_sub(rc);
        if buffered > OUTPUT_RING_SIZE { 
            OUTPUT_RING_SIZE - 1 // Treat as empty
        } else {
            (OUTPUT_RING_SIZE - 1).saturating_sub(buffered)
        }
    }
    
    /// Get current counters for debugging
    pub fn positions(&self) -> (usize, usize) {
        (self.write_count.load(Ordering::Relaxed), self.read_count.load(Ordering::Relaxed))
    }
}

impl Default for OutputRingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Output ring buffers indexed by (device_hash_8bit, pair_idx)
pub struct OutputRingBuffers {
    /// Ring buffers: device_hash_8bit -> Vec<OutputRingBuffer> for each pair
    buffers: HashMap<u64, Vec<OutputRingBuffer>>,
}

impl OutputRingBuffers {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::new(),
        }
    }

    /// Get or create ring buffer for a device pair
    pub fn get_or_create(&mut self, device_hash: u64, pair_idx: usize) -> &mut OutputRingBuffer {
        let pairs = self.buffers.entry(device_hash).or_insert_with(|| {
            (0..16).map(|_| OutputRingBuffer::new()).collect()
        });
        if pair_idx >= pairs.len() {
            pairs.resize_with(pair_idx + 1, OutputRingBuffer::new);
        }
        &mut pairs[pair_idx]
    }

    /// Get ring buffer for reading (immutable)
    pub fn get(&self, device_hash: u64, pair_idx: usize) -> Option<&OutputRingBuffer> {
        self.buffers.get(&device_hash)?.get(pair_idx)
    }
}

impl Default for OutputRingBuffers {
    fn default() -> Self {
        Self::new()
    }
}

/// Global output ring buffers (protected by RwLock for writes, but reads are lock-free via atomic positions)
pub static OUTPUT_RING_BUFFERS: std::sync::LazyLock<RwLock<OutputRingBuffers>> =
    std::sync::LazyLock::new(|| RwLock::new(OutputRingBuffers::new()));

/// Ensure ring buffer exists for a device/pair (call during setup, not in hot path)
pub fn ensure_output_ring_buffer(device_hash: u64, pair_idx: usize) {
    let mut buffers = OUTPUT_RING_BUFFERS.write();
    buffers.get_or_create(device_hash, pair_idx);
}

/// Get output ring buffers for writing (uses read lock since write() is &self)
pub fn get_output_ring_buffers() -> parking_lot::RwLockReadGuard<'static, OutputRingBuffers> {
    OUTPUT_RING_BUFFERS.read()
}

/// Read from output ring buffer (for device callback - lock-free after initial setup)
pub fn read_output_ring(device_hash: u64, pair_idx: usize, left: &mut [f32], right: &mut [f32]) -> usize {
    let buffers = OUTPUT_RING_BUFFERS.read();
    if let Some(ring) = buffers.get(device_hash, pair_idx) {
        let available_before = ring.available_read();
        let read = ring.read(left, right);
        let requested = left.len().min(right.len());
        
        // Log underruns (when we can't provide enough data)
        static LOG_COUNTER: AtomicU64 = AtomicU64::new(0);
        let count = LOG_COUNTER.fetch_add(1, Ordering::Relaxed);
        if count % 500 == 0 || (read < requested && read > 0) {
            println!("[OutputRing] READ dev={:x} pair={} req={} buffered={} read={}",
                device_hash, pair_idx, requested, available_before, read);
        }
        
        read
    } else {
        // No buffer yet, fill with zeros
        left.fill(0.0);
        right.fill(0.0);
        0
    }
}

/// Global sample counter for processing thread (DEPRECATED - used by old processing thread)
static PROCESSING_SAMPLE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Processing thread running flag (DEPRECATED - used by old processing thread)
static PROCESSING_RUNNING: std::sync::atomic::AtomicBool = 
    std::sync::atomic::AtomicBool::new(false);

// ============================================================================
// Shared Output Buffers (for multi-device sync)
// ============================================================================
// Graph processing writes to these shared buffers.
// Each device callback then copies from shared buffers to its own ring buffer
// at its own pace. This prevents fast devices from overrunning slow ones.

/// Shared output buffer for a single output node (device + pair)
/// Written by leader, read by individual device callbacks
pub struct SharedOutputEntry {
    pub left: [f32; MAX_FRAMES],
    pub right: [f32; MAX_FRAMES],
    pub valid_frames: usize,
    pub cycle_id: u64,
}

impl Default for SharedOutputEntry {
    fn default() -> Self {
        Self {
            left: [0.0; MAX_FRAMES],
            right: [0.0; MAX_FRAMES],
            valid_frames: 0,
            cycle_id: 0,
        }
    }
}

/// Container for all shared output buffers
/// Indexed by (device_hash_8bit, pair_idx)
pub struct SharedOutputBuffers {
    /// Storage indexed by hash (0-255)
    entries: Vec<Vec<UnsafeCell<SharedOutputEntry>>>,
    /// Current cycle that data is valid for
    cycle_id: AtomicU64,
}

// SAFETY: The leader writes while holding the processing lock.
// Readers only read after cycle_id is updated (with proper memory ordering).
unsafe impl std::marker::Send for SharedOutputBuffers {}
unsafe impl std::marker::Sync for SharedOutputBuffers {}

impl SharedOutputBuffers {
    pub fn new() -> Self {
        let mut entries = Vec::with_capacity(256);
        for _ in 0..256 {
            let mut pairs = Vec::with_capacity(MAX_OUTPUT_PAIRS);
            for _ in 0..MAX_OUTPUT_PAIRS {
                pairs.push(UnsafeCell::new(SharedOutputEntry::default()));
            }
            entries.push(pairs);
        }
        Self {
            entries,
            cycle_id: AtomicU64::new(0),
        }
    }

    /// Write data for a specific output (called by leader only)
    pub fn write(&self, hash8: u64, pair_idx: usize, left: &[f32], right: &[f32], cycle_id: u64) {
        if hash8 >= 256 || pair_idx >= MAX_OUTPUT_PAIRS {
            return;
        }
        
        let entry = unsafe { &mut *self.entries[hash8 as usize][pair_idx].get() };
        let frames = left.len().min(right.len()).min(MAX_FRAMES);
        entry.left[..frames].copy_from_slice(&left[..frames]);
        entry.right[..frames].copy_from_slice(&right[..frames]);
        entry.valid_frames = frames;
        entry.cycle_id = cycle_id;
    }

    /// Publish the cycle (called after all writes are done)
    pub fn publish_cycle(&self, cycle_id: u64) {
        self.cycle_id.store(cycle_id, Ordering::Release);
    }

    /// Get current published cycle
    pub fn get_published_cycle(&self) -> u64 {
        self.cycle_id.load(Ordering::Acquire)
    }

    /// Read data for a specific output (called by device callback)
    /// Returns None if data is not ready for current cycle
    pub fn read(&self, hash8: u64, pair_idx: usize, expected_cycle: u64) -> Option<(&[f32], &[f32], usize)> {
        if hash8 >= 256 || pair_idx >= MAX_OUTPUT_PAIRS {
            return None;
        }
        
        // Check if data is ready
        let published = self.cycle_id.load(Ordering::Acquire);
        if published < expected_cycle {
            return None; // Data not ready yet
        }
        
        let entry = unsafe { &*self.entries[hash8 as usize][pair_idx].get() };
        if entry.valid_frames == 0 {
            return None;
        }
        
        Some((&entry.left[..entry.valid_frames], &entry.right[..entry.valid_frames], entry.valid_frames))
    }
}

impl Default for SharedOutputBuffers {
    fn default() -> Self {
        Self::new()
    }
}

/// Global shared output buffers
static SHARED_OUTPUT_BUFFERS: std::sync::OnceLock<SharedOutputBuffers> = std::sync::OnceLock::new();

/// Get shared output buffers
pub fn get_shared_output_buffers() -> &'static SharedOutputBuffers {
    SHARED_OUTPUT_BUFFERS.get_or_init(|| SharedOutputBuffers::new())
}

// ============================================================================
// Dynamic Leader Synchronization (for multi-device audio callbacks)
// ============================================================================

/// Flag indicating whether the current cycle's processing is in progress
/// true = some callback is currently processing the graph
/// false = no callback is processing, next one can take leadership
static PROCESSING_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Sample counter for the last completed processing cycle
/// Followers use this to detect when the leader has finished
static LAST_COMPLETED_CYCLE: AtomicU64 = AtomicU64::new(0);

/// Current cycle counter (incremented when a leader starts processing)
static CURRENT_CYCLE: AtomicU64 = AtomicU64::new(0);

/// Try to become the leader for this processing cycle.
/// Returns Some(cycle_id) if this callback should process the graph (leader),
/// Returns None if another callback is already processing (follower).
/// 
/// Uses CAS (Compare-And-Swap) for lock-free race resolution.
#[inline]
pub fn try_start_processing() -> Option<u64> {
    // Try to set PROCESSING_IN_PROGRESS from false to true
    if PROCESSING_IN_PROGRESS.compare_exchange(
        false, true,
        Ordering::Acquire, Ordering::Relaxed
    ).is_ok() {
        // We won the race - become leader
        let cycle = CURRENT_CYCLE.fetch_add(1, Ordering::Relaxed);
        Some(cycle)
    } else {
        // Someone else is already processing
        None
    }
}

/// Called by the leader after finishing graph processing.
/// Releases the processing lock and updates the completed cycle counter.
#[inline]
pub fn finish_processing(cycle_id: u64) {
    // Update completed cycle counter first (so followers can see it)
    LAST_COMPLETED_CYCLE.store(cycle_id, Ordering::Release);
    // Then release the processing lock
    PROCESSING_IN_PROGRESS.store(false, Ordering::Release);
}

/// Get the last completed cycle ID.
/// Followers use this to check if their data is ready.
#[inline]
pub fn get_last_completed_cycle() -> u64 {
    LAST_COMPLETED_CYCLE.load(Ordering::Acquire)
}

/// Get the current cycle ID (what the leader is working on, or will work on next)
#[inline]
pub fn get_current_cycle() -> u64 {
    CURRENT_CYCLE.load(Ordering::Acquire)
}

/// Wait for processing to complete (for followers).
/// Returns true if processing completed within timeout, false if timed out.
/// 
/// Uses spin-wait with exponential backoff to minimize latency while avoiding CPU waste.
#[inline]
pub fn wait_for_processing(expected_cycle: u64, max_spins: u32) -> bool {
    let mut spins = 0u32;
    
    while spins < max_spins {
        // Check if the expected cycle (or later) has completed
        let completed = get_last_completed_cycle();
        if completed >= expected_cycle {
            return true;
        }
        
        // Check if no one is processing (leader might have bailed)
        if !PROCESSING_IN_PROGRESS.load(Ordering::Acquire) {
            // No leader active, we might become the leader on next try
            return false;
        }
        
        // Spin-wait with hint
        std::hint::spin_loop();
        spins += 1;
        
        // After 1000 spins, yield to OS
        if spins % 1000 == 0 {
            std::thread::yield_now();
        }
    }
    
    false // Timed out
}

/// Start the audio processing thread
pub fn start_processing_thread() {
    use std::sync::atomic::Ordering;
    
    if PROCESSING_RUNNING.swap(true, Ordering::SeqCst) {
        // Already running
        return;
    }

    std::thread::spawn(move || {
        println!("[Mixer] Processing thread started");
        
        // Base processing parameters
        let base_interval = std::time::Duration::from_micros(2000); // ~2ms base
        let base_frames = 512usize;
        let min_buffer_target = 2048usize; // Target minimum samples in buffer
        let max_frames_per_tick = 2048usize; // Max frames to process at once
        
        let mut frames_per_tick = base_frames;
        let mut interval = base_interval;

        while PROCESSING_RUNNING.load(Ordering::Relaxed) {
            let start = std::time::Instant::now();
            
            // Increment sample counter
            let sample_counter = PROCESSING_SAMPLE_COUNTER.fetch_add(1, Ordering::Relaxed);
            
            // Get mixer state
            let mixer_state = get_mixer_state();
            let snapshot = mixer_state.load_snapshot();
            let graph = &snapshot.audio_graph;
            
            if graph.processing_order.is_empty() {
                std::thread::sleep(interval);
                continue;
            }
            
            // Get processor
            let processor_arc = get_graph_processor();
            let mut processor = match processor_arc.try_write() {
                Some(p) => p,
                None => {
                    std::thread::sleep(std::time::Duration::from_micros(100));
                    continue;
                }
            };
            
            // Define input reader
            let read_input = |device_id: u32, pair_idx: u8, left: &mut [f32], right: &mut [f32]| -> usize {
                // Read from the primary output device's perspective (device 0 = any)
                crate::audio_capture::read_channel_audio_any(
                    pair_idx as usize * 2,
                    pair_idx as usize * 2 + 1,
                    left,
                    right,
                )
            };
            
            // Define plugin processor
            let au_manager = crate::audio_unit::get_au_manager();
            let buses = &graph.buses;
            let process_plugins = |bus_idx: u8, left: &mut [f32], right: &mut [f32]| {
                if let Some(bus) = buses.get(bus_idx as usize) {
                    if !bus.plugin_ids.is_empty() {
                        au_manager.process_chain(
                            &bus.plugin_ids,
                            left,
                            right,
                            0.0,
                        );
                    }
                }
            };
            
            // Process the graph
            processor.process(
                graph,
                frames_per_tick,
                sample_counter,
                read_input,
                process_plugins,
            );
            
            // Write output node buffers to ring buffers
            let mut min_available = usize::MAX;
            {
                let ring_buffers = OUTPUT_RING_BUFFERS.read();
                
                for &node_id in graph.processing_order.iter() {
                    if node_id.is_output() {
                        if let Some(buf) = processor.get_buffer(node_id) {
                            if buf.valid_frames == 0 {
                                continue;
                            }
                            
                            // Extract device hash from node_id
                            // NodeId format for output: 0x2000 | (hash8 << 4) | pair4
                            let hash8 = ((node_id.0 >> 4) & 0xFF) as u64;
                            let pair_idx = (node_id.0 & 0x0F) as usize;
                            
                            // Write to ring buffer (get() since write is &self now)
                            if let Some(ring) = ring_buffers.get(hash8, pair_idx) {
                                let (wp_before, rp_before) = ring.positions();
                                let written = ring.write(&buf.left[..buf.valid_frames], &buf.right[..buf.valid_frames]);
                                let (wp_after, rp_after) = ring.positions();
                                let buffered = ring.available_read();
                                min_available = min_available.min(buffered);
                                if sample_counter % 500 == 0 || written == 0 {
                                    println!("[OutputRing] WRITE dev={:x} pair={} frames={} written={} buffered={} wp:{}->{} rp:{}->{}",
                                        hash8, pair_idx, buf.valid_frames, written, buffered, 
                                        wp_before, wp_after, rp_before, rp_after);
                                }
                            }
                        }
                    }
                }
            }
            
            // Dynamic adjustment: if buffers are running low, process more frames next time
            if min_available < usize::MAX {
                if min_available < min_buffer_target / 2 {
                    // Buffer critically low - process more, faster
                    frames_per_tick = (frames_per_tick * 2).min(max_frames_per_tick);
                    interval = std::time::Duration::from_micros(1000); // 1ms
                } else if min_available < min_buffer_target {
                    // Buffer getting low - increase slightly
                    frames_per_tick = (frames_per_tick + 128).min(max_frames_per_tick);
                } else if min_available > min_buffer_target * 2 && frames_per_tick > base_frames {
                    // Buffer healthy - can reduce back towards base
                    frames_per_tick = (frames_per_tick - 64).max(base_frames);
                    interval = base_interval;
                }
            }
            
            // Also update bus metering
            for (bus_idx, bus) in graph.buses.iter().enumerate() {
                if bus.muted {
                    continue;
                }
                let node_id = NodeId::bus(bus_idx as u8);
                if let Some(buf) = processor.get_buffer(node_id) {
                    if buf.valid_frames > 0 {
                        let fader = bus.fader;
                        let left_rms = crate::vdsp::VDsp::rms(&buf.left[..frames_per_tick]) * fader;
                        let left_peak = crate::vdsp::VDsp::peak(&buf.left[..frames_per_tick]) * fader;
                        let right_rms = crate::vdsp::VDsp::rms(&buf.right[..frames_per_tick]) * fader;
                        let right_peak = crate::vdsp::VDsp::peak(&buf.right[..frames_per_tick]) * fader;
                        mixer_state.update_bus_level(bus_idx, left_rms, right_rms, left_peak, right_peak);
                    }
                }
            }
            
            // Sleep for remaining time
            let elapsed = start.elapsed();
            if elapsed < interval {
                std::thread::sleep(interval - elapsed);
            }
        }
        
        println!("[Mixer] Processing thread stopped");
    });
}

/// Stop the audio processing thread
pub fn stop_processing_thread() {
    PROCESSING_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Get the current processing sample counter
pub fn get_processing_sample_counter() -> u64 {
    PROCESSING_SAMPLE_COUNTER.load(Ordering::Relaxed)
}

// ============================================================================
// Original Mixer Types (kept for compatibility)
// ============================================================================

// Toggle verbose mixer logging. Set to `true` for debugging.
const MIXER_LOG: bool = false;

// Helper macro for conditional mixer logging
macro_rules! mlog {
    ($($arg:tt)*) => {
        if MIXER_LOG {
            println!($($arg)*);
        }
    }
}

/// A send connection from a source channel to an output device channel (1ch unit)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Send {
    /// Source device ID (0 = Prism, other = input device ID)
    pub source_device: u32,
    /// Source channel index (0-63 for Prism, or device channel index)
    pub source_channel: u32,
    /// Target output device ID
    pub target_device: String,
    /// Target channel index (0, 1, 2, ... for mono channels)
    pub target_channel: u32,
    /// Send level (0.0 to 1.0)
    pub level: f32,
    /// Muted
    pub muted: bool,
}

/// Source type for bus sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendSourceType {
    /// Source is a Prism/input device channel
    Input,
    /// Source is another bus
    Bus,
}

/// Target type for bus sends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BusSendTargetType {
    /// Target is a bus
    Bus,
    /// Target is an output device
    Output,
}

/// A send connection involving buses (for chaining)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusSend {
    /// Source type (Input or Bus)
    pub source_type: BusSendSourceType,
    /// Source ID (device_id for Input, bus_id string for Bus)
    pub source_id: String,
    /// Source device ID (only used when source_type is Input)
    pub source_device: u32,
    /// Source channel index
    pub source_channel: u32,
    /// Target type (Bus or Output)
    pub target_type: BusSendTargetType,
    /// Target ID (bus_id for Bus, device_id for Output)
    pub target_id: String,
    /// Target channel index
    pub target_channel: u32,
    /// Send level (0.0 to 1.0)
    pub level: f32,
    /// Muted
    pub muted: bool,
}

/// Compact bus send for audio callback
#[derive(Debug, Clone, Copy, Default)]
pub struct BusSendCompact {
    pub source_type: u8, // 0 = Input, 1 = Bus
    pub source_device: u32,
    pub source_channel: u32,
    pub source_bus_idx: u8, // Index into bus array (when source_type = Bus)
    pub target_type: u8, // 0 = Bus, 1 = Output
    pub target_bus_idx: u8, // Index into bus array (when target_type = Bus)
    pub target_device_hash: u64, // Hash of output device (when target_type = Output)
    pub target_channel: u32,
    pub level: f32,
    pub active: bool,
}

/// Bus definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bus {
    /// Bus identifier (e.g., "bus_1", "bus_2")
    pub id: String,
    /// Bus label/name
    pub label: String,
    /// Number of channels (typically 2 for stereo)
    pub channels: u32,
    /// Fader level (0.0 to 1.0)
    pub fader: f32,
    /// Muted
    pub muted: bool,
    /// Plugin chain (list of AudioUnit instance IDs in processing order)
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

/// Bus buffer for audio processing with cache support
pub struct BusBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
    /// Sample counter when this buffer was last processed (0 = never/invalid)
    pub processed_at: u64,
    /// Number of valid frames in the buffer
    pub valid_frames: usize,
}

impl BusBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
            processed_at: 0,
            valid_frames: 0,
        }
    }

    pub fn clear(&mut self, frames: usize) {
        for i in 0..frames.min(MAX_FRAMES) {
            self.left[i] = 0.0;
            self.right[i] = 0.0;
        }
        self.valid_frames = frames;
    }

    /// Check if this buffer is valid for the given sample counter
    #[inline]
    pub fn is_valid(&self, sample_counter: u64) -> bool {
        self.processed_at == sample_counter && self.valid_frames > 0
    }

    /// Mark this buffer as processed at the given sample counter
    #[inline]
    pub fn mark_processed(&mut self, sample_counter: u64, frames: usize) {
        self.processed_at = sample_counter;
        self.valid_frames = frames;
    }
}

impl Clone for BusBuffer {
    fn clone(&self) -> Self {
        let mut left = Box::new([0.0f32; MAX_FRAMES]);
        let mut right = Box::new([0.0f32; MAX_FRAMES]);
        let frames = self.valid_frames.min(MAX_FRAMES);
        left[..frames].copy_from_slice(&self.left[..frames]);
        right[..frames].copy_from_slice(&self.right[..frames]);
        Self {
            left,
            right,
            processed_at: self.processed_at,
            valid_frames: self.valid_frames,
        }
    }
}

/// Global sample counter for cache invalidation
/// Incremented each audio cycle by the first device to process
pub struct SampleCounter {
    counter: AtomicU64,
}

impl SampleCounter {
    pub fn new() -> Self {
        Self {
            counter: AtomicU64::new(1), // Start at 1, 0 means "never processed"
        }
    }

    /// Get current sample counter value
    #[inline]
    pub fn get(&self) -> u64 {
        self.counter.load(Ordering::Acquire)
    }

    /// Try to increment the counter (only one device per cycle succeeds)
    /// Returns (new_counter, true) if we incremented, (current, false) if someone else did
    #[inline]
    pub fn try_increment(&self) -> (u64, bool) {
        let current = self.counter.load(Ordering::Acquire);
        match self.counter.compare_exchange(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Relaxed
        ) {
            Ok(_) => (current + 1, true),
            Err(actual) => (actual, false),
        }
    }
}

/// Bus processing state - tracks which buses have been processed this cycle
pub struct BusProcessingState {
    /// Global sample counter
    sample_counter: SampleCounter,
}

impl BusProcessingState {
    pub fn new() -> Self {
        Self {
            sample_counter: SampleCounter::new(),
        }
    }

    /// Get the current sample counter value
    #[inline]
    pub fn get_sample_counter(&self) -> u64 {
        self.sample_counter.get()
    }

    /// Try to advance the sample counter to the next cycle
    /// Returns (counter, true) if this device started a new cycle
    /// Returns (counter, false) if another device already started this cycle
    #[inline]
    pub fn next_cycle(&self) -> (u64, bool) {
        self.sample_counter.try_increment()
    }
}

// ========== Lock-Free Double Buffer for Bus Processing ==========

/// Double buffer for lock-free bus audio processing.
/// - One device acquires processing lock (AtomicBool CAS)
/// - Processor writes to back buffer, then flips
/// - All devices read from front buffer (completely lock-free)
pub struct DoubleBufferBuses {
    /// Two sets of bus buffers
    buffers: [UnsafeCell<Vec<BusBuffer>>; 2],
    /// Current read index (0 or 1) - front buffer for reading
    read_index: std::sync::atomic::AtomicUsize,
    /// Processing lock - only one device can write at a time
    processing_lock: AtomicBool,
    /// Sample counter of the last completed write
    last_sample_counter: AtomicU64,
}

// SAFETY: DoubleBufferBuses is designed for lock-free concurrent access:
// - Only one thread can acquire processing_lock at a time (via CAS)
// - The processor writes to back buffer (1 - read_index)
// - All readers read from front buffer (read_index) which is immutable during processing
// - After processing, read_index is atomically swapped
unsafe impl std::marker::Send for DoubleBufferBuses {}
unsafe impl std::marker::Sync for DoubleBufferBuses {}

impl DoubleBufferBuses {
    pub fn new() -> Self {
        let create_buffers = || {
            let mut buffers = Vec::with_capacity(MAX_BUSES);
            for _ in 0..MAX_BUSES {
                buffers.push(BusBuffer::new());
            }
            UnsafeCell::new(buffers)
        };
        Self {
            buffers: [create_buffers(), create_buffers()],
            read_index: std::sync::atomic::AtomicUsize::new(0),
            processing_lock: AtomicBool::new(false),
            last_sample_counter: AtomicU64::new(0),
        }
    }

    /// Try to acquire processing lock (only one device can process per cycle).
    /// Returns true if this caller acquired the lock.
    #[inline]
    pub fn try_start_processing(&self) -> bool {
        self.processing_lock.compare_exchange(
            false,
            true,
            Ordering::AcqRel,
            Ordering::Relaxed
        ).is_ok()
    }

    /// Get mutable access to the back buffer (write buffer).
    /// SAFETY: Only call this after successfully acquiring processing lock via try_start_processing().
    #[inline]
    pub fn get_write_buffer(&self) -> &mut Vec<BusBuffer> {
        let write_index = 1 - self.read_index.load(Ordering::Acquire);
        // SAFETY: We hold the processing_lock, so no other thread is writing.
        // Readers only access read_index buffer.
        unsafe { &mut *self.buffers[write_index].get() }
    }

    /// Finish processing: flip buffers and release lock.
    /// Call this after writing to the back buffer.
    #[inline]
    pub fn finish_processing(&self, sample_counter: u64) {
        // Update sample counter before flipping
        self.last_sample_counter.store(sample_counter, Ordering::Release);
        // Flip: make back buffer the new front buffer
        let current = self.read_index.load(Ordering::Acquire);
        self.read_index.store(1 - current, Ordering::Release);
        // Release the processing lock
        self.processing_lock.store(false, Ordering::Release);
    }

    /// Get read-only access to the front buffer.
    /// This is completely lock-free - all devices can read simultaneously.
    #[inline]
    pub fn get_read_buffer(&self) -> &Vec<BusBuffer> {
        let read_index = self.read_index.load(Ordering::Acquire);
        // SAFETY: The front buffer is only read, never written while it's the front buffer.
        unsafe { &*self.buffers[read_index].get() }
    }

    /// Get the sample counter of the last completed processing cycle.
    #[inline]
    pub fn get_last_sample_counter(&self) -> u64 {
        self.last_sample_counter.load(Ordering::Acquire)
    }
}

// ========== Lock-Free Snapshot Structures ==========

/// Immutable snapshot of mixer state for audio callback
/// This is atomically swapped using ArcSwap for lock-free access
#[derive(Clone)]
pub struct MixerSnapshot {
    /// Direct sends (Input -> Output)
    pub sends: Vec<SendCompact>,
    /// Bus sends (compact form)
    pub bus_sends: Vec<BusSendCompact>,
    /// Bus definitions
    pub buses: Vec<Bus>,
    /// Pre-computed topological processing order (legacy - for bus-only order)
    pub processing_order: Vec<u8>,
    /// Source faders (per stereo pair)
    pub source_faders: [f32; PRISM_CHANNELS / 2],
    /// Source mutes (per stereo pair)
    pub source_mutes: [bool; PRISM_CHANNELS / 2],
    /// Unified audio graph for routing
    pub audio_graph: AudioGraph,
}

impl Default for MixerSnapshot {
    fn default() -> Self {
        Self {
            sends: Vec::new(),
            bus_sends: Vec::new(),
            buses: Vec::new(),
            processing_order: Vec::new(),
            source_faders: [1.0; PRISM_CHANNELS / 2],
            source_mutes: [false; PRISM_CHANNELS / 2],
            audio_graph: AudioGraph::default(),
        }
    }
}

/// Optimized send for audio callback (no String allocation)
#[derive(Debug, Clone, Copy, Default)]
pub struct SendCompact {
    pub source_device: u32,
    pub source_channel: u32,
    pub target_device_hash: u64,
    pub target_channel: u32,
    pub level: f32,
    pub active: bool, // true if not muted and level > 0
}

/// Level meters for a channel pair
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ChannelLevels {
    pub left_rms: f32,
    pub right_rms: f32,
    pub left_peak: f32,
    pub right_peak: f32,
}

/// Compact sends array for lock-free audio callback access
/// Uses double-buffering for lock-free reads in audio thread
pub struct SendsArray {
    /// Active sends (read by audio thread)
    sends: RwLock<Vec<SendCompact>>,
    /// Version counter for cache invalidation
    version: AtomicU64,
}

impl SendsArray {
    pub fn new() -> Self {
        Self {
            sends: RwLock::new(Vec::with_capacity(MAX_SENDS)),
            version: AtomicU64::new(0),
        }
    }

    /// Get current version
    #[inline]
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Read sends (for audio callback - fast path)
    #[inline]
    pub fn read(&self) -> parking_lot::RwLockReadGuard<'_, Vec<SendCompact>> {
        self.sends.read()
    }

    /// Try to read sends without blocking (for audio callback - non-blocking)
    #[inline]
    pub fn try_read(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<SendCompact>>> {
        self.sends.try_read()
    }

    /// Update sends from main thread
    pub fn update(&self, sends: &[Send], output_faders: &HashMap<String, f32>) {
        let mut compact = self.sends.write();
        compact.clear();

        for send in sends {
            if send.muted || send.level <= 0.0001 {
                continue;
            }

            let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
            let total_level = send.level * output_gain;

            if total_level <= 0.0001 {
                continue;
            }

            compact.push(SendCompact {
                source_device: send.source_device,
                source_channel: send.source_channel,
                target_device_hash: hash_device_id(&send.target_device),
                target_channel: send.target_channel,
                level: total_level,
                active: true,
            });
        }

        self.version.fetch_add(1, Ordering::Release);
    }
}

/// Bus sends array for audio callback
pub struct BusSendsArray {
    /// Bus definitions stored in fixed slots (slot index is stable)
    buses: RwLock<Vec<Bus>>,
    /// Bus ID to slot index mapping
    bus_id_to_idx: RwLock<HashMap<String, usize>>,
    /// Active bus sends (read by audio thread)
    sends: RwLock<Vec<BusSendCompact>>,
    /// Pre-computed processing order (Kahn's algorithm result)
    /// Contains bus indices in the order they should be processed
    processing_order: RwLock<Vec<u8>>,
    /// Version counter for cache invalidation
    version: AtomicU64,
}

impl BusSendsArray {
    pub fn new() -> Self {
        Self {
            // Pre-allocate fixed slots for buses. Empty slot == default Bus with empty id.
            buses: RwLock::new(vec![Bus::default(); MAX_BUSES]),
            bus_id_to_idx: RwLock::new(HashMap::new()),
            sends: RwLock::new(Vec::with_capacity(MAX_SENDS)),
            processing_order: RwLock::new(Vec::with_capacity(MAX_BUSES)),
            version: AtomicU64::new(0),
        }
    }

    /// Get current version
    #[inline]
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Read bus sends (for audio callback)
    #[inline]
    pub fn try_read_sends(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<BusSendCompact>>> {
        self.sends.try_read()
    }

    /// Read buses (for audio callback)
    #[inline]
    pub fn try_read_buses(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<Bus>>> {
        self.buses.try_read()
    }

    /// Read pre-computed processing order (for audio callback)
    #[inline]
    pub fn try_read_order(&self) -> Option<parking_lot::RwLockReadGuard<'_, Vec<u8>>> {
        self.processing_order.try_read()
    }

    /// Get bus count
    pub fn bus_count(&self) -> usize {
        // Number of active buses
        self.bus_id_to_idx.read().len()
    }

    /// Get bus index by ID
    pub fn get_bus_index(&self, bus_id: &str) -> Option<usize> {
        self.bus_id_to_idx.read().get(bus_id).copied()
    }

    /// Add a bus
    pub fn add_bus(&self, bus: Bus) {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();

        // Sanity: ignore empty id
        if bus.id.is_empty() {
            mlog!("[Mixer] add_bus called with empty id, ignoring");
            return;
        }

        // If id already present in map, update the existing slot (allow metadata updates)
        if let Some(&existing_idx) = id_map.get(&bus.id) {
            mlog!("[Mixer] add_bus: bus '{}' already present at slot {}, updating metadata", bus.id, existing_idx);
            if existing_idx < buses.len() {
                buses[existing_idx] = bus.clone();
                self.version.fetch_add(1, Ordering::Release);
            } else {
                mlog!("[Mixer] add_bus: existing index {} out of bounds, skipping update", existing_idx);
            }
            return;
        }

        // Extra safety: ensure no existing slot already contains this id
        if let Some(existing_idx) = buses.iter().position(|b| b.id == bus.id) {
            // If map was out-of-sync, repair it and update the slot with provided bus metadata
            mlog!("[Mixer] add_bus: found existing bus '{}' in slot {} but missing in id_map — repairing map and updating slot", bus.id, existing_idx);
            if existing_idx < buses.len() {
                buses[existing_idx] = bus.clone();
                id_map.insert(bus.id.clone(), existing_idx);
                self.version.fetch_add(1, Ordering::Release);
            } else {
                mlog!("[Mixer] add_bus: found slot {} out of bounds while repairing, ignoring", existing_idx);
            }
            return;
        }

        // If the provided id has a numeric suffix (bus_N), try to place it at slot N-1
        if let Some(num_str) = bus.id.strip_prefix("bus_") {
            if let Ok(n) = num_str.parse::<usize>() {
                if n >= 1 {
                    let target_idx = n - 1;
                    if target_idx < buses.len() {
                        // If the target slot is empty or already contains the same id, use it
                        if buses[target_idx].id.is_empty() || buses[target_idx].id == bus.id {
                            buses[target_idx] = bus.clone();
                            id_map.insert(bus.id.clone(), target_idx);
                            self.version.fetch_add(1, Ordering::Release);
                            mlog!("[Mixer] add_bus: placed '{}' into requested slot {}", bus.id, target_idx);
                            return;
                        } else {
                            mlog!("[Mixer] add_bus: requested slot {} for '{}' is occupied (contains '{}'), falling back to first free slot", target_idx, bus.id, buses[target_idx].id);
                        }
                    }
                }
            }
        }

        // Find first empty slot and insert
        if let Some(idx) = buses.iter().position(|b| b.id.is_empty()) {
            buses[idx] = bus.clone();
            id_map.insert(bus.id.clone(), idx);
            self.version.fetch_add(1, Ordering::Release);
        } else {
            mlog!("[Mixer] add_bus: no free bus slots available (MAX_BUSES={})", buses.len());
        }
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();
        let mut sends = self.sends.write();

        if let Some(idx) = id_map.remove(bus_id) {
            if idx >= buses.len() {
                mlog!("[Mixer] remove_bus: index {} out of bounds (len={}), ignoring", idx, buses.len());
                return;
            }

            // Clear the slot (leave indices of other slots stable)
            mlog!("[Mixer] remove_bus: removing '{}' at slot {}", bus_id, idx);
            buses[idx] = Bus::default();

            // Remove sends that reference this slot
            sends.retain(|send| {
                let source_ok = !(send.source_type == 1 && send.source_bus_idx as usize == idx);
                let target_ok = !(send.target_type == 0 && send.target_bus_idx as usize == idx);
                source_ok && target_ok
            });

            // Recompute processing order using fixed slots
            // Note: compute_processing_order will take its own read locks; we drop our local guards to avoid deadlocks
            drop(sends);
            drop(id_map);
            drop(buses);

            // Re-read sends and buses for computing order
            let sends_snapshot = self.sends.read().clone();
            let buses_snapshot_len = self.buses.read().len();
            self.compute_processing_order(&sends_snapshot, buses_snapshot_len);
            self.version.fetch_add(1, Ordering::Release);
        } else {
            mlog!("[Mixer] remove_bus: bus '{}' not found in id_map", bus_id);
        }
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                bus.fader = level;
            }
        }
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                bus.muted = muted;
            }
        }
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let mut buses = self.buses.write();
            if let Some(bus) = buses.get_mut(idx) {
                mlog!("[Mixer] Set bus {} plugins: {:?}", bus_id, plugin_ids);
                bus.plugin_ids = plugin_ids;
                self.version.fetch_add(1, Ordering::Release);
                if MIXER_LOG { println!("[Mixer] Set bus {} plugins applied", bus_id); }
            }
        }
    }

    /// Get bus plugin chain
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        let id_map = self.bus_id_to_idx.read();
        if let Some(&idx) = id_map.get(bus_id) {
            let buses = self.buses.read();
            if let Some(bus) = buses.get(idx) {
                return bus.plugin_ids.clone();
            }
        }
        Vec::new()
    }

    /// Get bus plugin chain by index (for audio callback)
    pub fn get_bus_plugins_by_idx(&self, bus_idx: usize) -> Vec<String> {
        let buses = self.buses.read();
        if bus_idx < buses.len() {
            let bus = &buses[bus_idx];
            return bus.plugin_ids.clone();
        }
        Vec::new()
    }

    /// Update bus sends from main thread
    pub fn update_sends(&self, bus_sends: &[BusSend], output_faders: &HashMap<String, f32>) {
        let id_map = self.bus_id_to_idx.read();
        let buses = self.buses.read();
        let mut compact = self.sends.write();
        compact.clear();

        for send in bus_sends {
            if send.muted || send.level <= 0.0001 {
                continue;
            }

            // Resolve source
            let (source_type, source_bus_idx) = match send.source_type {
                BusSendSourceType::Input => (0u8, 0u8),
                BusSendSourceType::Bus => {
                    if let Some(&idx) = id_map.get(&send.source_id) {
                        // Check if source bus is muted
                        if let Some(bus) = buses.get(idx) {
                            if bus.muted {
                                continue;
                            }
                        }
                        (1u8, idx as u8)
                    } else {
                        continue; // Unknown bus
                    }
                }
            };

            // Resolve target
            let (target_type, target_bus_idx, target_device_hash) = match send.target_type {
                BusSendTargetType::Bus => {
                    if let Some(&idx) = id_map.get(&send.target_id) {
                        (0u8, idx as u8, 0u64)
                    } else {
                        continue; // Unknown bus
                    }
                }
                BusSendTargetType::Output => {
                    let output_gain = output_faders.get(&send.target_id).copied().unwrap_or(1.0);
                    if output_gain <= 0.0001 {
                        continue;
                    }
                    (1u8, 0u8, hash_device_id(&send.target_id))
                }
            };

            compact.push(BusSendCompact {
                source_type,
                source_device: send.source_device,
                source_channel: send.source_channel,
                source_bus_idx,
                target_type,
                target_bus_idx,
                target_device_hash,
                target_channel: send.target_channel,
                level: send.level,
                active: true,
            });
        }

        // Compute topological order using Kahn's algorithm (consider only active slots)
        mlog!("[Mixer] update_sends complete, computing order for {} active slots, {} sends", id_map.len(), compact.len());
        self.compute_processing_order(&compact, buses.len());

        self.version.fetch_add(1, Ordering::Release);
    }

    /// Compute processing order using Kahn's algorithm
    /// This determines the order in which buses should be processed
    fn compute_processing_order(&self, sends: &[BusSendCompact], bus_count: usize) {
        let mut order = self.processing_order.write();
        order.clear();

        if bus_count == 0 {
            return;
        }

        // Step 1: Count in-degrees for each active bus (skip empty slots)
        let buses = self.buses.read();
        let mut active = vec![false; bus_count];
        let mut active_count = 0usize;
        for idx in 0..bus_count {
            if !buses[idx].id.is_empty() {
                active[idx] = true;
                active_count += 1;
            }
        }

        let mut in_degree = vec![0u8; bus_count];
        for send in sends.iter() {
            if send.active && send.source_type == 1 && send.target_type == 0 {
                let target_idx = send.target_bus_idx as usize;
                if target_idx < bus_count && active[target_idx] {
                    in_degree[target_idx] = in_degree[target_idx].saturating_add(1);
                }
            }
        }

        // Step 2: Initialize queue with active buses that have in-degree 0
        let mut queue: Vec<u8> = Vec::with_capacity(active_count);
        for idx in 0..bus_count {
            if active[idx] && in_degree[idx] == 0 {
                queue.push(idx as u8);
            }
        }

        // Step 3: Process the queue (Kahn's algorithm)
        let mut head = 0;
        while head < queue.len() {
            let current = queue[head] as usize;
            head += 1;

            order.push(current as u8);

            // Decrease in-degree for all buses this one feeds into
            for send in sends.iter() {
                if send.active && send.source_type == 1 && send.target_type == 0
                    && send.source_bus_idx as usize == current
                {
                    let target_idx = send.target_bus_idx as usize;
                    if target_idx < bus_count && active[target_idx] {
                        in_degree[target_idx] = in_degree[target_idx].saturating_sub(1);
                        if in_degree[target_idx] == 0 {
                            queue.push(target_idx as u8);
                        }
                    }
                }
            }
        }

        // Check for cycles (if not all active buses are in the order, there's a cycle)
        if order.len() != active_count {
            mlog!("[Mixer] Warning: Cycle detected in bus routing! Adding remaining active buses at end.");
            for idx in 0..bus_count {
                if active[idx] && !order.contains(&(idx as u8)) {
                    order.push(idx as u8);
                }
            }
        }

        mlog!("[Mixer] Computed bus processing order: {:?}", order.as_slice());
    }

    /// Add or update a bus send
    pub fn set_bus_send(&self, send: BusSend) {
        let id_map = self.bus_id_to_idx.read();
        let buses = self.buses.read();

        // Resolve indices
        let source_bus_idx = match send.source_type {
            BusSendSourceType::Bus => id_map.get(&send.source_id).copied(),
            _ => Some(0),
        };
        let target_bus_idx = match send.target_type {
            BusSendTargetType::Bus => id_map.get(&send.target_id).copied(),
            _ => Some(0),
        };

        if source_bus_idx.is_none() || target_bus_idx.is_none() {
            mlog!("[Mixer] Bus send references unknown bus: source_id={}, target_id={}", send.source_id, send.target_id);
            return;
        }

        // Check source bus mute (ensure slot active)
        if send.source_type == BusSendSourceType::Bus {
            if let Some(idx) = source_bus_idx {
                if idx < buses.len() {
                    if buses[idx].muted {
                        return;
                    }
                }
            }
        }

        let target_device_hash = match send.target_type {
            BusSendTargetType::Output => hash_device_id(&send.target_id),
            _ => 0,
        };

        let compact_send = BusSendCompact {
            source_type: match send.source_type {
                BusSendSourceType::Input => 0,
                BusSendSourceType::Bus => 1,
            },
            source_device: send.source_device,
            source_channel: send.source_channel,
            source_bus_idx: source_bus_idx.unwrap_or(0) as u8,
            target_type: match send.target_type {
                BusSendTargetType::Bus => 0,
                BusSendTargetType::Output => 1,
            },
            target_bus_idx: target_bus_idx.unwrap_or(0) as u8,
            target_device_hash,
            target_channel: send.target_channel,
            level: send.level,
            active: !send.muted && send.level > 0.0001,
        };

        let mut sends = self.sends.write();

        // Find existing send with same source and target
        if let Some(existing) = sends.iter_mut().find(|s| {
            s.source_type == compact_send.source_type
                && s.source_device == compact_send.source_device
                && s.source_channel == compact_send.source_channel
                && s.source_bus_idx == compact_send.source_bus_idx
                && s.target_type == compact_send.target_type
                && s.target_bus_idx == compact_send.target_bus_idx
                && s.target_device_hash == compact_send.target_device_hash
                && s.target_channel == compact_send.target_channel
        }) {
            existing.level = compact_send.level;
            existing.active = compact_send.active;
        } else {
            sends.push(compact_send);
        }

        // Recompute processing order using fixed slots
        self.compute_processing_order(&sends, buses.len());

        drop(sends);
        drop(buses);
        drop(id_map);

        self.version.fetch_add(1, Ordering::Release);
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
        let id_map = self.bus_id_to_idx.read();

        let source_bus_idx = match source_type {
            BusSendSourceType::Bus => id_map.get(source_id).copied().unwrap_or(255) as u8,
            _ => 0,
        };
        let target_bus_idx = match target_type {
            BusSendTargetType::Bus => id_map.get(target_id).copied().unwrap_or(255) as u8,
            _ => 0,
        };
        let target_device_hash = match target_type {
            BusSendTargetType::Output => hash_device_id(target_id),
            _ => 0,
        };

        let src_type = match source_type {
            BusSendSourceType::Input => 0u8,
            BusSendSourceType::Bus => 1u8,
        };
        let tgt_type = match target_type {
            BusSendTargetType::Bus => 0u8,
            BusSendTargetType::Output => 1u8,
        };

        let mut sends = self.sends.write();
        sends.retain(|s| {
            !(s.source_type == src_type
                && s.source_device == source_device
                && s.source_channel == source_channel
                && s.source_bus_idx == source_bus_idx
                && s.target_type == tgt_type
                && s.target_bus_idx == target_bus_idx
                && s.target_device_hash == target_device_hash
                && s.target_channel == target_channel)
        });

        // Recompute processing order
        let buses = self.buses.read();
        self.compute_processing_order(&sends, buses.len());

        self.version.fetch_add(1, Ordering::Release);
    }

    /// Get all buses
    pub fn get_buses(&self) -> Vec<Bus> {
        self.buses.read().clone()
    }

    /// Get all bus sends
    pub fn get_bus_sends_compact(&self) -> Vec<BusSendCompact> {
        self.sends.read().clone()
    }

    /// Reserve the first available bus slot and return a generated bus id (e.g. "bus_1").
    /// This also marks the slot as used with a default Bus so concurrent callers
    /// won't allocate the same slot.
    pub fn reserve_bus_id(&self) -> Option<String> {
        let mut buses = self.buses.write();
        let mut id_map = self.bus_id_to_idx.write();

        if let Some(idx) = buses.iter().position(|b| b.id.is_empty()) {
            let id = format!("bus_{}", idx + 1);
            buses[idx].id = id.clone();
            id_map.insert(id.clone(), idx);
            self.version.fetch_add(1, Ordering::Release);
            if MIXER_LOG { println!("[Mixer] reserve_bus_id: reserved '{}' at slot {}", id, idx); }
            return Some(id);
        }
        if MIXER_LOG { println!("[Mixer] reserve_bus_id: no free slots"); }
        None
    }
}

/// Fast hash for device ID string (for audio callback comparison)
#[inline]
pub fn hash_device_id(device_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    device_id.hash(&mut hasher);
    hasher.finish()
}

/// Pre-allocated buffer for one source pair (stereo)
pub struct PairBuffer {
    pub left: Box<[f32; MAX_FRAMES]>,
    pub right: Box<[f32; MAX_FRAMES]>,
}

impl PairBuffer {
    pub fn new() -> Self {
        Self {
            left: Box::new([0.0; MAX_FRAMES]),
            right: Box::new([0.0; MAX_FRAMES]),
        }
    }
}

/// Buffer pool for an output device
/// Grows dynamically when new source pairs are routed to this device
pub struct OutputBufferPool {
    /// Buffers indexed by cache slot
    buffers: Vec<PairBuffer>,
    /// Map from (source_device, pair_idx) to buffer index
    pair_to_buffer: HashMap<(u32, usize), usize>,
}

impl OutputBufferPool {
    pub fn new() -> Self {
        Self {
            buffers: Vec::new(),
            pair_to_buffer: HashMap::new(),
        }
    }

    /// Get or allocate buffer for a source pair
    /// Returns buffer index
    pub fn get_or_allocate(&mut self, source_device: u32, pair_idx: usize) -> usize {
        let key = (source_device, pair_idx);
        if let Some(&idx) = self.pair_to_buffer.get(&key) {
            return idx;
        }
        // Allocate new buffer
        let idx = self.buffers.len();
        self.buffers.push(PairBuffer::new());
        self.pair_to_buffer.insert(key, idx);
        idx
    }

    /// Get buffer by index (for audio callback)
    #[inline]
    pub fn get_buffer(&self, idx: usize) -> Option<&PairBuffer> {
        self.buffers.get(idx)
    }

    /// Get mutable buffer by index (for audio callback)
    #[inline]
    pub fn get_buffer_mut(&mut self, idx: usize) -> Option<&mut PairBuffer> {
        self.buffers.get_mut(idx)
    }

    /// Find buffer index for a source pair (for audio callback - no allocation)
    #[inline]
    pub fn find_buffer(&self, source_device: u32, pair_idx: usize) -> Option<usize> {
        self.pair_to_buffer.get(&(source_device, pair_idx)).copied()
    }

    /// Number of allocated buffers
    pub fn len(&self) -> usize {
        self.buffers.len()
    }
}

/// Global buffer pools for each output device
static OUTPUT_BUFFER_POOLS: std::sync::LazyLock<RwLock<HashMap<u64, Arc<RwLock<OutputBufferPool>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Per-device bus buffer pools (each device processes buses independently)
static DEVICE_BUS_BUFFERS: std::sync::LazyLock<RwLock<HashMap<u64, Arc<RwLock<Vec<BusBuffer>>>>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Get or create bus buffers for a specific output device
pub fn get_device_bus_buffers(device_id: u64) -> Arc<RwLock<Vec<BusBuffer>>> {
    // Try read first
    {
        let buffers = DEVICE_BUS_BUFFERS.read();
        if let Some(buf) = buffers.get(&device_id) {
            return Arc::clone(buf);
        }
    }
    // Create new buffer set
    let mut buffers = DEVICE_BUS_BUFFERS.write();
    buffers.entry(device_id)
        .or_insert_with(|| {
            let mut bufs = Vec::with_capacity(MAX_BUSES);
            for _ in 0..MAX_BUSES {
                bufs.push(BusBuffer::new());
            }
            Arc::new(RwLock::new(bufs))
        })
        .clone()
}

/// Get or create buffer pool for an output device
pub fn get_output_buffer_pool(device_id: u64) -> Arc<RwLock<OutputBufferPool>> {
    // Try read first
    {
        let pools = OUTPUT_BUFFER_POOLS.read();
        if let Some(pool) = pools.get(&device_id) {
            return Arc::clone(pool);
        }
    }
    // Create new pool
    let mut pools = OUTPUT_BUFFER_POOLS.write();
    pools.entry(device_id)
        .or_insert_with(|| Arc::new(RwLock::new(OutputBufferPool::new())))
        .clone()
}

/// Pre-allocate buffers for an output device based on sends
/// Call this when routing changes
pub fn allocate_buffers_for_output(device_id: u64, device_id_str: &str, sends: &[Send]) {
    let pool = get_output_buffer_pool(device_id);
    let mut pool = pool.write();
    let target_hash = hash_device_id(device_id_str);

    // Find all unique source pairs targeting this device
    for send in sends {
        if send.muted {
            continue;
        }
        let send_target_hash = hash_device_id(&send.target_device);
        if send_target_hash != target_hash {
            continue;
        }
        let pair_idx = send.source_channel as usize / 2;
        pool.get_or_allocate(send.source_device, pair_idx);
    }
}

/// Global mixer state shared between audio thread and UI
pub struct MixerState {
    /// Send connections (source -> target mappings) - for UI
    pub sends: RwLock<Vec<Send>>,
    /// Compact sends for audio callback (lock-free read)
    pub sends_compact: SendsArray,
    /// Bus sends for routing via buses
    pub bus_sends: BusSendsArray,
    /// Bus buffers for audio processing (indexed by bus index)
    pub bus_buffers: RwLock<Vec<BusBuffer>>,
    /// Lock-free double buffer for bus processing
    pub double_buffer: DoubleBufferBuses,
    /// Bus processing state - ensures buses are processed exactly once per audio cycle
    pub bus_processing: BusProcessingState,
    /// Master fader for each Prism channel pair (0.0 to 1.0)
    pub source_faders: RwLock<[f32; PRISM_CHANNELS / 2]>,
    /// Mute state for each source channel pair
    pub source_mutes: RwLock<[bool; PRISM_CHANNELS / 2]>,
    /// Master fader for each output device (device_id -> level)
    pub output_faders: RwLock<HashMap<String, f32>>,
    /// Current input levels (from Prism)
    pub input_levels: RwLock<[ChannelLevels; PRISM_CHANNELS / 2]>,
    /// Current output levels (per device per pair)
    pub output_levels: RwLock<HashMap<String, Vec<ChannelLevels>>>,
    /// Bus levels (post-plugin, post-fader) - indexed by bus index
    pub bus_levels: RwLock<[ChannelLevels; MAX_BUSES]>,
    /// Sample rate
    pub sample_rate: RwLock<u32>,
    /// Buffer size
    pub buffer_size: RwLock<u32>,

    // ========== Lock-Free Snapshot for Audio Callback ==========
    /// Atomically swappable snapshot for lock-free audio callback access
    pub snapshot: ArcSwap<MixerSnapshot>,
    /// Processed bus buffers produced by the master output for lock-free reads
    pub processed_bus_buffers: ArcSwap<Vec<BusBuffer>>,
}

impl Default for MixerState {
    fn default() -> Self {
        Self::new()
    }
}

impl MixerState {
    pub fn new() -> Self {
        Self {
            sends: RwLock::new(Vec::new()),
            sends_compact: SendsArray::new(),
            bus_sends: BusSendsArray::new(),
            // Pre-allocate bus buffers for fixed slots
            bus_buffers: RwLock::new((0..MAX_BUSES).map(|_| BusBuffer::new()).collect()),
            double_buffer: DoubleBufferBuses::new(),
            bus_processing: BusProcessingState::new(),
            source_faders: RwLock::new([1.0; PRISM_CHANNELS / 2]),
            source_mutes: RwLock::new([false; PRISM_CHANNELS / 2]),
            output_faders: RwLock::new(HashMap::new()),
            input_levels: RwLock::new([ChannelLevels::default(); PRISM_CHANNELS / 2]),
            output_levels: RwLock::new(HashMap::new()),
            bus_levels: RwLock::new([ChannelLevels::default(); MAX_BUSES]),
            sample_rate: RwLock::new(48000),
            buffer_size: RwLock::new(128),
            snapshot: ArcSwap::from_pointee(MixerSnapshot::default()),
            processed_bus_buffers: ArcSwap::from_pointee((0..MAX_BUSES).map(|_| BusBuffer::new()).collect()),
        }
    }

    /// Rebuild the lock-free snapshot (call after any routing/fader change)
    pub fn rebuild_snapshot(&self) {
        let sends_compact = self.sends_compact.try_read()
            .map(|s| s.clone())
            .unwrap_or_default();
        let bus_sends = self.bus_sends.try_read_sends()
            .map(|s| s.clone())
            .unwrap_or_default();
        let buses = self.bus_sends.try_read_buses()
            .map(|b| b.clone())
            .unwrap_or_default();
        let processing_order = self.bus_sends.try_read_order()
            .map(|o| o.clone())
            .unwrap_or_default();
        let source_faders = self.source_faders.read().clone();
        let source_mutes = self.source_mutes.read().clone();

        // Build unified audio graph
        let audio_graph = AudioGraph::build(
            &sends_compact,
            &bus_sends,
            &buses,
            source_faders,
            source_mutes,
        );

        let new_snapshot = MixerSnapshot {
            sends: sends_compact,
            bus_sends,
            buses,
            processing_order,
            source_faders,
            source_mutes,
            audio_graph,
        };

        self.snapshot.store(Arc::new(new_snapshot));
    }

    /// Get lock-free snapshot for audio callback
    #[inline]
    pub fn load_snapshot(&self) -> arc_swap::Guard<Arc<MixerSnapshot>> {
        self.snapshot.load()
    }

    /// Store processed bus buffers (called by master output thread after processing)
    pub fn store_processed_bus_buffers(&self, buffers: Vec<BusBuffer>) {
        self.processed_bus_buffers.store(Arc::new(buffers));
    }

    /// Load processed bus buffers snapshot for lock-free reads
    pub fn load_processed_bus_buffers(&self) -> arc_swap::Guard<Arc<Vec<BusBuffer>>> {
        self.processed_bus_buffers.load()
    }

    /// Rebuild compact sends array (call after any send/fader change)
    fn rebuild_compact_sends(&self) {
        let sends = self.sends.read();
        let output_faders = self.output_faders.read();
        self.sends_compact.update(&sends, &output_faders);

        // Pre-allocate buffers for all output devices
        // Collect unique target devices first
        use std::collections::HashSet;
        let mut target_devices: HashSet<(u64, String)> = HashSet::new();
        for send in sends.iter() {
            if !send.muted && send.level > 0.0001 {
                target_devices.insert((hash_device_id(&send.target_device), send.target_device.clone()));
            }
        }

        // Allocate buffers for each target device
        for (device_hash, device_id) in target_devices {
            allocate_buffers_for_output(device_hash, &device_id, &sends);
        }

        // Rebuild lock-free snapshot
        self.rebuild_snapshot();
    }

    /// Add or update a send (1ch unit)
    pub fn set_send(&self, send: Send) {
        {
            let mut sends = self.sends.write();
            // Find existing send with same source device/channel and target device/channel
            if let Some(existing) = sends.iter_mut().find(|s| {
                s.source_device == send.source_device
                    && s.source_channel == send.source_channel
                    && s.target_device == send.target_device
                    && s.target_channel == send.target_channel
            }) {
                println!("[Mixer] Updated send: src_dev={} src_ch={} -> dev={} tgt_ch={} level={} muted={}",
                    send.source_device, send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
                existing.level = send.level;
                existing.muted = send.muted;
            } else {
                println!("[Mixer] New send: src_dev={} src_ch={} -> dev={} tgt_ch={} level={} muted={}",
                    send.source_device, send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
                sends.push(send);
            }
            println!("[Mixer] Total sends: {}", sends.len());
        }
        // Rebuild compact sends for audio callback
        self.rebuild_compact_sends();
    }

    /// Remove a send (1ch unit)
    pub fn remove_send(&self, source_device: u32, source_channel: u32, target_device: &str, target_channel: u32) {
        {
            let mut sends = self.sends.write();
            sends.retain(|s| {
                !(s.source_device == source_device
                    && s.source_channel == source_channel
                    && s.target_device == target_device
                    && s.target_channel == target_channel)
            });
        }
        self.rebuild_compact_sends();
    }

    /// Set source fader level (0-100 -> 0.0-1.0)
    pub fn set_source_fader(&self, pair_index: usize, level: f32) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_faders.write()[pair_index] = (level / 100.0).clamp(0.0, 1.0);
            self.rebuild_snapshot();
        }
    }

    /// Set source mute
    pub fn set_source_mute(&self, pair_index: usize, muted: bool) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_mutes.write()[pair_index] = muted;
            self.rebuild_snapshot();
        }
    }

    /// Set output master fader (dB value: -inf to +6)
    pub fn set_output_fader(&self, device_id: &str, db: f32) {
        // Convert dB to linear gain
        let gain = if db <= -100.0 {
            0.0
        } else {
            10.0_f32.powf(db / 20.0).clamp(0.0, 2.0) // +6dB = ~2.0 linear
        };
        {
            self.output_faders
                .write()
                .insert(device_id.to_string(), gain);
        }
        // Rebuild compact sends to include new fader value
        self.rebuild_compact_sends();
    }

    /// Get all sends
    pub fn get_sends(&self) -> Vec<Send> {
        self.sends.read().clone()
    }

    /// Get input levels
    pub fn get_input_levels(&self) -> [ChannelLevels; PRISM_CHANNELS / 2] {
        *self.input_levels.read()
    }

    /// Get output levels for a device/pair key
    /// key format: "{device_id}_{pair_idx}"
    pub fn get_output_levels(&self, device_key: &str) -> Vec<ChannelLevels> {
        self.output_levels
            .read()
            .get(device_key)
            .cloned()
            .unwrap_or_default()
    }

    /// Update output levels for a virtual device pair
    /// device_key: unique identifier in format "{device_id}_{pair_idx}"
    /// - device_id: the actual audio device ID (aggregate ID if sub-device)
    /// - pair_idx: stereo pair index (0, 1, 2, ... calculated from channelOffset / 2)
    /// levels: vector of ChannelLevels for this stereo pair
    pub fn update_output_levels(&self, device_key: &str, levels: Vec<ChannelLevels>) {
        self.output_levels.write().insert(device_key.to_string(), levels);
    }

    // ========== Bus Operations ==========

    /// Add a bus
    pub fn add_bus(&self, id: String, label: String, channels: u32) {
        let bus = Bus {
            id: id.clone(),
            label,
            channels,
            fader: 1.0,
            muted: false,
            plugin_ids: Vec::new(),
        };
        self.bus_sends.add_bus(bus);
        // Ensure bus buffer slot exists (already pre-allocated)
        self.rebuild_snapshot();
        println!("[Mixer] Added bus: {}", id);
    }

    /// Reserve a bus id (allocates a slot and returns the id) for frontends
    pub fn reserve_bus_id(&self) -> Option<String> {
        self.bus_sends.reserve_bus_id()
    }

    /// Remove a bus
    pub fn remove_bus(&self, bus_id: &str) {
        if let Some(idx) = self.bus_sends.get_bus_index(bus_id) {
            self.bus_sends.remove_bus(bus_id);
            // Clear bus buffer at slot
            let mut buffers = self.bus_buffers.write();
            if idx < buffers.len() {
                buffers[idx].clear(0);
            }
            drop(buffers);

            self.rebuild_snapshot();
            println!("[Mixer] Removed bus: {}", bus_id);
        }
    }

    /// Set bus fader
    pub fn set_bus_fader(&self, bus_id: &str, level: f32) {
        self.bus_sends.set_bus_fader(bus_id, level.clamp(0.0, 1.0));
        self.rebuild_snapshot();
    }

    /// Set bus mute
    pub fn set_bus_mute(&self, bus_id: &str, muted: bool) {
        self.bus_sends.set_bus_mute(bus_id, muted);
        self.rebuild_snapshot();
    }

    /// Set bus plugin chain
    pub fn set_bus_plugins(&self, bus_id: &str, plugin_ids: Vec<String>) {
        self.bus_sends.set_bus_plugins(bus_id, plugin_ids);
        self.rebuild_snapshot();
    }

    /// Get bus plugin chain
    pub fn get_bus_plugins(&self, bus_id: &str) -> Vec<String> {
        self.bus_sends.get_bus_plugins(bus_id)
    }

    /// Add or update a bus send (Input/Bus -> Bus/Output)
    pub fn set_bus_send(&self, send: BusSend) {
        println!("[Mixer] Bus send: {:?} {} ch{} -> {:?} {} ch{} level={}",
            send.source_type, send.source_id, send.source_channel,
            send.target_type, send.target_id, send.target_channel, send.level);
        self.bus_sends.set_bus_send(send);
        self.rebuild_snapshot();
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
        self.bus_sends.remove_bus_send(
            source_type, source_id, source_device, source_channel,
            target_type, target_id, target_channel,
        );
        self.rebuild_snapshot();
    }

    /// Get all buses
    pub fn get_buses(&self) -> Vec<Bus> {
        // For UI we want a compact list of active buses (skip empty slots).
        self.bus_sends.get_buses()
            .into_iter()
            .filter(|b| !b.id.is_empty())
            .collect()
    }

    /// Get bus sends for debugging
    pub fn get_bus_sends(&self) -> Vec<BusSendCompact> {
        self.bus_sends.get_bus_sends_compact()
    }

    /// Update bus levels (called from audio callback after plugin processing)
    pub fn update_bus_level(&self, bus_idx: usize, left_rms: f32, right_rms: f32, left_peak: f32, right_peak: f32) {
        if let Some(mut levels) = self.bus_levels.try_write() {
            if bus_idx < MAX_BUSES {
                levels[bus_idx] = ChannelLevels {
                    left_rms,
                    right_rms,
                    left_peak,
                    right_peak,
                };
            }
        }
    }

    /// Get bus levels (for UI)
    pub fn get_bus_levels(&self) -> Vec<(String, ChannelLevels)> {
        // We must map each bus to its fixed slot index and read the level
        // from `bus_levels` using that slot. Use the compact active list
        // returned by `get_buses()` so ordering matches the UI.
        let buses = self.get_buses();
        let levels = self.bus_levels.read();

        let mut out: Vec<(String, ChannelLevels)> = Vec::with_capacity(buses.len());
        for bus in buses.iter() {
            if let Some(idx) = self.bus_sends.get_bus_index(&bus.id) {
                if idx < MAX_BUSES {
                    out.push((bus.id.clone(), levels[idx]));
                } else {
                    out.push((bus.id.clone(), ChannelLevels::default()));
                }
            } else {
                out.push((bus.id.clone(), ChannelLevels::default()));
            }
        }
        out
    }
}

/// Audio processing buffer for mixing
pub struct MixBuffer {
    /// Stereo interleaved buffer
    pub data: Vec<f32>,
    /// Number of frames
    pub frames: usize,
}

impl MixBuffer {
    pub fn new(frames: usize) -> Self {
        Self {
            data: vec![0.0; frames * 2],
            frames,
        }
    }

    pub fn clear(&mut self) {
        VDsp::clear(&mut self.data);
    }

    pub fn left(&self) -> impl Iterator<Item = f32> + '_ {
        self.data.iter().step_by(2).copied()
    }

    pub fn right(&self) -> impl Iterator<Item = f32> + '_ {
        self.data.iter().skip(1).step_by(2).copied()
    }

    pub fn left_slice(&self) -> Vec<f32> {
        self.left().collect()
    }

    pub fn right_slice(&self) -> Vec<f32> {
        self.right().collect()
    }
}

/// Process audio mixing for one buffer (1ch unit)
///
/// This is called from the audio callback and performs the actual mixing
/// using Accelerate vDSP for hardware acceleration.
pub fn process_mix(
    input_channels: &[&[f32]; PRISM_CHANNELS],
    output_buffers: &mut HashMap<String, Vec<f32>>,
    state: &MixerState,
    frames: usize,
) {
    let sends = state.sends.read();
    let faders = *state.source_faders.read();
    let mutes = *state.source_mutes.read();
    let output_faders = state.output_faders.read();

    // Clear all output buffers
    for buf in output_buffers.values_mut() {
        VDsp::clear(buf);
    }

    // Process each send (1ch unit)
    for send in sends.iter() {
        if send.muted {
            continue;
        }

        let source_ch = send.source_channel as usize;
        if source_ch >= PRISM_CHANNELS {
            continue;
        }

        // Check if source pair is muted (still use pair-based mute for compatibility)
        let pair_index = source_ch / 2;
        if mutes[pair_index] {
            continue;
        }

        let input = input_channels[source_ch];

        // Calculate combined gain
        let source_gain = faders[pair_index];
        let send_gain = send.level;
        let output_gain = output_faders.get(&send.target_device).copied().unwrap_or(1.0);
        let total_gain = source_gain * send_gain * output_gain;

        if total_gain < 0.0001 {
            continue;
        }

        // Get output buffer and mix to target channel
        if let Some(output_buf) = output_buffers.get_mut(&send.target_device) {
            let target_ch = send.target_channel as usize;
            let output_channels = output_buf.len() / frames;

            if target_ch < output_channels {
                let offset = target_ch * frames;
                let out = &mut output_buf[offset..offset + frames];
                VDsp::mix_add(input, total_gain, out);
            }
        }
    }
}

/// Calculate levels for input channels
pub fn calculate_input_levels(
    input_channels: &[&[f32]; PRISM_CHANNELS],
    state: &MixerState,
) {
    let mut levels = state.input_levels.write();

    for pair in 0..(PRISM_CHANNELS / 2) {
        let left_ch = pair * 2;
        let right_ch = left_ch + 1;

        levels[pair] = ChannelLevels {
            left_rms: VDsp::rms(input_channels[left_ch]),
            right_rms: VDsp::rms(input_channels[right_ch]),
            left_peak: VDsp::peak(input_channels[left_ch]),
            right_peak: VDsp::peak(input_channels[right_ch]),
        };
    }
}

/// Calculate levels for output buffers
pub fn calculate_output_levels(
    output_buffers: &HashMap<String, Vec<f32>>,
    state: &MixerState,
    frames: usize,
) {
    let mut output_levels = state.output_levels.write();

    for (device_id, buffer) in output_buffers {
        let channels = buffer.len() / frames;
        let pairs = channels / 2;
        let mut levels = Vec::with_capacity(pairs);

        for pair in 0..pairs {
            let left_offset = pair * 2 * frames;
            let right_offset = (pair * 2 + 1) * frames;

            if right_offset + frames <= buffer.len() {
                let left = &buffer[left_offset..left_offset + frames];
                let right = &buffer[right_offset..right_offset + frames];

                levels.push(ChannelLevels {
                    left_rms: VDsp::rms(left),
                    right_rms: VDsp::rms(right),
                    left_peak: VDsp::peak(left),
                    right_peak: VDsp::peak(right),
                });
            }
        }

        output_levels.insert(device_id.clone(), levels);
    }
}

// Global mixer state (singleton)
lazy_static::lazy_static! {
    pub static ref MIXER_STATE: Arc<MixerState> = Arc::new(MixerState::new());
}

/// Get global mixer state
pub fn get_mixer_state() -> Arc<MixerState> {
    Arc::clone(&MIXER_STATE)
}
