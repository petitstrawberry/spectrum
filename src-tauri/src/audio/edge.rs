//! Edge (Send) - All level control happens here

use super::node::{NodeHandle, PortId};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

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
#[derive(Debug)]
pub struct EdgeParams {
    gain_bits: AtomicU32,
    muted: AtomicBool,
}

impl EdgeParams {
    pub fn new(gain: f32, muted: bool) -> Self {
        Self {
            gain_bits: AtomicU32::new(gain.max(0.0).to_bits()),
            muted: AtomicBool::new(muted),
        }
    }

    #[inline(always)]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain_bits.load(Ordering::Relaxed))
    }

    #[inline(always)]
    pub fn set_gain(&self, gain: f32) {
        self.gain_bits
            .store(gain.max(0.0).to_bits(), Ordering::Relaxed);
    }

    #[inline(always)]
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    #[inline(always)]
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
}

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
    /// 送りレベル/ミュート（共有 & Atomic）
    params: Arc<EdgeParams>,
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
            params: Arc::new(EdgeParams::new(1.0, false)),
        }
    }

    /// 送りレベル（リニアゲイン 0.0 ~ 2.0+）
    #[inline(always)]
    pub fn gain(&self) -> f32 {
        self.params.gain()
    }

    /// ミュート
    #[inline(always)]
    pub fn muted(&self) -> bool {
        self.params.muted()
    }

    /// このエッジが有効か（ミュートされておらず、ゲインがある）
    pub fn is_active(&self) -> bool {
        !self.muted() && self.gain() > 0.0001
    }

    /// Set gain (clamped to reasonable range)
    pub fn set_gain(&self, gain: f32) {
        self.params.set_gain(gain);
    }

    /// Set muted state
    pub fn set_muted(&self, muted: bool) {
        self.params.set_muted(muted);
    }
}
