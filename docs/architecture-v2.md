# Spectrum Audio Router - Architecture v2

## 設計思想

### 核心原則: Pure Sends-on-Fader

```
すべてのレベル制御は Edge (Send) で行う。
Node は処理のみを行い、レベル制御の責務を持たない。
```

これにより：
- Node は単純なバッファ + 処理（Bus のみ）
- 設定の一貫性（すべて Edge の gain で制御）
- UI のシンプル化（フェーダー = Send レベル）

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           SPECTRUM v2 ARCHITECTURE                               │
│                        "Pure Sends-on-Fader" Design                              │
└─────────────────────────────────────────────────────────────────────────────────┘

    ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
    │   Audio Source   │     │   Audio Source   │     │   Audio Source   │
    │   (Prism ch)     │     │   (Device)       │     │   (Bus output)   │
    └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
             │                        │                        │
             │  impl AudioNode        │  impl AudioNode        │  impl AudioNode
             │                        │                        │
             ▼                        ▼                        ▼
    ┌─────────────────────────────────────────────────────────────────────────────┐
    │                              AUDIO GRAPH                                     │
    │                                                                              │
    │   Nodes: HashMap<NodeHandle, Box<dyn AudioNode>>                            │
    │                                                                              │
    │   Edges: Vec<Edge>                                                          │
    │     - source: NodeHandle                                                    │
    │     - target: NodeHandle                                                    │
    │     - source_port: PortId                                                   │
    │     - target_port: PortId                                                   │
    │     - gain: f32           ← すべてのレベル制御はここ                         │
    │     - muted: bool                                                           │
    │                                                                              │
    └─────────────────────────────────────────────────────────────────────────────┘
             │                        │                        │
             ▼                        ▼                        ▼
    ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
    │   Audio Sink     │     │   Audio Sink     │     │   Audio Sink     │
    │   (Output ch)    │     │   (Output ch)    │     │   (Output ch)    │
    └──────────────────┘     └──────────────────┘     └──────────────────┘
```

---

## 型設計

### NodeHandle: シンプルで一意なID

```rust
/// Node の一意識別子
///
/// 重要: NodeHandle は不透明なIDであり、ノードの種類を示さない。
/// ノードの種類はノード自体が持つ。これにより呼び出し側は
/// 統一されたインターフェースでノードを扱える。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeHandle(u32);

impl NodeHandle {
    /// 新しいハンドルを生成（内部でのみ使用）
    fn new(id: u32) -> Self {
        Self(id)
    }
}
```

**旧設計との違い:**
- ❌ 旧: NodeId に種類情報をエンコード (0x0000-0x0FFF = Input, etc.)
- ✅ 新: NodeHandle は純粋なID。種類は Node trait で判別

### PortId: チャンネル識別

```rust
/// ポート（チャンネル）の識別子
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PortId(u8);

impl PortId {
    pub fn new(index: u8) -> Self {
        Self(index)
    }

    pub fn index(&self) -> usize {
        self.0 as usize
    }
}
```

---

## Trait 設計

### AudioNode: 統一インターフェース

```rust
/// オーディオノードの統一インターフェース
///
/// すべてのノード種類（Source, Bus, Sink）がこのトレイトを実装する。
/// これにより、グラフは具体的なノード種類を知らずに処理できる。
pub trait AudioNode: Send + Sync {
    /// ノードの種類を返す
    fn node_type(&self) -> NodeType;

    /// 入力ポート数を返す
    fn input_port_count(&self) -> usize;

    /// 出力ポート数を返す
    fn output_port_count(&self) -> usize;

    /// 入力バッファへの参照を取得
    fn input_buffer(&self, port: PortId) -> Option<&AudioBuffer>;

    /// 入力バッファへの可変参照を取得
    fn input_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer>;

    /// 出力バッファへの参照を取得
    fn output_buffer(&self, port: PortId) -> Option<&AudioBuffer>;

    /// 出力バッファへの可変参照を取得
    fn output_buffer_mut(&mut self, port: PortId) -> Option<&mut AudioBuffer>;

    /// ノードの処理を実行
    ///
    /// - Source: 入力デバイスから読み込み → 出力バッファへ
    /// - Bus: 入力バッファ → プラグイン処理 → 出力バッファ
    /// - Sink: 入力バッファ → 出力デバイスへ書き込み
    fn process(&mut self, frames: usize);

    /// バッファをクリア
    fn clear_buffers(&mut self, frames: usize);

    /// ピークレベルを取得（メータリング用）
    fn peak_levels(&self) -> Vec<f32>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    Source,
    Bus,
    Sink,
}
```

### AudioBuffer: シンプルなバッファ

```rust
/// モノラルオーディオバッファ
pub struct AudioBuffer {
    data: Box<[f32; MAX_FRAMES]>,
    valid_frames: usize,
}

impl AudioBuffer {
    pub fn new() -> Self {
        Self {
            data: Box::new([0.0; MAX_FRAMES]),
            valid_frames: 0,
        }
    }

    pub fn clear(&mut self, frames: usize) {
        self.data[..frames].fill(0.0);
        self.valid_frames = frames;
    }

    pub fn samples(&self) -> &[f32] {
        &self.data[..self.valid_frames]
    }

    pub fn samples_mut(&mut self) -> &mut [f32] {
        &mut self.data[..self.valid_frames]
    }

    /// 別のバッファからゲイン付きで加算
    pub fn mix_from(&mut self, source: &AudioBuffer, gain: f32) {
        let frames = self.valid_frames.min(source.valid_frames);
        vdsp::mix_add(&source.data[..frames], gain, &mut self.data[..frames]);
    }
}
```

---

## ノード実装

### SourceNode: 入力ソース

```rust
/// 入力ソースノード
///
/// Prism チャンネルまたは外部入力デバイスから音声を取得
pub struct SourceNode {
    /// ソースの識別情報
    source_id: SourceId,
    /// 出力ポート（モノラル）のバッファ
    output_buffers: Vec<AudioBuffer>,
}

/// ソースの識別
pub enum SourceId {
    /// Prism 仮想デバイスのチャンネル
    PrismChannel { channel: u8 },
    /// 外部入力デバイス
    InputDevice { device_id: u32, channel: u8 },
}

impl AudioNode for SourceNode {
    fn node_type(&self) -> NodeType { NodeType::Source }
    fn input_port_count(&self) -> usize { 0 }  // ソースは入力なし
    fn output_port_count(&self) -> usize { self.output_buffers.len() }

    fn process(&mut self, frames: usize) {
        match &self.source_id {
            SourceId::PrismChannel { channel } => {
                // Ring buffer から読み込み
                audio_capture::read_channel(*channel, self.output_buffers[0].samples_mut());
            }
            SourceId::InputDevice { device_id, channel } => {
                audio_capture::read_device_channel(*device_id, *channel, ...);
            }
        }
    }
    // ...
}
```

### BusNode: エフェクトバス

```rust
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
    /// プラグインチェーン
    plugin_chain: Vec<PluginInstance>,
}

impl AudioNode for BusNode {
    fn node_type(&self) -> NodeType { NodeType::Bus }
    fn input_port_count(&self) -> usize { self.input_buffers.len() }
    fn output_port_count(&self) -> usize { self.output_buffers.len() }

    fn process(&mut self, frames: usize) {
        // 入力 → 出力にコピー
        for (i, out_buf) in self.output_buffers.iter_mut().enumerate() {
            if let Some(in_buf) = self.input_buffers.get(i) {
                out_buf.samples_mut().copy_from_slice(in_buf.samples());
            }
        }

        // プラグインチェーンを通す
        for plugin in &mut self.plugin_chain {
            plugin.process(&mut self.output_buffers, frames);
        }
    }
    // ...
}
```

### SinkNode: 出力先

```rust
/// 出力先ノード
///
/// 物理デバイスまたは仮想デバイスへの出力
pub struct SinkNode {
    /// 出力先の識別情報
    sink_id: SinkId,
    /// 入力バッファ（モノラル）
    input_buffers: Vec<AudioBuffer>,
}

/// 出力先の識別
///
/// 重要: 仮想デバイスの概念はここで実装
/// - 集約デバイスのサブデバイスは個別の SinkId として表現
/// - 通常デバイスは channel_offset = 0
pub enum SinkId {
    /// 物理/仮想出力デバイスのチャンネル
    OutputDevice {
        /// 実際の CoreAudio デバイス ID
        device_id: u32,
        /// デバイス内でのチャンネルオフセット
        /// 集約デバイスのサブデバイスを区別するために使用
        channel_offset: u8,
        /// このシンクが担当するチャンネル数
        channel_count: u8,
    },
}

impl AudioNode for SinkNode {
    fn node_type(&self) -> NodeType { NodeType::Sink }
    fn input_port_count(&self) -> usize { self.input_buffers.len() }
    fn output_port_count(&self) -> usize { 0 }  // シンクは出力なし

    fn process(&mut self, _frames: usize) {
        // 処理は output callback で行う
        // ここでは入力バッファを保持するのみ
    }
    // ...
}
```

---

## Edge: ルーティングとレベル制御

```rust
/// エッジ（送り）
///
/// ソースノードの出力ポートからターゲットノードの入力ポートへの接続。
/// すべてのレベル制御はここで行う（Sends-on-Fader の核心）。
#[derive(Debug, Clone)]
pub struct Edge {
    /// 一意な識別子
    pub id: EdgeId,
    /// ソースノード
    pub source: NodeHandle,
    /// ソースポート（チャンネル）
    pub source_port: PortId,
    /// ターゲットノード
    pub target: NodeHandle,
    /// ターゲットポート（チャンネル）
    pub target_port: PortId,
    /// 送りレベル（リニアゲイン 0.0 ~ 2.0+）
    pub gain: f32,
    /// ミュート
    pub muted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EdgeId(u32);

impl Edge {
    /// このエッジが有効か（ミュートされておらず、ゲインがある）
    pub fn is_active(&self) -> bool {
        !self.muted && self.gain > 0.0001
    }
}
```

---

## AudioGraph: グラフ本体

```rust
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
}

impl AudioGraph {
    /// ノードを追加
    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeHandle {
        let handle = NodeHandle::new(self.next_handle);
        self.next_handle += 1;
        self.nodes.insert(handle, node);
        self.rebuild_order();
        handle
    }

    /// ノードを削除
    pub fn remove_node(&mut self, handle: NodeHandle) {
        self.nodes.remove(&handle);
        // 関連するエッジも削除
        self.edges.retain(|e| e.source != handle && e.target != handle);
        self.rebuild_order();
    }

    /// エッジを追加
    pub fn add_edge(&mut self, edge: Edge) -> EdgeId {
        let id = EdgeId(self.next_edge_id);
        self.next_edge_id += 1;
        let mut edge = edge;
        edge.id = id;
        self.edges.push(edge);
        self.rebuild_order();
        id
    }

    /// エッジを削除
    pub fn remove_edge(&mut self, id: EdgeId) {
        self.edges.retain(|e| e.id != id);
    }

    /// エッジのゲインを更新（リビルド不要）
    pub fn set_edge_gain(&mut self, id: EdgeId, gain: f32) {
        if let Some(edge) = self.edges.iter_mut().find(|e| e.id == id) {
            edge.gain = gain;
        }
    }

    /// エッジのミュートを更新（リビルド不要）
    pub fn set_edge_muted(&mut self, id: EdgeId, muted: bool) {
        if let Some(edge) = self.edges.iter_mut().find(|e| e.id == id) {
            edge.muted = muted;
        }
    }

    /// 処理順序を再計算
    fn rebuild_order(&mut self) {
        self.processing_order = self.topological_sort();
    }

    /// トポロジカルソート
    fn topological_sort(&self) -> Vec<NodeHandle> {
        // Kahn's algorithm
        // ...
    }
}
```

---

## GraphProcessor: オーディオ処理

```rust
/// グラフプロセッサ
///
/// オーディオコールバックから呼び出され、グラフ全体を処理
pub struct GraphProcessor {
    graph: Arc<ArcSwap<AudioGraph>>,
    meters: Arc<ArcSwap<GraphMeters>>,
}

impl GraphProcessor {
    /// オーディオ処理を実行
    pub fn process(&self, frames: usize) {
        let graph = self.graph.load();

        // 1. すべてのノードのバッファをクリア
        for handle in graph.processing_order.iter() {
            if let Some(node) = graph.nodes.get(handle) {
                node.clear_buffers(frames);
            }
        }

        // 2. トポロジカル順でノードを処理
        for handle in graph.processing_order.iter() {
            // 2a. このノードへの入力を集約（エッジからミックス）
            for edge in graph.edges.iter().filter(|e| e.target == *handle && e.is_active()) {
                if let (Some(source_node), Some(target_node)) =
                    (graph.nodes.get(&edge.source), graph.nodes.get_mut(&edge.target))
                {
                    if let (Some(src_buf), Some(tgt_buf)) =
                        (source_node.output_buffer(edge.source_port),
                         target_node.input_buffer_mut(edge.target_port))
                    {
                        tgt_buf.mix_from(src_buf, edge.gain);
                    }
                }
            }

            // 2b. ノードの処理を実行
            if let Some(node) = graph.nodes.get_mut(handle) {
                node.process(frames);
            }
        }

        // 3. メーターを更新
        self.update_meters(&graph);
    }

    /// シンクノードの出力を取得（出力コールバック用）
    pub fn read_sink_output(&self, handle: NodeHandle, output: &mut [f32], channels: usize) {
        // ...
    }
}
```

---

## API 設計

### 設計方針

#### Q: グラフ操作とルーティング操作は同じ？

**A: 同じ。すべてグラフ操作として統一する。**

理由：
- ルーティング = グラフ上のノードとエッジの配置
- 分離すると二重管理になり、不整合の原因に
- UI の操作は全て「グラフの状態変更」として表現可能

```
UI操作 → API呼び出し → Graph変更 → 即座に反映
```

#### Q: メーターはどこから取得する？

**A: 3種類のメーターを統一的に取得**

1. **Node Meters**: 各ノードの入出力レベル
2. **Edge Meters**: 各エッジの通過後レベル（post-gain）
3. **Port Meters**: 特定ポートのレベル

実装上は `get_meters()` で一括取得し、UI側でフィルタリング。

```
Audio Thread → GraphMeters (ArcSwap) → UI Polling (60fps)
```

---

### API カテゴリ

| カテゴリ | 責務 | 例 |
|----------|------|-----|
| **Device** | デバイス列挙（読み取り専用） | `get_input_devices`, `get_output_devices` |
| **Graph** | グラフの構造変更 | `add_node`, `remove_node`, `add_edge`, `remove_edge` |
| **Edge** | エッジのパラメータ変更（リアルタイム） | `set_edge_gain`, `set_edge_muted` |
| **Plugin** | プラグイン管理 | `add_plugin`, `remove_plugin`, `open_plugin_ui` |
| **Meter** | メータリング（ポーリング） | `get_meters` |
| **State** | 状態の永続化 | `save_state`, `load_state` |
| **System** | システム操作 | `start_audio`, `stop_audio`, `get_status` |

---

### TypeScript API (Frontend)

```typescript
// =============================================================================
// 型定義
// =============================================================================

/** ノードハンドル（不透明ID） */
type NodeHandle = number;

/** エッジID */
type EdgeId = number;

/** ポートID（0-based） */
type PortId = number;

// --- Source Types ---

interface PrismChannelSource {
  type: 'prism';
  channel: number;  // 0-63
}

interface DeviceSource {
  type: 'device';
  deviceId: number;
  channel: number;
}

type SourceId = PrismChannelSource | DeviceSource;

// --- Sink Types ---

interface OutputSink {
  deviceId: number;
  channelOffset: number;
  channelCount: number;
}

// --- Node Types ---

interface SourceNodeInfo {
  type: 'source';
  handle: NodeHandle;
  sourceId: SourceId;
  portCount: number;
  label: string;
}

interface BusNodeInfo {
  type: 'bus';
  handle: NodeHandle;
  busId: string;
  label: string;
  portCount: number;
  plugins: PluginInstance[];
}

interface SinkNodeInfo {
  type: 'sink';
  handle: NodeHandle;
  sink: OutputSink;
  portCount: number;
  label: string;
}

type NodeInfo = SourceNodeInfo | BusNodeInfo | SinkNodeInfo;

// --- Edge Types ---

interface EdgeInfo {
  id: EdgeId;
  source: NodeHandle;
  sourcePort: PortId;
  target: NodeHandle;
  targetPort: PortId;
  gain: number;       // 0.0 ~ 2.0+
  muted: boolean;
}

// --- Meter Types ---

interface PortMeter {
  peak: number;       // 0.0 ~ 1.0+
  rms?: number;       // optional
}

interface NodeMeter {
  handle: NodeHandle;
  inputs: PortMeter[];   // 入力ポートごと
  outputs: PortMeter[];  // 出力ポートごと
}

interface EdgeMeter {
  edgeId: EdgeId;
  postGain: PortMeter;   // ゲイン適用後のレベル
}

interface GraphMeters {
  nodes: NodeMeter[];
  edges: EdgeMeter[];
  timestamp: number;
}

// --- Device Types ---

interface InputDevice {
  id: string;           // UI用識別子
  deviceId: number;     // CoreAudio ID
  name: string;
  channelCount: number;
  isPrism: boolean;
  transportType: string;
}

interface OutputDevice {
  id: string;           // UI用識別子 (vout_{deviceId}_{offset})
  deviceId: number;     // CoreAudio ID
  channelOffset: number;
  channelCount: number;
  name: string;
  deviceType: string;
  iconHint: string;
  isAggregateSub: boolean;
}

// --- Plugin Types ---

interface PluginInfo {
  pluginId: string;     // 'aufx:xxxx:yyyy'
  name: string;
  manufacturer: string;
  category: string;
}

interface PluginInstance {
  instanceId: string;
  pluginId: string;
  name: string;
  enabled: boolean;
}

// --- Graph State (for save/load) ---

interface GraphState {
  version: number;
  nodes: NodeState[];
  edges: EdgeState[];
  uiState?: UIState;    // ノード位置など
}

interface NodeState {
  handle: NodeHandle;
  info: NodeInfo;
}

interface EdgeState {
  id: EdgeId;
  info: EdgeInfo;
}

interface UIState {
  nodePositions: Record<NodeHandle, { x: number; y: number }>;
}

// =============================================================================
// API Functions
// =============================================================================

// --- Device API (読み取り専用) ---

/** 利用可能な入力デバイスを取得 */
async function getInputDevices(): Promise<InputDevice[]>;

/** 利用可能な出力デバイスを取得（仮想デバイス展開済み） */
async function getOutputDevices(): Promise<OutputDevice[]>;

/** Prism の接続状態を取得 */
async function getPrismStatus(): Promise<{
  connected: boolean;
  channels: number;
  apps: PrismApp[];
}>;

// --- Graph API (構造変更) ---

/** ソースノードを追加 */
async function addSourceNode(
  sourceId: SourceId,
  label?: string
): Promise<NodeHandle>;

/** バスノードを追加 */
async function addBusNode(
  label: string,
  portCount?: number  // default: 2 (stereo)
): Promise<NodeHandle>;

/** シンクノードを追加 */
async function addSinkNode(
  sink: OutputSink,
  label?: string
): Promise<NodeHandle>;

/** ノードを削除（関連エッジも自動削除） */
async function removeNode(handle: NodeHandle): Promise<void>;

/** エッジを追加 */
async function addEdge(
  source: NodeHandle,
  sourcePort: PortId,
  target: NodeHandle,
  targetPort: PortId,
  gain?: number,    // default: 1.0
  muted?: boolean   // default: false
): Promise<EdgeId>;

/** エッジを削除 */
async function removeEdge(id: EdgeId): Promise<void>;

/** 現在のグラフ情報を取得 */
async function getGraph(): Promise<{
  nodes: NodeInfo[];
  edges: EdgeInfo[];
}>;

// --- Edge API (リアルタイムパラメータ) ---

/** エッジのゲインを設定 */
async function setEdgeGain(id: EdgeId, gain: number): Promise<void>;

/** エッジのミュートを設定 */
async function setEdgeMuted(id: EdgeId, muted: boolean): Promise<void>;

/** 複数エッジのゲインを一括設定（パフォーマンス用） */
async function setEdgeGainsBatch(
  updates: Array<{ id: EdgeId; gain: number }>
): Promise<void>;

// --- Plugin API ---

/** 利用可能なプラグイン一覧を取得 */
async function getAvailablePlugins(): Promise<PluginInfo[]>;

/** バスにプラグインを追加 */
async function addPluginToBus(
  busHandle: NodeHandle,
  pluginId: string,
  position?: number  // default: 末尾
): Promise<string>;  // instanceId

/** バスからプラグインを削除 */
async function removePluginFromBus(
  busHandle: NodeHandle,
  instanceId: string
): Promise<void>;

/** プラグインの順序を変更 */
async function reorderPlugins(
  busHandle: NodeHandle,
  instanceIds: string[]
): Promise<void>;

/** プラグインUIを開く */
async function openPluginUI(instanceId: string): Promise<void>;

/** プラグインUIを閉じる */
async function closePluginUI(instanceId: string): Promise<void>;

// --- Meter API ---

/**
 * メーターを取得
 *
 * ポーリング用。60fps程度で呼び出すことを想定。
 * オーディオスレッドからの読み取りはlock-free。
 */
async function getMeters(): Promise<GraphMeters>;

/**
 * 特定ノードのメーターのみ取得（軽量版）
 */
async function getNodeMeters(handles: NodeHandle[]): Promise<NodeMeter[]>;

/**
 * 特定エッジのメーターのみ取得（軽量版）
 */
async function getEdgeMeters(ids: EdgeId[]): Promise<EdgeMeter[]>;

// --- State API ---

/** グラフ状態を保存 */
async function saveGraphState(): Promise<GraphState>;

/** グラフ状態を復元 */
async function loadGraphState(state: GraphState): Promise<void>;

/** 設定ファイルに永続化 */
async function persistState(): Promise<void>;

// --- System API ---

/** オーディオエンジンを開始 */
async function startAudio(): Promise<void>;

/** オーディオエンジンを停止 */
async function stopAudio(): Promise<void>;

/** システム状態を取得 */
async function getSystemStatus(): Promise<{
  audioRunning: boolean;
  sampleRate: number;
  bufferSize: number;
  cpuLoad: number;
}>;

/** バッファサイズを設定 */
async function setBufferSize(size: number): Promise<void>;
```

---

### Rust Backend Commands

```rust
// =============================================================================
// Device Commands
// =============================================================================

#[tauri::command]
async fn get_input_devices() -> Result<Vec<InputDeviceDto>, String>;

#[tauri::command]
async fn get_output_devices() -> Result<Vec<OutputDeviceDto>, String>;

#[tauri::command]
async fn get_prism_status() -> Result<PrismStatusDto, String>;

// =============================================================================
// Graph Commands
// =============================================================================

#[tauri::command]
async fn add_source_node(
    source_id: SourceIdDto,
    label: Option<String>,
) -> Result<u32, String>;  // NodeHandle

#[tauri::command]
async fn add_bus_node(
    label: String,
    port_count: Option<u8>,
) -> Result<u32, String>;

#[tauri::command]
async fn add_sink_node(
    sink: OutputSinkDto,
    label: Option<String>,
) -> Result<u32, String>;

#[tauri::command]
async fn remove_node(handle: u32) -> Result<(), String>;

#[tauri::command]
async fn add_edge(
    source: u32,
    source_port: u8,
    target: u32,
    target_port: u8,
    gain: Option<f32>,
    muted: Option<bool>,
) -> Result<u32, String>;  // EdgeId

#[tauri::command]
async fn remove_edge(id: u32) -> Result<(), String>;

#[tauri::command]
async fn get_graph() -> Result<GraphDto, String>;

// =============================================================================
// Edge Commands (Hot Path - Realtime Parameter Changes)
// =============================================================================

#[tauri::command]
async fn set_edge_gain(id: u32, gain: f32) -> Result<(), String>;

#[tauri::command]
async fn set_edge_muted(id: u32, muted: bool) -> Result<(), String>;

#[tauri::command]
async fn set_edge_gains_batch(updates: Vec<EdgeGainUpdate>) -> Result<(), String>;

// =============================================================================
// Plugin Commands
// =============================================================================

#[tauri::command]
async fn get_available_plugins() -> Result<Vec<PluginInfoDto>, String>;

#[tauri::command]
async fn add_plugin_to_bus(
    bus_handle: u32,
    plugin_id: String,
    position: Option<usize>,
) -> Result<String, String>;  // instanceId

#[tauri::command]
async fn remove_plugin_from_bus(
    bus_handle: u32,
    instance_id: String,
) -> Result<(), String>;

#[tauri::command]
async fn reorder_plugins(
    bus_handle: u32,
    instance_ids: Vec<String>,
) -> Result<(), String>;

#[tauri::command]
async fn open_plugin_ui(instance_id: String) -> Result<(), String>;

#[tauri::command]
async fn close_plugin_ui(instance_id: String) -> Result<(), String>;

// =============================================================================
// Meter Commands
// =============================================================================

#[tauri::command]
async fn get_meters() -> Result<GraphMetersDto, String>;

#[tauri::command]
async fn get_node_meters(handles: Vec<u32>) -> Result<Vec<NodeMeterDto>, String>;

#[tauri::command]
async fn get_edge_meters(ids: Vec<u32>) -> Result<Vec<EdgeMeterDto>, String>;

// =============================================================================
// State Commands
// =============================================================================

#[tauri::command]
async fn save_graph_state() -> Result<GraphStateDto, String>;

#[tauri::command]
async fn load_graph_state(state: GraphStateDto) -> Result<(), String>;

#[tauri::command]
async fn persist_state() -> Result<(), String>;

// =============================================================================
// System Commands
// =============================================================================

#[tauri::command]
async fn start_audio() -> Result<(), String>;

#[tauri::command]
async fn stop_audio() -> Result<(), String>;

#[tauri::command]
async fn get_system_status() -> Result<SystemStatusDto, String>;

#[tauri::command]
async fn set_buffer_size(size: u32) -> Result<(), String>;
```

---

### UIユースケースからの逆引き

| UI操作 | API呼び出し |
|--------|-------------|
| ソースをキャンバスに追加 | `addSourceNode({ type: 'prism', channel: 0 })` |
| デバイス入力を追加 | `addSourceNode({ type: 'device', deviceId: 123, channel: 0 })` |
| バスを追加 | `addBusNode("Bus 1", 2)` |
| 出力先を追加 | `addSinkNode({ deviceId: 100, channelOffset: 0, channelCount: 2 })` |
| ノードを削除 | `removeNode(handle)` |
| 接続を作成 | `addEdge(srcHandle, 0, dstHandle, 0)` |
| 接続を削除 | `removeEdge(edgeId)` |
| フェーダーを動かす | `setEdgeGain(edgeId, 0.8)` |
| ミュートボタン | `setEdgeMuted(edgeId, true)` |
| 複数フェーダー同時操作 | `setEdgeGainsBatch([...])` |
| プラグインを追加 | `addPluginToBus(busHandle, "aufx:xxxx:yyyy")` |
| プラグインUIを開く | `openPluginUI(instanceId)` |
| メーター更新 | `getMeters()` (16ms間隔) |
| 保存 | `persistState()` |
| 起動時復元 | `loadGraphState(savedState)` |

---

### メーター設計の詳細

```typescript
// メーターの取得パターン

// Pattern 1: 全メーター一括（シンプル、多くの場合これでOK）
const meters = await getMeters();

// Pattern 2: 特定ノードのみ（パフォーマンス最適化）
const nodeMeters = await getNodeMeters([handle1, handle2]);

// Pattern 3: 特定エッジのみ（Sends-on-Fader でフェーダー横にメーター表示）
const edgeMeters = await getEdgeMeters([edgeId1, edgeId2]);
```

**メーターデータの流れ:**

```
┌─────────────────────────────────────────────────────────────────┐
│                        Audio Thread                             │
│                                                                 │
│   process() {                                                   │
│     for edge in edges {                                         │
│       // ゲイン適用                                              │
│       apply_gain(edge.gain);                                    │
│       // エッジメーター計算                                       │
│       edge_meters[edge.id] = calculate_peak();                  │
│     }                                                           │
│     for node in nodes {                                         │
│       node.process();                                           │
│       // ノードメーター計算                                       │
│       node_meters[node.handle] = node.peak_levels();            │
│     }                                                           │
│     // メーターをArcSwapで公開                                    │
│     meters.store(Arc::new(GraphMeters { ... }));                │
│   }                                                             │
└────────────────────────────────┬────────────────────────────────┘
                                 │ ArcSwap (lock-free)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                        UI Thread                                │
│                                                                 │
│   useEffect(() => {                                             │
│     const interval = setInterval(async () => {                  │
│       const meters = await getMeters();                         │
│       setMeterState(meters);                                    │
│     }, 16);  // ~60fps                                          │
│     return () => clearInterval(interval);                       │
│   }, []);                                                       │
│                                                                 │
│   // レンダリング                                                │
│   {edges.map(edge => (                                          │
│     <Fader                                                      │
│       gain={edge.gain}                                          │
│       meter={meters.edges[edge.id]?.postGain.peak}              │
│       onChange={(g) => setEdgeGain(edge.id, g)}                 │
│     />                                                          │
│   ))}                                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

### Edge-Centric UI の考え方

Sends-on-Fader では、**Edge がフェーダーそのもの**。

```
従来のミキサー:
  チャンネルストリップ → フェーダー → バス/マスター

Sends-on-Fader:
  ソース ─── Edge (フェーダー) ───▶ ターゲット
             ↑
          gain, muted, meter
```

UI上では:
- 接続線上にフェーダーを表示
- または接続を選択した時にフェーダーパネルを表示
- メーターはEdge単位で表示（post-gain）

```typescript
// 接続（Edge）を選択した時のフェーダーUI
interface ConnectionFader {
  edgeId: EdgeId;
  source: { node: NodeInfo; port: PortId };
  target: { node: NodeInfo; port: PortId };
  gain: number;
  muted: boolean;
  meter: PortMeter;
}

function ConnectionPanel({ edge }: { edge: ConnectionFader }) {
  return (
    <div>
      <div>{edge.source.node.label}:{edge.source.port}</div>
      <Fader
        value={edge.gain}
        meter={edge.meter.peak}
        onChange={(g) => setEdgeGain(edge.edgeId, g)}
      />
      <MuteButton
        muted={edge.muted}
        onClick={() => setEdgeMuted(edge.edgeId, !edge.muted)}
      />
      <div>{edge.target.node.label}:{edge.target.port}</div>
    </div>
  );
}
```

### DTO (Rust側の型定義)

```rust
use serde::{Deserialize, Serialize};

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
#[serde(tag = "type")]
pub enum NodeInfoDto {
    #[serde(rename = "source")]
    Source {
        handle: NodeHandle,
        source_id: SourceIdDto,
        port_count: u8,
        label: String,
    },
    #[serde(rename = "bus")]
    Bus {
        handle: NodeHandle,
        bus_id: String,
        label: String,
        port_count: u8,
        plugins: Vec<PluginInstanceDto>,
    },
    #[serde(rename = "sink")]
    Sink {
        handle: NodeHandle,
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
    pub name: String,
    pub channel_count: u8,
    pub is_prism: bool,
    pub transport_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputDeviceDto {
    pub id: String,
    pub device_id: u32,
    pub channel_offset: u8,
    pub channel_count: u8,
    pub name: String,
    pub device_type: String,
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
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInstanceDto {
    pub instance_id: String,
    pub plugin_id: String,
    pub name: String,
    pub enabled: bool,
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
pub struct UIStateDto {
    pub node_positions: std::collections::HashMap<NodeHandle, NodePosition>,
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
```

---

## データフロー図

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              COMPLETE DATA FLOW                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

  Frontend (TypeScript/React)                    Backend (Rust/Tauri)
  ═══════════════════════════                    ════════════════════

  ┌─────────────────────┐                        ┌─────────────────────────────┐
  │    App.tsx          │                        │      Tauri Commands         │
  │                     │      invoke()          │                             │
  │  - Node UI          │ ─────────────────────▶ │  add_source_node()          │
  │  - Connection UI    │                        │  add_bus_node()             │
  │  - Fader UI         │ ◀───────────────────── │  add_sink_node()            │
  │                     │      Result/Event      │  add_edge()                 │
  │                     │                        │  set_edge_gain()            │
  └─────────────────────┘                        │  ...                        │
           │                                     └──────────────┬──────────────┘
           │                                                    │
           │ polling (16ms)                                     │
           │                                                    ▼
           │                                     ┌─────────────────────────────┐
           │                                     │       AudioGraph            │
           │                                     │                             │
           │                                     │  nodes: HashMap<Handle, _>  │
           │                                     │  edges: Vec<Edge>           │
           │                                     │  processing_order: Vec<_>   │
           │                                     │                             │
           │                                     └──────────────┬──────────────┘
           │                                                    │
           │                                     ArcSwap (lock-free read)
           │                                                    │
           │                                                    ▼
           │                                     ┌─────────────────────────────┐
           │                                     │     GraphProcessor          │
           │                                     │                             │
           │                                     │  process() ─────────────────┼──▶ Audio
           │                                     │    - clear_buffers()        │    Callback
           │                                     │    - mix edges              │    (48kHz)
           │                                     │    - node.process()         │
           │                                     │    - update_meters()        │
           │                                     │                             │
           │                                     └──────────────┬──────────────┘
           │                                                    │
           │                                     ArcSwap (lock-free read)
           │                                                    │
           │                                                    ▼
           │                                     ┌─────────────────────────────┐
           └────────────────────────────────────▶│       GraphMeters           │
                         get_meters()            │                             │
                                                 │  inputs: HashMap<Handle, _> │
                                                 │  buses: HashMap<Handle, _>  │
                                                 │  sinks: HashMap<Handle, _>  │
                                                 │  edges: HashMap<EdgeId, _>  │
                                                 │                             │
                                                 └─────────────────────────────┘
```

---

## 仮想デバイスの扱い

### 原則

```
物理デバイス: device_id + channel_offset = 0
集約デバイス: device_id + channel_offset = サブデバイスの開始位置
```

### 例

```
物理デバイス「Headphones」(device_id: 100, 2ch)
  → SinkId::OutputDevice { device_id: 100, channel_offset: 0, channel_count: 2 }
  → UI: "vout_100_0"

集約デバイス「Multi-Out」(device_id: 200, 6ch)
  ├─ SubDevice A: "Headphones" (ch 0-1)
  │    → SinkId::OutputDevice { device_id: 200, channel_offset: 0, channel_count: 2 }
  │    → UI: "vout_200_0"
  │
  ├─ SubDevice B: "Monitor" (ch 2-3)
  │    → SinkId::OutputDevice { device_id: 200, channel_offset: 2, channel_count: 2 }
  │    → UI: "vout_200_2"
  │
  └─ SubDevice C: "USB DAC" (ch 4-5)
       → SinkId::OutputDevice { device_id: 200, channel_offset: 4, channel_count: 2 }
       → UI: "vout_200_4"
```

### コード

```rust
/// 出力デバイスを取得（仮想デバイス展開済み）
pub fn get_output_devices() -> Vec<OutputDeviceDto> {
    let mut result = Vec::new();

    for device in get_audio_devices() {
        if !device.is_output {
            continue;
        }

        if is_aggregate_device(device.id) {
            // 集約デバイス: サブデバイスを仮想デバイスとして展開
            let mut offset = 0u8;
            for sub in get_aggregate_sub_devices(device.id) {
                result.push(OutputDeviceDto {
                    id: format!("vout_{}_{}", device.id, offset),
                    name: sub.name,
                    device_id: device.id,
                    channel_offset: offset,
                    channel_count: sub.output_channels as u8,
                    device_type: "aggregate_sub".to_string(),
                    icon_hint: get_icon_hint(&sub.name),
                });
                offset += sub.output_channels as u8;
            }
        } else {
            // 通常デバイス: そのまま
            result.push(OutputDeviceDto {
                id: format!("vout_{}_0", device.id),
                name: device.name.clone(),
                device_id: device.id,
                channel_offset: 0,
                channel_count: device.output_channels as u8,
                device_type: device.device_type.clone(),
                icon_hint: get_icon_hint(&device.name),
            });
        }
    }

    result
}
```

---

## 旧設計との比較

| 項目 | 旧設計 (v1) | 新設計 (v2) |
|------|-------------|-------------|
| NodeId | 16bit エンコード (種類埋め込み) | 単純な u32 ハンドル |
| ノード種類の判別 | NodeId をデコード | `node.node_type()` |
| BusConfig | fader, muted を持つ | プラグインチェーンのみ |
| レベル制御 | 複数箇所 (Send + Bus fader + Output fader) | Edge.gain のみ |
| 呼び出し側のロジック | ノード種類ごとに分岐 | 統一インターフェース (trait) |
| 仮想デバイス | UI + バックエンド両方で処理 | バックエンドで展開済み |
| 設定の矛盾 | 起こりうる | 構造的に不可能 |

---

## ファイル構成 (提案)

```
src-tauri/src/
├── audio/
│   ├── mod.rs
│   ├── node.rs          # AudioNode trait + NodeHandle
│   ├── source.rs        # SourceNode 実装
│   ├── bus.rs           # BusNode 実装
│   ├── sink.rs          # SinkNode 実装
│   ├── edge.rs          # Edge + EdgeId
│   ├── graph.rs         # AudioGraph
│   ├── processor.rs     # GraphProcessor
│   ├── buffer.rs        # AudioBuffer
│   └── meters.rs        # GraphMeters
├── capture/
│   ├── mod.rs
│   └── ring_buffer.rs   # 入力キャプチャ
├── output/
│   ├── mod.rs
│   └── callback.rs      # 出力コールバック
├── device/
│   ├── mod.rs
│   ├── enumerate.rs     # デバイス列挙
│   └── aggregate.rs     # 集約デバイス処理
├── plugin/
│   ├── mod.rs
│   └── audio_unit.rs    # AudioUnit ラッパー
├── api/
│   ├── mod.rs
│   ├── commands.rs      # Tauri コマンド
│   └── dto.rs           # DTO 定義
├── state/
│   ├── mod.rs
│   └── persistence.rs   # 状態保存/復元
├── lib.rs
└── main.rs
```

---

## 実装の優先順位

1. **Phase 1: 基盤**
   - AudioNode trait
   - AudioBuffer
   - NodeHandle, EdgeId, PortId
   - Edge

2. **Phase 2: ノード実装**
   - SourceNode (Prism channel)
   - SinkNode (simple)
   - 基本的な AudioGraph

3. **Phase 3: 処理エンジン**
   - GraphProcessor
   - 出力コールバック統合
   - メータリング

4. **Phase 4: 拡張**
   - BusNode + プラグイン
   - 外部入力デバイス
   - 集約デバイス (仮想デバイス)

5. **Phase 5: API + UI**
   - Tauri コマンド
   - 状態保存/復元
   - UI 更新

---

## まとめ

この v2 アーキテクチャでは:

1. **Pure Sends-on-Fader**: すべてのレベル制御を Edge に集約
2. **統一インターフェース**: AudioNode trait で共通処理
3. **シンプルな ID**: NodeHandle は不透明な識別子
4. **仮想デバイスの明確化**: SinkId で channel_offset を管理
5. **API の整理**: CRUD 操作が明確

これにより、設計の矛盾がなくなり、コードの見通しが良くなります。

---

## 実装進捗 (2025-12-09 更新)

### Phase 1: 基盤 ✅ 完了

| ファイル | 状態 | 内容 |
|----------|------|------|
| `audio/mod.rs` | ✅ | モジュールエクスポート |
| `audio/node.rs` | ✅ | AudioNode trait, NodeHandle, PortId, NodeType |
| `audio/buffer.rs` | ✅ | AudioBuffer (vDSP統合、MAX_FRAMES=4096) |
| `audio/edge.rs` | ✅ | Edge, EdgeId (Sends-on-Fader の核心) |
| `audio/meters.rs` | ✅ | PortMeter, NodeMeter, EdgeMeter, GraphMeters |

### Phase 2: ノード実装 ✅ 完了

| ファイル | 状態 | 内容 |
|----------|------|------|
| `audio/source.rs` | ✅ | SourceNode (PrismChannel, InputDevice) |
| `audio/bus.rs` | ✅ | BusNode (プラグインチェーン、fader/mute なし) |
| `audio/sink.rs` | ✅ | SinkNode (device_id, channel_offset, channel_count) |
| `audio/graph.rs` | ✅ | AudioGraph (HashMap, トポロジカルソート) |

### Phase 3: 処理エンジン 🔄 進行中

| ファイル | 状態 | 内容 |
|----------|------|------|
| `audio/processor.rs` | ✅ | GraphProcessor スケルトン (ArcSwap lock-free) |
| 出力コールバック統合 | ✅ | `audio/output.rs` 実装 |
| メータリング実装 | 🔄 | 基本構造のみ |

### Phase 4: 拡張 🔄 部分完了

| ファイル | 状態 | 内容 |
|----------|------|------|
| `capture/mod.rs` | ✅ | レガシー audio_capture ラッパー |
| `capture/ring_buffer.rs` | ✅ | ロックフリー RingBuffer |
| `device/mod.rs` | ✅ | デバイスモジュール |
| `device/enumerate.rs` | ✅ | 出力デバイス列挙 (aggregate対応) |
| BusNode プラグイン統合 | ❌ | 未実装 |

### Phase 5: API + UI ✅ API実装完了

| ファイル | 状態 | 内容 |
|----------|------|------|
| `api/mod.rs` | ✅ | APIモジュール |
| `api/dto.rs` | ✅ | 全DTO定義 (設計書通り) |
| `api/commands.rs` | ✅ | Tauriコマンド実装 (Graph/Edge/Meter/System) |
| `lib.rs` | ✅ | v2モジュール + レガシー互換 |
| UI更新 | ❌ | 未着手 |

### 修正済みの問題

1. ✅ `audio.rs` と `audio/mod.rs` のモジュール競合を解決
2. ✅ `audio_capture.rs` の `mixer` 依存を解消 (ローカル型定義)
3. ✅ `api/mod.rs` で `dto` をpublic化
4. ✅ `prismd.rs` に `get_processes()` 関数追加
5. ✅ `audio_unit::get_effect_audio_units()` を使用するよう修正
6. ✅ `processor` モジュールをpublic化
7. ✅ `graph.rs` の lifetime エラー修正
8. ✅ `GraphProcessor` にノード/エッジ操作API追加 (RwLock + ArcSwap)
9. ✅ `api/commands.rs` の全コマンド実装
10. ✅ `uuid` crate追加
11. ✅ State API実装 (save/load/persist/restore_state)
12. ✅ プラグイン管理コマンド実装 (add/remove/reorder)
13. ✅ NodeHandle::from_raw() 追加
14. ✅ 出力コールバック統合 (audio/output.rs)

### ビルド状態

```
✅ cargo build 成功 (警告あり、エラーなし)
```

### 実装済みAPI一覧

| カテゴリ | コマンド | 状態 |
|----------|----------|------|
| **Device** | `get_input_devices` | ✅ |
| | `get_output_devices` | ✅ |
| | `get_prism_status` | ✅ |
| **Graph** | `add_source_node` | ✅ |
| | `add_bus_node` | ✅ |
| | `add_sink_node` | ✅ |
| | `remove_node` | ✅ |
| | `add_edge` | ✅ |
| | `remove_edge` | ✅ |
| | `get_graph` | ✅ |
| **Edge** | `set_edge_gain` | ✅ |
| | `set_edge_muted` | ✅ |
| | `set_edge_gains_batch` | ✅ |
| **Plugin** | `get_available_plugins` | ✅ |
| | `add_plugin_to_bus` | ✅ |
| | `remove_plugin_from_bus` | ✅ |
| | `reorder_plugins` | ✅ |
| | `open_plugin_ui` | ❌ (AudioUnit統合待ち) |
| | `close_plugin_ui` | ❌ (AudioUnit統合待ち) |
| **Meter** | `get_meters` | ✅ |
| | `get_node_meters` | ✅ |
| | `get_edge_meters` | ✅ |
| **State** | `save_graph_state` | ✅ |
| | `load_graph_state` | ✅ |
| | `persist_state` | ✅ |
| | `restore_state` | ✅ |
| **System** | `start_audio` | ✅ |
| | `stop_audio` | ✅ |
| | `get_system_status` | ✅ |
| | `set_buffer_size` | ✅ |

### 次のステップ

1. **メータリング完全実装** - リアルタイムレベル計算とポーリングAPI
2. **BusNode プラグイン統合** - AudioUnit との連携
3. **Plugin UI コマンド** - `open_plugin_ui`, `close_plugin_ui` (AudioUnit統合後)
4. **Frontend更新** - v2 API に対応したUI
