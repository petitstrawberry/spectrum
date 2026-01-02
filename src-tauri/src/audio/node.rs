//! AudioNode trait and core types

use super::buffer::AudioBuffer;
use std::any::Any;

/// Node の一意識別子
///
/// 重要: NodeHandle は不透明なIDであり、ノードの種類を示さない。
/// ノードの種類はノード自体が持つ。これにより呼び出し側は
/// 統一されたインターフェースでノードを扱える。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeHandle(u32);

impl NodeHandle {
    /// 新しいハンドルを生成（内部でのみ使用）
    pub(crate) fn new(id: u32) -> Self {
        Self(id)
    }

    /// Get the raw ID value (for serialization)
    pub fn raw(&self) -> u32 {
        self.0
    }

    /// Create from raw ID value (for deserialization)
    pub fn from_raw(id: u32) -> Self {
        Self(id)
    }
}

impl From<u32> for NodeHandle {
    fn from(id: u32) -> Self {
        Self(id)
    }
}

impl From<NodeHandle> for u32 {
    fn from(handle: NodeHandle) -> Self {
        handle.0
    }
}

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

impl From<u8> for PortId {
    fn from(id: u8) -> Self {
        Self(id)
    }
}

impl From<PortId> for u8 {
    fn from(port: PortId) -> Self {
        port.0
    }
}

/// ノードの種類
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    Source,
    Bus,
    Sink,
}

/// オーディオノードの統一インターフェース
///
/// すべてのノード種類（Source, Bus, Sink）がこのトレイトを実装する。
/// これにより、グラフは具体的なノード種類を知らずに処理できる。
pub trait AudioNode: Send + Sync {
    /// ノードの種類を返す
    fn node_type(&self) -> NodeType;

    /// ノードのラベル（表示名）を返す
    fn label(&self) -> &str;

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

    /// 入力ピークレベルを取得（メータリング用）
    fn input_peak_levels(&self) -> Vec<f32>;

    /// 出力ピークレベルを取得（メータリング用）
    fn output_peak_levels(&self) -> Vec<f32>;

    /// Anyトレイトへのダウンキャスト用
    fn as_any(&self) -> &dyn Any;

    /// Anyトレイトへのダウンキャスト用（可変）
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
