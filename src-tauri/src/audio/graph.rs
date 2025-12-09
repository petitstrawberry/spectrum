//! Audio Graph - DAG-based routing with topological sort

use super::edge::{Edge, EdgeId};
use super::node::{AudioNode, NodeHandle, NodeType, PortId};
use std::collections::{HashMap, HashSet, VecDeque};

/// オーディオグラフ
///
/// ノードとエッジを管理し、トポロジカルソートで処理順序を決定
pub struct AudioGraph {
    /// ノード格納
    nodes: HashMap<NodeHandle, Box<dyn AudioNode>>,
    /// エッジ
    edges: Vec<Edge>,
    /// 処理順序（トポロジカルソート済み）
    processing_order: Vec<NodeHandle>,
    /// 次のノードハンドル
    next_handle: u32,
    /// 次のエッジID
    next_edge_id: u32,
    /// グラフが変更されたかどうか (rebuild needed)
    dirty: bool,
}

impl AudioGraph {
    /// Create a new empty graph
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            processing_order: Vec::new(),
            next_handle: 1, // Start from 1 (0 is reserved)
            next_edge_id: 1,
            dirty: false,
        }
    }

    /// ノードを追加
    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeHandle {
        let handle = NodeHandle::new(self.next_handle);
        self.next_handle += 1;
        self.nodes.insert(handle, node);
        self.dirty = true;
        handle
    }

    /// ノードを削除（関連エッジも自動削除）
    pub fn remove_node(&mut self, handle: NodeHandle) -> bool {
        if self.nodes.remove(&handle).is_some() {
            // 関連するエッジも削除
            self.edges
                .retain(|e| e.source != handle && e.target != handle);
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// ノードを取得
    pub fn get_node(&self, handle: NodeHandle) -> Option<&dyn AudioNode> {
        self.nodes.get(&handle).map(|n| n.as_ref())
    }

    /// ノードを取得（可変）
    pub fn get_node_mut(&mut self, handle: NodeHandle) -> Option<&mut (dyn AudioNode + '_)> {
        match self.nodes.get_mut(&handle) {
            Some(boxed) => Some(&mut **boxed),
            None => None,
        }
    }

    /// すべてのノードハンドルを取得
    pub fn node_handles(&self) -> impl Iterator<Item = NodeHandle> + '_ {
        self.nodes.keys().copied()
    }

    /// ノード数を取得
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// エッジを追加
    pub fn add_edge(
        &mut self,
        source: NodeHandle,
        source_port: PortId,
        target: NodeHandle,
        target_port: PortId,
    ) -> Option<EdgeId> {
        // Validate nodes exist
        if !self.nodes.contains_key(&source) || !self.nodes.contains_key(&target) {
            return None;
        }

        // Check for duplicate
        let exists = self.edges.iter().any(|e| {
            e.source == source
                && e.source_port == source_port
                && e.target == target
                && e.target_port == target_port
        });
        if exists {
            return None;
        }

        let id = EdgeId::new(self.next_edge_id);
        self.next_edge_id += 1;
        let edge = Edge::new(id, source, source_port, target, target_port);
        self.edges.push(edge);
        self.dirty = true;
        Some(id)
    }

    /// エッジを追加（ゲインとミュート指定）
    pub fn add_edge_with_params(
        &mut self,
        source: NodeHandle,
        source_port: PortId,
        target: NodeHandle,
        target_port: PortId,
        gain: f32,
        muted: bool,
    ) -> Option<EdgeId> {
        let id = self.add_edge(source, source_port, target, target_port)?;
        if let Some(edge) = self.edges.iter_mut().find(|e| e.id == id) {
            edge.gain = gain;
            edge.muted = muted;
        }
        Some(id)
    }

    /// エッジを削除
    pub fn remove_edge(&mut self, id: EdgeId) -> bool {
        let len_before = self.edges.len();
        self.edges.retain(|e| e.id != id);
        let removed = self.edges.len() < len_before;
        if removed {
            self.dirty = true;
        }
        removed
    }

    /// エッジを取得
    pub fn get_edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.iter().find(|e| e.id == id)
    }

    /// エッジを取得（可変）
    pub fn get_edge_mut(&mut self, id: EdgeId) -> Option<&mut Edge> {
        self.edges.iter_mut().find(|e| e.id == id)
    }

    /// すべてのエッジを取得
    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// エッジ数を取得
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// エッジのゲインを更新（リビルド不要）
    pub fn set_edge_gain(&mut self, id: EdgeId, gain: f32) -> bool {
        if let Some(edge) = self.edges.iter_mut().find(|e| e.id == id) {
            edge.set_gain(gain);
            true
        } else {
            false
        }
    }

    /// エッジのミュートを更新（リビルド不要）
    pub fn set_edge_muted(&mut self, id: EdgeId, muted: bool) -> bool {
        if let Some(edge) = self.edges.iter_mut().find(|e| e.id == id) {
            edge.set_muted(muted);
            true
        } else {
            false
        }
    }

    /// ターゲットノードへのエッジを取得
    pub fn edges_to(&self, target: NodeHandle) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter(move |e| e.target == target)
    }

    /// ソースノードからのエッジを取得
    pub fn edges_from(&self, source: NodeHandle) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter(move |e| e.source == source)
    }

    /// 処理順序を取得
    pub fn processing_order(&self) -> &[NodeHandle] {
        &self.processing_order
    }

    /// 処理順序を再計算（必要な場合のみ）
    pub fn rebuild_order_if_needed(&mut self) {
        if self.dirty {
            self.rebuild_order();
        }
    }

    /// 処理順序を再計算
    pub fn rebuild_order(&mut self) {
        self.processing_order = self.topological_sort();
        self.dirty = false;
    }

    /// トポロジカルソート (Kahn's algorithm)
    fn topological_sort(&self) -> Vec<NodeHandle> {
        let mut in_degree: HashMap<NodeHandle, usize> = HashMap::new();
        let mut adjacency: HashMap<NodeHandle, Vec<NodeHandle>> = HashMap::new();

        // Initialize
        for &handle in self.nodes.keys() {
            in_degree.insert(handle, 0);
            adjacency.insert(handle, Vec::new());
        }

        // Build adjacency and in-degree
        for edge in &self.edges {
            if let Some(adj) = adjacency.get_mut(&edge.source) {
                if !adj.contains(&edge.target) {
                    adj.push(edge.target);
                }
            }
            if let Some(deg) = in_degree.get_mut(&edge.target) {
                // Only count if not already counted (avoid double counting for multi-port edges)
                let already_counted = self.edges.iter().any(|e| {
                    e.source == edge.source && e.target == edge.target && e.id != edge.id
                });
                if !already_counted {
                    *deg += 1;
                }
            }
        }

        // Recalculate in_degree properly (count unique source->target pairs)
        for (&handle, deg) in in_degree.iter_mut() {
            let sources: HashSet<_> = self
                .edges
                .iter()
                .filter(|e| e.target == handle)
                .map(|e| e.source)
                .collect();
            *deg = sources.len();
        }

        // Start with nodes that have no incoming edges
        let mut queue: VecDeque<NodeHandle> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&handle, _)| handle)
            .collect();

        // Sort queue by node type (Source first, then Bus, then Sink)
        let mut queue: Vec<_> = queue.into_iter().collect();
        queue.sort_by_key(|h| match self.nodes.get(h).map(|n| n.node_type()) {
            Some(NodeType::Source) => 0,
            Some(NodeType::Bus) => 1,
            Some(NodeType::Sink) => 2,
            None => 3,
        });
        let mut queue: VecDeque<_> = queue.into_iter().collect();

        let mut result = Vec::new();

        while let Some(handle) = queue.pop_front() {
            result.push(handle);

            if let Some(neighbors) = adjacency.get(&handle) {
                for &neighbor in neighbors {
                    if let Some(deg) = in_degree.get_mut(&neighbor) {
                        *deg = deg.saturating_sub(1);
                        if *deg == 0 {
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }

        // Check for cycles (if result doesn't contain all nodes)
        if result.len() != self.nodes.len() {
            eprintln!(
                "[AudioGraph] Warning: Cycle detected! Processed {} of {} nodes",
                result.len(),
                self.nodes.len()
            );
        }

        result
    }

    /// ソースノードを取得
    pub fn source_nodes(&self) -> impl Iterator<Item = NodeHandle> + '_ {
        self.nodes
            .iter()
            .filter(|(_, n)| n.node_type() == NodeType::Source)
            .map(|(&h, _)| h)
    }

    /// バスノードを取得
    pub fn bus_nodes(&self) -> impl Iterator<Item = NodeHandle> + '_ {
        self.nodes
            .iter()
            .filter(|(_, n)| n.node_type() == NodeType::Bus)
            .map(|(&h, _)| h)
    }

    /// シンクノードを取得
    pub fn sink_nodes(&self) -> impl Iterator<Item = NodeHandle> + '_ {
        self.nodes
            .iter()
            .filter(|(_, n)| n.node_type() == NodeType::Sink)
            .map(|(&h, _)| h)
    }

    /// Check if graph is dirty (needs rebuild)
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }
}

impl Default for AudioGraph {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::source::SourceNode;

    #[test]
    fn test_add_remove_node() {
        let mut graph = AudioGraph::new();

        let node = Box::new(SourceNode::new_prism(0, "Test"));
        let handle = graph.add_node(node);

        assert_eq!(graph.node_count(), 1);
        assert!(graph.get_node(handle).is_some());

        graph.remove_node(handle);
        assert_eq!(graph.node_count(), 0);
    }

    #[test]
    fn test_topological_sort() {
        let mut graph = AudioGraph::new();

        // Source -> Bus -> Sink
        let src = graph.add_node(Box::new(SourceNode::new_prism(0, "Src")));
        let bus = graph.add_node(Box::new(crate::audio::bus::BusNode::new_stereo("b", "Bus")));
        let sink = graph.add_node(Box::new(crate::audio::sink::SinkNode::new_stereo(1, "Out")));

        graph.add_edge(src, PortId::new(0), bus, PortId::new(0));
        graph.add_edge(bus, PortId::new(0), sink, PortId::new(0));

        graph.rebuild_order();

        let order = graph.processing_order();
        assert_eq!(order.len(), 3);

        let src_pos = order.iter().position(|&h| h == src).unwrap();
        let bus_pos = order.iter().position(|&h| h == bus).unwrap();
        let sink_pos = order.iter().position(|&h| h == sink).unwrap();

        assert!(src_pos < bus_pos);
        assert!(bus_pos < sink_pos);
    }
}
