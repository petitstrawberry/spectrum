//! Graph Processor - Audio processing engine

use super::edge::EdgeId;
use super::graph::AudioGraph;
use super::meters::{EdgeMeter, GraphMeters, NodeMeter, PortMeter};
use super::node::{AudioNode, NodeHandle, NodeType, PortId};
use super::source::SourceId;
use arc_swap::ArcSwap;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// グラフプロセッサ
///
/// オーディオコールバックから呼び出され、グラフ全体を処理
pub struct GraphProcessor {
    /// The audio graph (RwLock for synchronized access)
    /// For realtime-safe processing, we use ArcSwap for reads
    graph: Arc<RwLock<AudioGraph>>,
    /// Snapshot for audio thread (lock-free reads)
    graph_snapshot: Arc<ArcSwap<AudioGraph>>,
    /// Meters (ArcSwap for lock-free reads from UI thread)
    meters: Arc<ArcSwap<GraphMeters>>,
    /// Processing timestamp
    timestamp: AtomicU64,
    /// Edge meters (accumulated during processing)
    edge_meters: Arc<ArcSwap<Vec<(EdgeId, f32)>>>,
}

impl GraphProcessor {
    /// Create a new graph processor
    pub fn new() -> Self {
        let graph = AudioGraph::new();
        Self {
            graph: Arc::new(RwLock::new(AudioGraph::new())),
            graph_snapshot: Arc::new(ArcSwap::from_pointee(graph)),
            meters: Arc::new(ArcSwap::from_pointee(GraphMeters::new())),
            timestamp: AtomicU64::new(0),
            edge_meters: Arc::new(ArcSwap::from_pointee(Vec::new())),
        }
    }

    /// Get a reference to the graph snapshot (for non-realtime operations)
    pub fn graph(&self) -> Arc<AudioGraph> {
        self.graph_snapshot.load_full()
    }

    /// Add a node to the graph
    pub fn add_node(&self, node: Box<dyn AudioNode>) -> NodeHandle {
        let mut graph = self.graph.write();
        let handle = graph.add_node(node);
        graph.rebuild_order_if_needed();
        self.update_snapshot(&graph);
        handle
    }

    /// Remove a node from the graph
    pub fn remove_node(&self, handle: NodeHandle) -> bool {
        let mut graph = self.graph.write();
        let result = graph.remove_node(handle);
        if result {
            graph.rebuild_order_if_needed();
            self.update_snapshot(&graph);
        }
        result
    }

    /// Add an edge to the graph
    pub fn add_edge(
        &self,
        source: NodeHandle,
        source_port: PortId,
        target: NodeHandle,
        target_port: PortId,
        gain: f32,
        muted: bool,
    ) -> Option<EdgeId> {
        let mut graph = self.graph.write();
        let edge_id = graph.add_edge_with_params(source, source_port, target, target_port, gain, muted);
        if edge_id.is_some() {
            graph.rebuild_order_if_needed();
            self.update_snapshot(&graph);
        }
        edge_id
    }

    /// Remove an edge from the graph
    pub fn remove_edge(&self, edge_id: EdgeId) -> bool {
        let mut graph = self.graph.write();
        let result = graph.remove_edge(edge_id);
        if result {
            self.update_snapshot(&graph);
        }
        result
    }

    /// Set edge gain (hot path - uses RwLock for now, optimize later)
    pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
        let graph = self.graph.read();
        graph.set_edge_gain_atomic(edge_id, gain)
    }

    /// Set edge muted state
    pub fn set_edge_muted(&self, edge_id: EdgeId, muted: bool) -> bool {
        let graph = self.graph.read();
        graph.set_edge_muted_atomic(edge_id, muted)
    }

    /// Batch update edge gains
    pub fn set_edge_gains_batch(&self, updates: &[(EdgeId, f32)]) -> usize {
        let graph = self.graph.read();
        let mut count = 0;
        for &(edge_id, gain) in updates {
            if graph.set_edge_gain_atomic(edge_id, gain) {
                count += 1;
            }
        }
        count
    }

    /// Update the snapshot for audio thread
    fn update_snapshot(&self, graph: &AudioGraph) {
        // Note: This creates a new AudioGraph which is not ideal
        // For now, we store the edges and recreate - proper solution needs Clone for AudioGraph
        // This is a temporary workaround
        let snapshot = self.create_snapshot(graph);
        self.graph_snapshot.store(Arc::new(snapshot));
    }

    /// Create a snapshot of the graph (temporary workaround)
    fn create_snapshot(&self, _graph: &AudioGraph) -> AudioGraph {
        // For now, return a new empty graph
        // TODO: Implement proper graph cloning
        // The issue is that Box<dyn AudioNode> is not Clone
        // Solutions:
        // 1. Store node state separately from processing buffers
        // 2. Use Arc<dyn AudioNode> instead of Box
        // 3. Implement a custom clone mechanism
        AudioGraph::new()
    }

    /// Replace the entire graph
    pub fn set_graph(&self, graph: AudioGraph) {
        let mut current = self.graph.write();
        *current = graph;
        current.rebuild_order_if_needed();
        // For now, just create an empty snapshot (temporary)
        self.graph_snapshot.store(Arc::new(AudioGraph::new()));
    }

    /// Get current meters (lock-free read)
    pub fn get_meters(&self) -> Arc<GraphMeters> {
        self.meters.load_full()
    }

    /// Execute with read access to the graph
    pub fn with_graph<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&AudioGraph) -> R,
    {
        let graph = self.graph.read();
        f(&graph)
    }

    /// Execute with write access to the graph
    pub fn with_graph_mut<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut AudioGraph) -> R,
    {
        let mut graph = self.graph.write();
        let result = f(&mut graph);
        self.update_snapshot(&graph);
        result
    }

    /// オーディオ処理を実行
    ///
    /// Called from audio callback. Uses write lock for mutable access.
    /// In realtime-critical scenarios, consider double-buffering.
    pub fn process(&self, frames: usize, read_source_fn: &dyn Fn(&SourceId, &mut [f32])) {
        // Get write access for processing
        let Some(mut graph) = self.graph.try_write() else {
            return; // Skip if locked
        };

        graph.rebuild_order_if_needed();

        // 1. すべてのノードのバッファをクリア
        for handle in graph.processing_order().to_vec() {
            if let Some(node) = graph.get_node_mut(handle) {
                node.clear_buffers(frames);
            }
        }

        // 2. ソースノードの読み込み
        use super::source::SourceNode;
        for handle in graph.source_nodes().collect::<Vec<_>>() {
            if let Some(node) = graph.get_node_mut(handle) {
                // Downcast to get source_id
                if let Some(source) = node.as_any_mut().downcast_mut::<SourceNode>() {
                    let base_source_id = source.source_id().clone();
                    // Read each output port
                    for port_idx in 0..source.output_port_count() {
                        if let Some(buf) = source.output_buffer_mut(PortId::new(port_idx as u8)) {
                            let samples = buf.samples_mut();
                            // SourceNode はステレオ(複数ポート)を持つが、source_id はベース(左ch)のみを保持している。
                            // 各ポートで channel を port_idx 分オフセットして読み分ける。
                            let source_id = match &base_source_id {
                                SourceId::PrismChannel { channel } => SourceId::PrismChannel {
                                    channel: channel.saturating_add(port_idx as u8),
                                },
                                SourceId::InputDevice { device_id, channel } => SourceId::InputDevice {
                                    device_id: *device_id,
                                    channel: channel.saturating_add(port_idx as u8),
                                },
                            };
                            read_source_fn(&source_id, samples);
                            buf.set_valid_frames(frames);
                            buf.update_meters();
                        }
                    }
                }
            }
        }

        // 3. トポロジカル順でノードを処理
        let processing_order = graph.processing_order().to_vec();
        let edges = graph.edges().to_vec();

        // Collect edge meters during processing
        let mut edge_meter_data: Vec<(EdgeId, f32)> = Vec::new();

        for &handle in &processing_order {
            // 3a. このノードへの入力を集約（エッジからミックス）
            for edge in edges.iter().filter(|e| e.target == handle && e.is_active()) {
                let Some((source_node, target_node)) =
                    graph.get_two_nodes_mut(edge.source, edge.target)
                else {
                    continue;
                };

                let Some(source_buf) = source_node.output_buffer(edge.source_port) else {
                    continue;
                };

                let gain = edge.gain();

                // Calculate post-gain peak for metering
                let post_gain_peak = source_buf.cached_peak() * gain.abs();
                edge_meter_data.push((edge.id, post_gain_peak));

                // Mix into target input buffer with gain applied (no allocations)
                if let Some(tgt_buf) = target_node.input_buffer_mut(edge.target_port) {
                    tgt_buf.mix_from(source_buf, gain);
                }
            }

            // 3b. ノードの処理を実行
            if let Some(node) = graph.get_node_mut(handle) {
                node.process(frames);
            }
        }

        // Store edge meters
        self.edge_meters.store(Arc::new(edge_meter_data));

        // 4. メーターを更新
        self.update_meters_internal(&graph);
    }

    /// 簡易処理（グラフ直接操作版）
    ///
    /// Note: This version takes a mutable graph reference directly.
    /// Use this when you have exclusive access to the graph.
    pub fn process_graph(
        graph: &mut AudioGraph,
        frames: usize,
        read_source_fn: impl Fn(&SourceId, &mut [f32]),
    ) -> Vec<(EdgeId, f32)> {
        graph.rebuild_order_if_needed();

        // 1. すべてのノードのバッファをクリア
        for handle in graph.processing_order().to_vec() {
            if let Some(node) = graph.get_node_mut(handle) {
                node.clear_buffers(frames);
            }
        }

        // 2. ソースノードの読み込み
        use super::source::SourceNode;
        for handle in graph.source_nodes().collect::<Vec<_>>() {
            if let Some(node) = graph.get_node_mut(handle) {
                if let Some(source) = node.as_any_mut().downcast_mut::<SourceNode>() {
                    let base_source_id = source.source_id().clone();
                    for port_idx in 0..source.output_port_count() {
                        if let Some(buf) = source.output_buffer_mut(PortId::new(port_idx as u8)) {
                            let samples = buf.samples_mut();
                            let source_id = match &base_source_id {
                                SourceId::PrismChannel { channel } => SourceId::PrismChannel {
                                    channel: channel.saturating_add(port_idx as u8),
                                },
                                SourceId::InputDevice { device_id, channel } => SourceId::InputDevice {
                                    device_id: *device_id,
                                    channel: channel.saturating_add(port_idx as u8),
                                },
                            };
                            read_source_fn(&source_id, samples);
                            buf.set_valid_frames(frames);
                            buf.update_meters();
                        }
                    }
                }
            }
        }

        // 3. トポロジカル順でノードを処理
        let processing_order = graph.processing_order().to_vec();
        let edges = graph.edges().to_vec();
        let mut edge_meter_data: Vec<(EdgeId, f32)> = Vec::new();

        for &handle in &processing_order {
            for edge in edges.iter().filter(|e| e.target == handle && e.is_active()) {
                let Some((source_node, target_node)) =
                    graph.get_two_nodes_mut(edge.source, edge.target)
                else {
                    continue;
                };

                let Some(source_buf) = source_node.output_buffer(edge.source_port) else {
                    continue;
                };

                let gain = edge.gain();
                let post_gain_peak = source_buf.cached_peak() * gain.abs();
                edge_meter_data.push((edge.id, post_gain_peak));

                if let Some(tgt_buf) = target_node.input_buffer_mut(edge.target_port) {
                    tgt_buf.mix_from(source_buf, gain);
                }
            }

            if let Some(node) = graph.get_node_mut(handle) {
                node.process(frames);
            }
        }

        edge_meter_data
    }

    fn update_meters_internal(&self, graph: &AudioGraph) {
        let mut meters = GraphMeters::new();
        meters.timestamp = self.timestamp.fetch_add(1, Ordering::Relaxed);

        // Collect node meters
        for handle in graph.processing_order() {
            if let Some(node) = graph.get_node(*handle) {
                let mut node_meter = NodeMeter::new(*handle);

                for level in node.input_peak_levels() {
                    node_meter.inputs.push(PortMeter::new(level));
                }

                for level in node.output_peak_levels() {
                    node_meter.outputs.push(PortMeter::new(level));
                }

                meters.nodes.push(node_meter);
            }
        }

        // Collect edge meters
        let edge_levels = self.edge_meters.load();
        for (edge_id, level) in edge_levels.iter() {
            let mut meter = EdgeMeter::new(*edge_id);
            meter.post_gain = PortMeter::new(*level);
            meters.edges.push(meter);
        }

        self.meters.store(Arc::new(meters));
    }

    /// シンクノードの出力を取得（出力コールバック用）
    pub fn read_sink_output(
        &self,
        handle: NodeHandle,
        channel: usize,
        output: &mut [f32],
    ) -> bool {
        // Try to get read access - if locked, return silence
        let Some(graph) = self.graph.try_read() else {
            output.fill(0.0);
            return false;
        };

        if let Some(node) = graph.get_node(handle) {
            if node.node_type() != NodeType::Sink {
                output.fill(0.0);
                return false;
            }

            if let Some(buf) = node.input_buffer(PortId::new(channel as u8)) {
                let samples = buf.samples();
                let len = output.len().min(samples.len());
                output[..len].copy_from_slice(&samples[..len]);
                // Zero-fill remaining
                output[len..].fill(0.0);
                return true;
            }
        }

        output.fill(0.0);
        false
    }
}

impl Default for GraphProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Global graph processor instance
static GRAPH_PROCESSOR: std::sync::OnceLock<GraphProcessor> = std::sync::OnceLock::new();

/// Get the global graph processor
pub fn get_graph_processor() -> &'static GraphProcessor {
    GRAPH_PROCESSOR.get_or_init(GraphProcessor::new)
}

/// Initialize the global graph processor with a specific graph
pub fn init_graph_processor(graph: AudioGraph) {
    let processor = get_graph_processor();
    processor.set_graph(graph);
}
