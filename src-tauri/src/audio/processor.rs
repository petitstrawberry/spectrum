//! Graph Processor - Audio processing engine

use super::edge::EdgeId;
use super::graph::AudioGraph;
use super::meters::{EdgeMeter, GraphMeters, NodeMeter, PortMeter};
use super::node::{NodeHandle, NodeType, PortId};
use super::source::SourceId;
use arc_swap::ArcSwap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// グラフプロセッサ
///
/// オーディオコールバックから呼び出され、グラフ全体を処理
pub struct GraphProcessor {
    /// The audio graph (ArcSwap for lock-free reads from audio thread)
    graph: Arc<ArcSwap<AudioGraph>>,
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
        Self {
            graph: Arc::new(ArcSwap::from_pointee(AudioGraph::new())),
            meters: Arc::new(ArcSwap::from_pointee(GraphMeters::new())),
            timestamp: AtomicU64::new(0),
            edge_meters: Arc::new(ArcSwap::from_pointee(Vec::new())),
        }
    }

    /// Get a reference to the graph (for non-realtime operations)
    pub fn graph(&self) -> Arc<AudioGraph> {
        self.graph.load_full()
    }

    /// Get a clone of the current graph for modification
    pub fn graph_clone(&self) -> AudioGraph {
        // We need to create a snapshot for modification
        // This is a workaround since AudioGraph doesn't implement Clone directly
        // In practice, we should have a separate method to get/set the graph
        // For now, we'll panic if this is called (should use update_graph instead)
        panic!("Use update_graph() to modify the graph")
    }

    /// Update the graph atomically
    pub fn update_graph<F>(&self, f: F)
    where
        F: FnOnce(&mut AudioGraph),
    {
        // Load current graph
        let current = self.graph.load();

        // Create a new graph with the same state
        // Note: This requires cloning the graph, which we need to implement
        // For now, we create a new graph and apply the function
        let mut new_graph = AudioGraph::new();

        // Copy state (this is a simplified version - in production you'd want proper cloning)
        // For now, the caller is responsible for rebuilding the graph state

        f(&mut new_graph);
        new_graph.rebuild_order_if_needed();

        // Store atomically
        self.graph.store(Arc::new(new_graph));
    }

    /// Replace the entire graph
    pub fn set_graph(&self, graph: AudioGraph) {
        let mut graph = graph;
        graph.rebuild_order_if_needed();
        self.graph.store(Arc::new(graph));
    }

    /// Set edge gain (hot path - lock-free)
    pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) {
        // For hot path, we need mutable access to the graph
        // This requires ArcSwap's rcu pattern
        self.graph.rcu(|current| {
            // Clone the current graph (need to implement Clone for AudioGraph)
            // For now, we'll use a workaround with interior mutability
            // In production, edges should be in a separate ArcSwap for truly lock-free updates

            // Workaround: edges are in the graph, so we need to rebuild
            let mut new_graph = AudioGraph::new();
            // Copy nodes and edges...
            // This is expensive - in production, separate edges into their own ArcSwap
            new_graph
        });
    }

    /// Get current meters (lock-free read)
    pub fn get_meters(&self) -> Arc<GraphMeters> {
        self.meters.load_full()
    }

    /// オーディオ処理を実行
    ///
    /// Called from audio callback. Must be lock-free.
    pub fn process(&self, frames: usize, read_source_fn: &dyn Fn(&SourceId, &mut [f32])) {
        let graph = self.graph.load();

        // 1. すべてのノードのバッファをクリア
        // Note: We need mutable access here, which is tricky with ArcSwap
        // In production, buffers should be separate from the graph structure

        // 2. ソースノードの読み込み
        for handle in graph.source_nodes() {
            // Read from source...
        }

        // 3. トポロジカル順でノードを処理
        for &handle in graph.processing_order() {
            // Process node...
        }

        // 4. メーターを更新
        self.update_meters_internal(&graph);
    }

    /// 簡易処理（グラフ直接操作版）
    ///
    /// Note: This version takes a mutable graph reference directly.
    /// Use this when you have exclusive access to the graph (e.g., in single-threaded tests).
    pub fn process_graph(
        graph: &mut AudioGraph,
        frames: usize,
        read_source_fn: impl Fn(&SourceId, &mut [f32]),
    ) {
        graph.rebuild_order_if_needed();

        // 1. すべてのノードのバッファをクリア
        for handle in graph.processing_order().to_vec() {
            if let Some(node) = graph.get_node_mut(handle) {
                node.clear_buffers(frames);
            }
        }

        // 2. ソースノードの読み込み
        for handle in graph.source_nodes().collect::<Vec<_>>() {
            if let Some(node) = graph.get_node_mut(handle) {
                // Get source info and read audio
                // Note: We need to downcast to SourceNode to access source_id
                // This is a limitation of the trait-based design
                // In production, use a type-erased approach or store source_id separately
            }
        }

        // 3. トポロジカル順でノードを処理
        let processing_order = graph.processing_order().to_vec();
        let edges = graph.edges().to_vec(); // Clone edges for iteration

        for &handle in &processing_order {
            // 3a. このノードへの入力を集約（エッジからミックス）
            let incoming_edges: Vec<_> = edges
                .iter()
                .filter(|e| e.target == handle && e.is_active())
                .cloned()
                .collect();

            for edge in incoming_edges {
                // Get source output buffer
                let source_samples: Vec<f32> = if let Some(source_node) = graph.get_node(edge.source)
                {
                    if let Some(buf) = source_node.output_buffer(edge.source_port) {
                        buf.samples().to_vec()
                    } else {
                        continue;
                    }
                } else {
                    continue;
                };

                // Mix into target input buffer
                if let Some(target_node) = graph.get_node_mut(handle) {
                    if let Some(tgt_buf) = target_node.input_buffer_mut(edge.target_port) {
                        // Create temporary buffer for mixing
                        let mut temp = super::buffer::AudioBuffer::new();
                        temp.write_samples(&source_samples);
                        tgt_buf.mix_from(&temp, edge.gain);
                    }
                }
            }

            // 3b. ノードの処理を実行
            if let Some(node) = graph.get_node_mut(handle) {
                node.process(frames);
            }
        }
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
        let graph = self.graph.load();

        if let Some(node) = graph.get_node(handle) {
            if node.node_type() != NodeType::Sink {
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
