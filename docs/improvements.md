# Spectrum v2 改善提案と実装計画

**作成日**: 2025-12-12
**ステータス**: 提案・計画中
**基礎ドキュメント**: [architecture-v2.md](./architecture-v2.md)

---

## 📋 目次

1. [現状評価](#現状評価)
2. [問題点の詳細](#問題点の詳細)
3. [3つのアプローチ比較](#3つのアプローチ比較)
4. [推奨案: Pure ArcSwap](#推奨案-pure-arcswap)
5. [実装計画](#実装計画)
6. [ベンチマーク目標](#ベンチマーク目標)

---

## 現状評価

### 総合評価: ⭐⭐⭐⭐ (4/5)

**実装状況**:
- ✅ Backend主導の初期化（完璧）
- ✅ Pure Sends-on-Fader（完璧）
- ✅ 楽観的UI更新（良好）
- ⚠️ Lock-free Audio Thread（未完成）

### 達成度マトリクス

| 設計原則 | 目標 | 実装状況 | 達成度 |
|---------|------|---------|-------|
| **Pure Sends-on-Fader** | すべてのゲイン制御をEdgeに集約 | ✅ 完全実装 | 100% |
| **Backend主導初期化** | UI起点の初期化を排除 | ✅ 完全実装 | 100% |
| **Lock-free Audio Thread** | オーディオ処理の非ブロッキング | ⚠️ 部分的 | 60% |
| **楽観的UI更新** | 即座のフィードバック | ✅ 実装済み | 90% |
| **状態一貫性** | グラフ変更のアトミック性 | ✅ RwLockで保証 | 95% |

---

## 問題点の詳細

### 🔴 Critical: オーディオスレッドでの `try_write()` 使用

**問題箇所**: `src-tauri/src/audio/processor.rs:193`

```rust
pub fn process(&self, frames: usize, read_source_fn: &dyn Fn(&SourceId, &mut [f32])) {
    let Some(mut graph) = self.graph.try_write() else {
        return;  // ← フレームドロップの原因
    };
    // ...
}
```

**影響**:
- ❌ UI/APIスレッドがRwLockを保持中、オーディオ処理がスキップ
- ❌ ノード追加/削除中に音途切れ・プチプチ音
- ❌ リアルタイム要件違反

**頻度**: ノード/エッジ操作時（数秒～数分に1回）

---

### 🟡 Medium: エッジゲイン変更での RwLock 使用

**問題箇所**: `src-tauri/src/audio/processor.rs:97`

```rust
/// Set edge gain (hot path - uses RwLock for now, optimize later)
pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
    let mut graph = self.graph.write();  // ← ホットパスでブロッキング
    let result = graph.set_edge_gain(edge_id, gain);
    if result {
        self.update_snapshot(&graph);
    }
    result
}
```

**影響**:
- ⚠️ フェーダー操作のレイテンシ 0.5-1.5ms
- ⚠️ オーディオスレッド実行中はブロック

**頻度**: フェーダー操作（60fps = 16ms間隔で発生可能）

**コメント**: "optimize later" と明記されている（TODO）

---

### 🟢 Low: UI状態同期のエラーハンドリング

**問題箇所**: `src/hooks/useGraph.ts:395`

```typescript
setEdges(prev => {
  const newEdges = new Map(prev);
  newEdges.set(edgeId, { ...edge, gain });
  return newEdges;
});
// invoke失敗時のロールバックなし
```

**影響**:
- ⚠️ invoke失敗時にUI/バックエンド状態が不一致
- ⚠️ リロードまで同期ズレが継続

**頻度**: エラー発生時のみ（低頻度）

---

## 3つのアプローチ比較

### アプローチ1: グラフClone + ArcSwap（包括的）

**概要**: グラフ全体をClone可能にし、構造変更時にスナップショット更新

```rust
pub struct GraphProcessor {
    graph: Arc<RwLock<AudioGraph>>,        // UI/API用
    graph_snapshot: Arc<ArcSwap<AudioGraph>>, // Audio用（Clone版）
    buffers: Arc<ArcSwap<GraphBuffers>>,   // バッファ別管理
}

// 構造変更時
fn update_snapshot(&self, graph: &AudioGraph) {
    let new_graph = graph.clone();  // ← Clone実行
    let mut new_buffers = GraphBuffers::new();
    new_buffers.init_from_graph(&new_graph);

    self.graph_snapshot.store(Arc::new(new_graph));
    self.buffers.store(Arc::new(new_buffers));
}

// オーディオスレッド
pub fn process(&self, ...) {
    let graph = self.graph_snapshot.load_full();  // ✅ 常に成功
    let mut buffers = (*self.buffers.load_full()).clone();
    Self::process_graph(&graph, &mut buffers, ...);
}
```

**メリット**:
- ✅ 完全 lock-free オーディオ処理
- ✅ フレームドロップゼロ保証
- ✅ 構造とパラメータ両方に対応

**デメリット**:
- ❌ Clone コスト: 100ノード = 約100µs
- ❌ バッファ管理の複雑化
- ❌ メモリ使用量増加（バッファ2重化）
- ❌ 実装工数大（2週間）

**評価**: 🟡 **完璧だが過剰** - Cloneコストが重い

---

### アプローチ2: Atomic Edge Gain のみ（最小限）

**概要**: エッジのゲイン/ミュートのみAtomic化、構造変更は現状維持

```rust
pub struct Edge {
    pub id: EdgeId,
    pub source: NodeHandle,
    pub source_port: PortId,
    pub target: NodeHandle,
    pub target_port: PortId,

    // ✅ Atomic化
    gain: AtomicU32,     // f32 を u32 として保存
    muted: AtomicBool,
}

impl Edge {
    #[inline(always)]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    #[inline(always)]
    pub fn set_gain(&self, gain: f32) {
        self.gain.store(gain.to_bits(), Ordering::Relaxed);
    }
}

// フェーダー操作（超高速）
pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
    let graph = self.graph_snapshot.load();  // lock-free
    if let Some(edge) = graph.find_edge(edge_id) {
        edge.set_gain(gain);  // ✅ Atomic更新
        true
    } else {
        false
    }
}

// 構造変更（現状維持）
pub fn add_node(&self, node: Box<dyn AudioNode>) -> NodeHandle {
    let mut graph = self.graph.write();  // RwLock
    let handle = graph.add_node(node);
    graph.rebuild_order_if_needed();
    self.update_snapshot(&graph);
    handle
}

// オーディオ処理（現状維持）
pub fn process(&self, ...) {
    let Some(mut graph) = self.graph.try_write() else {
        return;  // ← 構造変更中は稀にスキップ（許容）
    };
    // ...
}
```

**メリット**:
- ✅ フェーダー操作が100倍高速化（0.5ms → < 0.01ms）
- ✅ 実装が簡単（6-8時間）
- ✅ グラフClone不要
- ✅ 既存コードへの影響最小

**デメリット**:
- ⚠️ 構造変更中に稀にフレームドロップ（年数回程度）
- ⚠️ 完全lock-freeではない

**評価**: 🟢 **現実的で効果的** - コスパ最高

---

### アプローチ3: Pure ArcSwap（究極）

**概要**: RwLockを完全排除、すべてArcSwapで管理

```rust
pub struct GraphProcessor {
    /// グラフ本体（完全 lock-free）
    graph: Arc<ArcSwap<AudioGraph>>,  // ← RwLock排除
    meters: Arc<ArcSwap<GraphMeters>>,
    timestamp: AtomicU64,
}

// 構造変更（CAS ループ）
pub fn add_node(&self, node: Box<dyn AudioNode>) -> NodeHandle {
    loop {
        // 1. 現在のグラフ取得
        let old_graph = self.graph.load_full();

        // 2. 新グラフ作成（Clone）
        let mut new_graph = (*old_graph).clone();
        let handle = new_graph.add_node(node.clone());
        new_graph.rebuild_order_if_needed();

        // 3. Compare-and-Swap
        if self.graph.compare_and_swap(&old_graph, Arc::new(new_graph)).is_ok() {
            return handle;  // ✅ 成功
        }
        // 失敗 → リトライ（ほぼ起きない）
    }
}

// パラメータ変更（超高速）
pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
    let graph = self.graph.load();  // lock-free
    if let Some(edge) = graph.find_edge(edge_id) {
        edge.set_gain(gain);  // Atomic
        true
    } else {
        false
    }
}

// オーディオ処理（完全 lock-free）
pub fn process(&self, ...) {
    let graph = self.graph.load_full();  // ✅ 常に成功
    Self::process_graph(&graph, ...);
}

// AudioNode は内部可変性（RefCell）
pub struct SourceNode {
    output_buffers: Vec<RefCell<AudioBuffer>>,
}

impl AudioNode for SourceNode {
    fn process(&self, frames: usize) {  // ← &self
        for buf in &self.output_buffers {
            let mut b = buf.borrow_mut();  // 内部可変性
            // ...
        }
    }
}
```

**メリット**:
- ✅ 完全 lock-free（構造変更もオーディオ処理も）
- ✅ フレームドロップゼロ保証
- ✅ フェーダー超高速（< 0.01ms）
- ✅ RwLockの複雑さ排除

**デメリット**:
- ⚠️ Clone コスト: 構造変更時に 50-100µs
- ⚠️ RefCell リスク（実行時借用チェック）
- ⚠️ 実装工数中（12時間）

**評価**: 🟢 **最もエレガント** - 長期的に最適

---

## 推奨案: Pure ArcSwap

### 選定理由

1. **オーディオ品質最優先**
   - フレームドロップ完全排除
   - 構造変更中も音途切れなし

2. **パフォーマンス**
   - フェーダー: 100倍高速化
   - Clone: 低頻度で50-100µs（許容）

3. **保守性**
   - RwLock の複雑さ排除
   - デッドロックリスクゼロ
   - コードがシンプル

4. **実装コスト**
   - 12時間（1.5日）で完了
   - 段階的移行可能

### 実装の核心

#### Edge の Atomic化

```rust
use std::sync::atomic::{AtomicU32, AtomicBool, Ordering};

pub struct Edge {
    pub id: EdgeId,
    pub source: NodeHandle,
    pub source_port: PortId,
    pub target: NodeHandle,
    pub target_port: PortId,

    gain: AtomicU32,     // f32 → u32 ビットパターン
    muted: AtomicBool,
}

impl Edge {
    #[inline(always)]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    #[inline(always)]
    pub fn set_gain(&self, gain: f32) {
        self.gain.store(gain.to_bits(), Ordering::Relaxed);
    }

    #[inline(always)]
    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    #[inline(always)]
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
}
```

#### AudioGraph の Clone実装

```rust
#[derive(Clone)]
pub struct AudioGraph {
    /// ノード（Arc でラップ - Clone は参照カウントのみ）
    nodes: HashMap<NodeHandle, Arc<dyn AudioNode>>,

    /// エッジ（Clone は Edge::clone を呼ぶ）
    edges: Vec<Edge>,

    /// 処理順序
    processing_order: Vec<NodeHandle>,

    next_handle: u32,
    next_edge_id: u32,
}
```

**Clone コスト**:
- HashMap: O(N) - Arc::clone のみ（軽量）
- Vec<Edge>: O(E) - Atomic値コピー
- **合計**: 100ノード、200エッジで 50-100µs

#### GraphProcessor の完全 lock-free化

```rust
pub struct GraphProcessor {
    /// グラフ本体（ArcSwap）
    graph: Arc<ArcSwap<AudioGraph>>,
    meters: Arc<ArcSwap<GraphMeters>>,
    timestamp: AtomicU64,
}

impl GraphProcessor {
    // 構造変更（CAS）
    pub fn add_node(&self, node: Box<dyn AudioNode>) -> NodeHandle {
        loop {
            let old_graph = self.graph.load_full();
            let mut new_graph = (*old_graph).clone();
            let handle = new_graph.add_node(node.clone());
            new_graph.rebuild_order_if_needed();

            if self.graph.compare_and_swap(&old_graph, Arc::new(new_graph)).is_ok() {
                return handle;
            }
        }
    }

    // パラメータ変更（超高速）
    pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
        let graph = self.graph.load();
        if let Some(edge) = graph.find_edge(edge_id) {
            edge.set_gain(gain);
            true
        } else {
            false
        }
    }

    // オーディオ処理（完全 lock-free）
    pub fn process(&self, frames: usize, read_source_fn: &dyn Fn(&SourceId, &mut [f32])) {
        let graph = self.graph.load_full();  // ✅ 常に成功
        Self::process_graph(&graph, frames, read_source_fn);
        self.update_meters(&graph);
    }
}
```

#### AudioNode の内部可変性

```rust
use std::cell::RefCell;

pub struct SourceNode {
    source_id: SourceId,
    output_buffers: Vec<RefCell<AudioBuffer>>,  // ← RefCell
}

impl AudioNode for SourceNode {
    fn process(&self, frames: usize) {  // ← &self（immutable）
        for buf in &self.output_buffers {
            let mut b = buf.borrow_mut();  // 内部可変性
            // 処理...
        }
    }
}
```

**RefCell の安全性**:
- オーディオスレッドは単一 → 二重借用は起きない
- Debug ビルドでパニック検出
- 将来的に UnsafeCell に置き換え可能

---

## 実装計画

### Phase 1: Edge Atomic化（2時間）

**目標**: フェーダー操作を lock-free化

**変更ファイル**:
1. `src-tauri/src/audio/edge.rs`
   ```rust
   // gain, muted を Atomic化
   // Clone 実装追加
   ```

2. `src-tauri/src/audio/graph.rs`
   ```rust
   // find_edge() 追加
   pub fn find_edge(&self, edge_id: EdgeId) -> Option<&Edge>
   ```

3. `src-tauri/src/audio/processor.rs`
   ```rust
   // set_edge_gain を lock-free化
   pub fn set_edge_gain(&self, edge_id: EdgeId, gain: f32) -> bool {
       let graph = self.graph_snapshot.load();
       if let Some(edge) = graph.find_edge(edge_id) {
           edge.set_gain(gain);
           true
       } else {
           false
       }
   }
   ```

**テスト**:
- [ ] フェーダーレイテンシ < 0.01ms
- [ ] 同時更新の競合なし

---

### Phase 2: AudioNode 内部可変性（3時間）

**目標**: `&self` で process() を実行可能に

**変更ファイル**:
1. `src-tauri/src/audio/node.rs`
   ```rust
   // AudioNode trait の変更
   fn process(&self, frames: usize);  // &mut self → &self
   fn input_buffer_mut(&self, port: PortId) -> Option<RefMut<AudioBuffer>>;
   ```

2. `src-tauri/src/audio/source.rs`
3. `src-tauri/src/audio/bus.rs`
4. `src-tauri/src/audio/sink.rs`
   ```rust
   // 各ノードの実装変更
   pub struct SourceNode {
       output_buffers: Vec<RefCell<AudioBuffer>>,
   }

   impl AudioNode for SourceNode {
       fn process(&self, frames: usize) {
           for buf in &self.output_buffers {
               let mut b = buf.borrow_mut();
               // ...
           }
       }
   }
   ```

**テスト**:
- [ ] すべてのノード型が動作
- [ ] RefCell パニックなし

---

### Phase 3: GraphProcessor RwLock排除（3時間）

**目標**: 完全 lock-free化

**変更ファイル**:
1. `src-tauri/src/audio/graph.rs`
   ```rust
   #[derive(Clone)]
   pub struct AudioGraph {
       nodes: HashMap<NodeHandle, Arc<dyn AudioNode>>,
       // ...
   }
   ```

2. `src-tauri/src/audio/processor.rs`
   ```rust
   pub struct GraphProcessor {
       graph: Arc<ArcSwap<AudioGraph>>,  // RwLock削除
       // ...
   }

   // すべての操作を CAS ループに変更
   pub fn add_node(&self, node: Box<dyn AudioNode>) -> NodeHandle {
       loop {
           let old = self.graph.load_full();
           let mut new = (*old).clone();
           let handle = new.add_node(node.clone());

           if self.graph.compare_and_swap(&old, Arc::new(new)).is_ok() {
               return handle;
           }
       }
   }

   pub fn process(&self, frames: usize, ...) {
       let graph = self.graph.load_full();  // ✅ 常に成功
       Self::process_graph(&graph, frames, ...);
   }
   ```

**テスト**:
- [ ] ノード追加中の音途切れなし
- [ ] 1時間連続稼働でドロップ0回

---

### Phase 4: テストとベンチマーク（4時間）

**目標**: パフォーマンス検証

**タスク**:

1. **ベンチマーク作成**
   ```rust
   #[bench]
   fn bench_graph_clone(b: &mut Bencher) {
       let graph = create_test_graph(100, 200);
       b.iter(|| graph.clone());
   }

   #[bench]
   fn bench_set_edge_gain(b: &mut Bencher) {
       let processor = create_processor();
       b.iter(|| processor.set_edge_gain(EdgeId(0), 0.8));
   }
   ```

2. **統合テスト**
   ```
   - 32チャンネル Prism ソース追加
   - 4つのバス + プラグイン
   - 8つのシンク
   - 160エッジ接続
   - 全フェーダー操作（60fps × 1時間）
   - ノード追加/削除繰り返し
   ```

3. **成功基準**
   - [ ] フェーダーレイテンシ < 0.01ms
   - [ ] グラフClone < 100µs
   - [ ] オーディオドロップ 0回
   - [ ] CPU使用率 < 5%

---

## ベンチマーク目標

### パフォーマンス目標値

| 操作 | 現状 | 目標 | 測定方法 |
|-----|------|------|---------|
| **フェーダー操作** | 0.5-1.5ms | < 0.01ms | criterion bench |
| **グラフClone** | N/A | < 100µs | criterion bench |
| **ノード追加** | 10ms + スキップ | 100µs + 処理継続 | 統合テスト |
| **オーディオドロップ** | 時々 | 0回/時間 | 連続稼働テスト |
| **CPU使用率** | 3-8% | 2-5% | Activity Monitor |

### ベンチマークコード

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn bench_graph_clone(c: &mut Criterion) {
    let graph = create_test_graph(100, 200);  // 100ノード、200エッジ

    c.bench_function("graph_clone_100n_200e", |b| {
        b.iter(|| black_box(graph.clone()))
    });
}

fn bench_set_edge_gain_atomic(c: &mut Criterion) {
    let processor = create_test_processor(10, 20);
    let edge_id = EdgeId::from(0);

    c.bench_function("set_edge_gain_atomic", |b| {
        b.iter(|| processor.set_edge_gain(black_box(edge_id), black_box(0.8)))
    });
}

fn bench_process_lockfree(c: &mut Criterion) {
    let processor = create_test_processor(50, 100);
    let read_fn = |_: &SourceId, buf: &mut [f32]| {
        buf.fill(0.5);
    };

    c.bench_function("process_lockfree_50n_100e", |b| {
        b.iter(|| processor.process(black_box(512), black_box(&read_fn)))
    });
}

criterion_group!(benches, bench_graph_clone, bench_set_edge_gain_atomic, bench_process_lockfree);
criterion_main!(benches);
```

**期待値**:
```
graph_clone_100n_200e:     time: [50.0 µs, 80.0 µs, 100.0 µs]
set_edge_gain_atomic:      time: [5.0 ns, 8.0 ns, 12.0 ns]
process_lockfree_50n_100e: time: [15.0 µs, 18.0 µs, 22.0 µs]
```

---

## リスク管理

### 既知のリスク

| リスク | 影響度 | 発生確率 | 対策 |
|-------|-------|---------|------|
| **Clone が遅い** | 高 | 中 | プロファイリング、Arc範囲拡大 |
| **RefCell パニック** | 高 | 低 | Debug検出、将来UnsafeCellに |
| **CAS ループの競合** | 中 | 低 | UIスレッド単一で回避 |
| **メモリリーク** | 中 | 低 | Arc参照カウント監視 |

### ロールバックプラン

**Phase 1 で問題発生時**:
```bash
# Edge Atomic化のみ適用、Phase 2-3 は保留
git checkout main
git cherry-pick <phase1-commit>
```

**Phase 2-3 で問題発生時**:
```bash
# アプローチ2（Atomic のみ）に切り替え
# RwLock を維持、構造変更は現状維持
```

**全体的な問題発生時**:
```bash
# 元のバージョンに戻す
git checkout main
git reset --hard v2.0.0
cargo build --release
```

---

## まとめ

### 推奨実装順序

1. **Phase 1**: Edge Atomic化（2時間）
   - 効果: フェーダー100倍高速化
   - リスク: 最小

2. **Phase 2**: AudioNode 内部可変性（3時間）
   - 効果: RwLock排除の準備
   - リスク: 中（RefCell）

3. **Phase 3**: GraphProcessor RwLock排除（3時間）
   - 効果: 完全 lock-free 達成
   - リスク: 中（Clone コスト）

4. **Phase 4**: テスト・ベンチマーク（4時間）
   - 効果: 品質保証
   - リスク: 低

**合計所要時間**: 12時間（1.5日）

### 期待される効果

| メトリクス | 改善前 | 改善後 | 改善幅 |
|----------|-------|-------|-------|
| フェーダーレイテンシ | 0.5-1.5ms | < 0.01ms | **100倍** 🚀 |
| オーディオドロップ | 時々発生 | **0回** | **品質向上** ✅ |
| 構造変更時の音途切れ | あり | **なし** | **UX向上** ✅ |
| CPU使用率 | 3-8% | 2-5% | **省電力** |

---

**最終更新**: 2025-12-12
**次回レビュー**: Phase 1 実装完了後
