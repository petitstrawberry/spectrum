//! Edge (Send) - All level control happens here

use super::node::{NodeHandle, PortId};

/// Edge の一意識別子
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EdgeId(u32);

impl EdgeId {
    pub(crate) fn new(id: u32) -> Self {
        Self(id)
    }

    pub fn raw(&self) -> u32 {
        self.0
    }
}

impl From<u32> for EdgeId {
    fn from(id: u32) -> Self {
        Self(id)
    }
}

impl From<EdgeId> for u32 {
    fn from(edge: EdgeId) -> Self {
        edge.0
    }
}

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

impl Edge {
    /// Create a new edge
    pub fn new(
        id: EdgeId,
        source: NodeHandle,
        source_port: PortId,
        target: NodeHandle,
        target_port: PortId,
    ) -> Self {
        Self {
            id,
            source,
            source_port,
            target,
            target_port,
            gain: 1.0,
            muted: false,
        }
    }

    /// このエッジが有効か（ミュートされておらず、ゲインがある）
    pub fn is_active(&self) -> bool {
        !self.muted && self.gain > 0.0001
    }

    /// Set gain (clamped to reasonable range)
    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.max(0.0);
    }

    /// Set muted state
    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }
}
