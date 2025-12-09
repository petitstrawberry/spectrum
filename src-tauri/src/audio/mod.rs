//! Audio Graph Module - Pure Sends-on-Fader Architecture (v2)
//!
//! すべてのレベル制御は Edge (Send) で行う。
//! Node は処理のみを行い、レベル制御の責務を持たない。

mod buffer;
mod edge;
mod graph;
mod meters;
mod node;

pub mod bus;
pub mod processor;
pub mod sink;
pub mod source;

pub use buffer::AudioBuffer;
pub use edge::{Edge, EdgeId};
pub use graph::AudioGraph;
pub use meters::{EdgeMeter, GraphMeters, NodeMeter, PortMeter};
pub use node::{AudioNode, NodeHandle, NodeType, PortId};
pub use processor::{get_graph_processor, GraphProcessor};

/// Maximum frames per audio callback
pub const MAX_FRAMES: usize = 4096;

/// Default sample rate
pub const SAMPLE_RATE: f64 = 48000.0;
