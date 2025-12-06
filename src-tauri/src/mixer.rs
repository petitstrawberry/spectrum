//! Audio Mixer Engine
//! Uses Accelerate vDSP for hardware-accelerated mixing

use crate::vdsp::VDsp;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Maximum number of Prism channels (32 stereo pairs = 64 mono channels)
pub const PRISM_CHANNELS: usize = 64;
/// Maximum number of output devices
pub const MAX_OUTPUTS: usize = 16;
/// Maximum stereo pairs per output (e.g., 32 for a 64ch device)
pub const MAX_OUTPUT_PAIRS: usize = 32;

/// A send connection from a source channel to an output device channel (1ch unit)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Send {
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

/// Level meters for a channel pair
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ChannelLevels {
    pub left_rms: f32,
    pub right_rms: f32,
    pub left_peak: f32,
    pub right_peak: f32,
}

/// Global mixer state shared between audio thread and UI
pub struct MixerState {
    /// Send connections (source -> target mappings)
    pub sends: RwLock<Vec<Send>>,
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
    /// Sample rate
    pub sample_rate: RwLock<u32>,
    /// Buffer size
    pub buffer_size: RwLock<u32>,
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
            source_faders: RwLock::new([1.0; PRISM_CHANNELS / 2]),
            source_mutes: RwLock::new([false; PRISM_CHANNELS / 2]),
            output_faders: RwLock::new(HashMap::new()),
            input_levels: RwLock::new([ChannelLevels::default(); PRISM_CHANNELS / 2]),
            output_levels: RwLock::new(HashMap::new()),
            sample_rate: RwLock::new(48000),
            buffer_size: RwLock::new(128),
        }
    }

    /// Add or update a send (1ch unit)
    pub fn set_send(&self, send: Send) {
        let mut sends = self.sends.write();
        // Find existing send with same source/target channel
        if let Some(existing) = sends.iter_mut().find(|s| {
            s.source_channel == send.source_channel
                && s.target_device == send.target_device
                && s.target_channel == send.target_channel
        }) {
            println!("[Mixer] Updated send: src_ch={} -> dev={} tgt_ch={} level={} muted={}", 
                send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
            existing.level = send.level;
            existing.muted = send.muted;
        } else {
            println!("[Mixer] New send: src_ch={} -> dev={} tgt_ch={} level={} muted={}", 
                send.source_channel, send.target_device, send.target_channel, send.level, send.muted);
            sends.push(send);
        }
        println!("[Mixer] Total sends: {}", sends.len());
    }

    /// Remove a send (1ch unit)
    pub fn remove_send(&self, source_channel: u32, target_device: &str, target_channel: u32) {
        let mut sends = self.sends.write();
        sends.retain(|s| {
            !(s.source_channel == source_channel
                && s.target_device == target_device
                && s.target_channel == target_channel)
        });
    }

    /// Set source fader level (0-100 -> 0.0-1.0)
    pub fn set_source_fader(&self, pair_index: usize, level: f32) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_faders.write()[pair_index] = (level / 100.0).clamp(0.0, 1.0);
        }
    }

    /// Set source mute
    pub fn set_source_mute(&self, pair_index: usize, muted: bool) {
        if pair_index < PRISM_CHANNELS / 2 {
            self.source_mutes.write()[pair_index] = muted;
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
        self.output_faders
            .write()
            .insert(device_id.to_string(), gain);
    }

    /// Get all sends
    pub fn get_sends(&self) -> Vec<Send> {
        self.sends.read().clone()
    }

    /// Get input levels
    pub fn get_input_levels(&self) -> [ChannelLevels; PRISM_CHANNELS / 2] {
        *self.input_levels.read()
    }

    /// Get output levels for a device
    pub fn get_output_levels(&self, device_id: &str) -> Vec<ChannelLevels> {
        self.output_levels
            .read()
            .get(device_id)
            .cloned()
            .unwrap_or_default()
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
