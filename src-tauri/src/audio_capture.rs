//! CoreAudio Input Capture
//! Captures audio from Prism virtual device using broadcast ring buffers
//!
//! Architecture:
//! - Producer (input callback) writes to shared ring buffers
//! - Multiple consumers (output callbacks) can read the SAME data independently
//! - Each output device has its own read position via triple buffering

use crate::mixer::{ChannelLevels, PRISM_CHANNELS};
use crate::vdsp::VDsp;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_device_name, set_device_sample_rate,
};
use coreaudio::sys::{
    kAudioDevicePropertyScopeInput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster, AudioBuffer, AudioBufferList,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;

/// Sample rate for audio capture
const SAMPLE_RATE: f64 = 48000.0;

/// Number of stereo pairs
const STEREO_PAIRS: usize = PRISM_CHANNELS / 2;

/// Default ring buffer size per channel (in frames)
/// 4096 frames at 48kHz = ~85ms buffer
const DEFAULT_BUFFER_SIZE: usize = 4096;

/// Current buffer size (can be changed at runtime before starting)
static BUFFER_SIZE: AtomicUsize = AtomicUsize::new(DEFAULT_BUFFER_SIZE);

/// Shared level data - updated from audio thread
static LEVEL_DATA: RwLock<[ChannelLevels; STEREO_PAIRS]> = 
    RwLock::new([ChannelLevels {
        left_rms: 0.0,
        right_rms: 0.0,
        left_peak: 0.0,
        right_peak: 0.0,
    }; STEREO_PAIRS]);

/// Whether audio capture is running
static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Prism device ID (0 if not found)
static PRISM_DEVICE_ID: AtomicU32 = AtomicU32::new(0);

// ============================================================================
// Broadcast Ring Buffer Implementation
// ============================================================================
// Each channel has a circular buffer. The write position is shared globally.
// Each output device tracks its own read position per channel.
// This allows multiple outputs to read the same audio data independently.

/// Circular buffer for one audio channel
struct ChannelBuffer {
    data: Box<[f32]>,
    write_pos: AtomicUsize,
}

impl ChannelBuffer {
    fn new(size: usize) -> Self {
        Self {
            data: vec![0.0f32; size].into_boxed_slice(),
            write_pos: AtomicUsize::new(0),
        }
    }
    
    /// Write samples to the buffer (called from input callback)
    fn write(&self, samples: &[f32]) {
        let len = self.data.len();
        let mut pos = self.write_pos.load(Ordering::Acquire);
        
        // Safety: single writer (input callback), multiple readers
        let data_ptr = self.data.as_ptr() as *mut f32;
        
        for &sample in samples {
            unsafe {
                *data_ptr.add(pos) = sample;
            }
            pos = (pos + 1) % len;
        }
        
        self.write_pos.store(pos, Ordering::Release);
    }
    
    /// Read samples from the buffer starting at a specific position
    /// Returns the new read position
    fn read(&self, read_pos: usize, out: &mut [f32]) -> usize {
        let len = self.data.len();
        let write_pos = self.write_pos.load(Ordering::Acquire);
        
        // Normalize read_pos to be within buffer bounds (handles buffer resize)
        let read_pos = read_pos % len;
        
        // Calculate available samples
        let available = if write_pos >= read_pos {
            write_pos - read_pos
        } else {
            len - read_pos + write_pos
        };
        
        let to_read = out.len().min(available);
        let mut pos = read_pos;
        
        for i in 0..to_read {
            out[i] = self.data[pos];
            pos = (pos + 1) % len;
        }
        
        // Fill remaining with silence if not enough samples
        for i in to_read..out.len() {
            out[i] = 0.0;
        }
        
        pos
    }
    
    fn get_write_pos(&self) -> usize {
        self.write_pos.load(Ordering::Acquire)
    }
}

/// Global audio buffers for all channels
struct AudioBuffers {
    channels: Vec<ChannelBuffer>,
    buffer_size: usize,
}

impl AudioBuffers {
    fn new(num_channels: usize, buffer_size: usize) -> Self {
        let channels = (0..num_channels)
            .map(|_| ChannelBuffer::new(buffer_size))
            .collect();
        Self { channels, buffer_size }
    }
}

/// Global audio buffer storage
static AUDIO_BUFFERS: RwLock<Option<AudioBuffers>> = RwLock::new(None);

/// Read positions for each output device (device_id -> Vec<read_pos per channel>)
static DEVICE_READ_POSITIONS: LazyLock<RwLock<HashMap<u32, Vec<usize>>>> = 
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Global write frame counter (monotonic)
static WRITE_FRAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Initialize audio buffers
fn init_audio_buffers(buffer_size: usize) {
    let mut buffers = AUDIO_BUFFERS.write();
    if buffers.is_none() {
        *buffers = Some(AudioBuffers::new(PRISM_CHANNELS, buffer_size));
        println!("[AudioCapture] Broadcast buffers initialized: {} channels x {} samples ({:.1}ms at 48kHz)",
                 PRISM_CHANNELS, buffer_size, buffer_size as f64 / 48.0);
    }
}

/// Find Prism device ID
fn find_prism_device() -> Option<u32> {
    let device_ids = get_audio_device_ids().ok()?;
    
    for id in device_ids {
        if let Ok(name) = get_device_name(id) {
            let lower = name.to_lowercase();
            if lower.contains("prism") {
                let input_ch = get_device_input_channels(id);
                if input_ch > 0 {
                    println!("[AudioCapture] Found Prism device: {} (ID: {}, {} input channels)", name, id, input_ch);
                    return Some(id);
                }
            }
        }
    }
    None
}

/// Get number of input channels for a device
fn get_device_input_channels(device_id: u32) -> u32 {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut size: u32 = 0;
    let status = unsafe {
        AudioObjectGetPropertyDataSize(device_id, &address, 0, ptr::null(), &mut size)
    };

    if status != 0 || size == 0 {
        return 0;
    }

    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            buffer.as_mut_ptr() as *mut _,
        )
    };

    if status != 0 {
        return 0;
    }

    let buffer_list = unsafe { &*(buffer.as_ptr() as *const AudioBufferList) };
    let num_buffers = buffer_list.mNumberBuffers;

    if num_buffers == 0 {
        return 0;
    }

    let mut total_channels = 0u32;
    let buffers_ptr: *const AudioBuffer = &buffer_list.mBuffers as *const _;

    for i in 0..num_buffers {
        let audio_buffer = unsafe { &*buffers_ptr.add(i as usize) };
        total_channels += audio_buffer.mNumberChannels;
    }

    total_channels
}

/// Audio capture thread function
fn capture_thread(device_id: u32, running: Arc<AtomicBool>) {
    use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
    use coreaudio::audio_unit::audio_format::LinearPcmFlags;
    use coreaudio::audio_unit::render_callback::{self, data};

    println!("[AudioCapture] Starting capture thread for device {}", device_id);

    // Set sample rate
    if let Err(e) = set_device_sample_rate(device_id, SAMPLE_RATE) {
        println!("[AudioCapture] Warning: Could not set sample rate: {:?}", e);
    }

    // Create HAL audio unit for input
    let audio_unit_result = AudioUnit::new(coreaudio::audio_unit::IOType::HalOutput);
    let mut audio_unit = match audio_unit_result {
        Ok(au) => au,
        Err(e) => {
            eprintln!("[AudioCapture] Failed to create audio unit: {:?}", e);
            running.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Enable input
    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
        Scope::Input,
        Element::Input,
        Some(&1u32),
    ) {
        eprintln!("[AudioCapture] Failed to enable input: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Disable output
    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioOutputUnitProperty_EnableIO,
        Scope::Output,
        Element::Output,
        Some(&0u32),
    ) {
        eprintln!("[AudioCapture] Failed to disable output: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Set device
    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioOutputUnitProperty_CurrentDevice,
        Scope::Global,
        Element::Output,
        Some(&device_id),
    ) {
        eprintln!("[AudioCapture] Failed to set device: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Get input channel count
    let input_channels = get_device_input_channels(device_id);
    let channels = input_channels.min(PRISM_CHANNELS as u32);
    
    println!("[AudioCapture] Using {} channels", channels);

    // Set stream format
    let stream_format = StreamFormat {
        sample_rate: SAMPLE_RATE,
        sample_format: SampleFormat::F32,
        flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
        channels,
    };

    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioUnitProperty_StreamFormat,
        Scope::Output,
        Element::Input,
        Some(&stream_format.to_asbd()),
    ) {
        eprintln!("[AudioCapture] Failed to set stream format: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    let running_callback = running.clone();
    let channel_count = channels as usize;

    // Set input callback
    type Args = render_callback::Args<data::Interleaved<f32>>;
    
    if let Err(e) = audio_unit.set_input_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args { data, num_frames, .. } = args;
        let buffer = data.buffer;
        
        let frames = num_frames as usize;
        let num_channels = channel_count;
        let stereo_pairs = num_channels / 2;
        
        if buffer.len() < frames * num_channels {
            return Ok(());
        }

        // Write to broadcast buffers
        if let Some(audio_buffers) = AUDIO_BUFFERS.try_read() {
            if let Some(ref buffers) = *audio_buffers {
                // Deinterleave and write each channel
                for ch in 0..num_channels.min(buffers.channels.len()) {
                    let mut channel_samples = Vec::with_capacity(frames);
                    for frame in 0..frames {
                        channel_samples.push(buffer[frame * num_channels + ch]);
                    }
                    buffers.channels[ch].write(&channel_samples);
                }
                
                // Update frame counter
                WRITE_FRAME_COUNTER.fetch_add(frames as u64, Ordering::Relaxed);
            }
        }

        // Calculate levels for each stereo pair (with lock for UI)
        if let Some(mut levels) = LEVEL_DATA.try_write() {
            for pair in 0..stereo_pairs.min(STEREO_PAIRS) {
                let left_ch = pair * 2;
                let right_ch = pair * 2 + 1;

                let mut left_data: Vec<f32> = Vec::with_capacity(frames);
                let mut right_data: Vec<f32> = Vec::with_capacity(frames);
                
                for frame in 0..frames {
                    let base = frame * num_channels;
                    if base + right_ch < buffer.len() {
                        left_data.push(buffer[base + left_ch]);
                        right_data.push(buffer[base + right_ch]);
                    }
                }

                if !left_data.is_empty() && !right_data.is_empty() {
                    let left_rms = VDsp::rms(&left_data);
                    let right_rms = VDsp::rms(&right_data);
                    let left_peak = VDsp::peak(&left_data);
                    let right_peak = VDsp::peak(&right_data);

                    let old = levels[pair];
                    let smooth = 0.3;
                    
                    levels[pair] = ChannelLevels {
                        left_rms: old.left_rms * smooth + left_rms * (1.0 - smooth),
                        right_rms: old.right_rms * smooth + right_rms * (1.0 - smooth),
                        left_peak: left_peak.max(old.left_peak * 0.95),
                        right_peak: right_peak.max(old.right_peak * 0.95),
                    };
                }
            }
        }

        Ok(())
    }) {
        eprintln!("[AudioCapture] Failed to set input callback: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Initialize and start
    if let Err(e) = audio_unit.initialize() {
        eprintln!("[AudioCapture] Failed to initialize audio unit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    if let Err(e) = audio_unit.start() {
        eprintln!("[AudioCapture] Failed to start audio unit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    println!("[AudioCapture] Capture started successfully");

    // Keep thread alive while running
    while running.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(100));
    }

    // Stop audio unit
    let _ = audio_unit.stop();
    println!("[AudioCapture] Capture thread stopped");
}

// --- Public API ---

/// Set buffer size (in samples per channel)
/// This should be called before starting capture
#[allow(dead_code)]
pub fn set_buffer_size(size: usize) {
    let size = size.max(512).min(65536);
    BUFFER_SIZE.store(size, Ordering::SeqCst);
    println!("[AudioCapture] Buffer size set to {} samples ({:.1}ms at 48kHz)", 
             size, size as f64 / 48.0);
}

/// Get current buffer size setting
#[allow(dead_code)]
pub fn get_buffer_size_setting() -> usize {
    BUFFER_SIZE.load(Ordering::SeqCst)
}

/// Initialize and start audio capture
pub fn start_capture() -> Result<bool, String> {
    if CAPTURE_RUNNING.load(Ordering::SeqCst) {
        return Ok(true);
    }

    let device_id = match find_prism_device() {
        Some(id) => id,
        None => {
            println!("[AudioCapture] Prism device not found");
            return Ok(false);
        }
    };

    PRISM_DEVICE_ID.store(device_id, Ordering::SeqCst);
    
    // Initialize broadcast buffers
    let buffer_size = BUFFER_SIZE.load(Ordering::SeqCst);
    init_audio_buffers(buffer_size);
    
    let running = Arc::new(AtomicBool::new(true));
    CAPTURE_RUNNING.store(true, Ordering::SeqCst);
    
    let running_clone = running.clone();
    thread::spawn(move || {
        capture_thread(device_id, running_clone);
        CAPTURE_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(true)
}

/// Stop audio capture
pub fn stop_capture() {
    CAPTURE_RUNNING.store(false, Ordering::SeqCst);
    // Give some time for threads to stop
    std::thread::sleep(std::time::Duration::from_millis(150));
}

/// Restart audio capture with new settings
pub fn restart_capture() -> Result<bool, String> {
    println!("[AudioCapture] Restarting capture...");
    
    // Stop current capture
    if CAPTURE_RUNNING.load(Ordering::SeqCst) {
        stop_capture();
    }
    
    // Clear all device read positions (critical for avoiding position mismatch!)
    {
        let mut positions = DEVICE_READ_POSITIONS.write();
        positions.clear();
        println!("[AudioCapture] Cleared all device read positions");
    }
    
    // Clear existing buffers
    {
        let mut buffers = AUDIO_BUFFERS.write();
        *buffers = None;
    }
    
    // Wait a bit more for output devices to notice the missing buffers
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    // Start capture again (will use new buffer size)
    let result = start_capture();
    
    // After restart, give time for buffers to fill before outputs read
    std::thread::sleep(std::time::Duration::from_millis(50));
    
    result
}

/// Get current input levels
pub fn get_capture_levels() -> Vec<ChannelLevels> {
    if !CAPTURE_RUNNING.load(Ordering::SeqCst) {
        return vec![ChannelLevels::default(); STEREO_PAIRS];
    }
    
    LEVEL_DATA.read().to_vec()
}

/// Check if capture is running
pub fn is_capture_running() -> bool {
    CAPTURE_RUNNING.load(Ordering::SeqCst)
}

/// Register an output device for reading audio
/// Must be called before reading audio from a device
pub fn register_output_device(device_id: u32) {
    let buffers = AUDIO_BUFFERS.read();
    if let Some(ref audio_buffers) = *buffers {
        let mut positions = DEVICE_READ_POSITIONS.write();
        if !positions.contains_key(&device_id) {
            // Initialize read positions to current write position (start fresh)
            let initial_positions: Vec<usize> = audio_buffers.channels
                .iter()
                .map(|ch| ch.get_write_pos())
                .collect();
            positions.insert(device_id, initial_positions);
            println!("[AudioCapture] Registered output device {} for reading", device_id);
        }
    }
}

/// Unregister an output device
pub fn unregister_output_device(device_id: u32) {
    let mut positions = DEVICE_READ_POSITIONS.write();
    if positions.remove(&device_id).is_some() {
        println!("[AudioCapture] Unregistered output device {}", device_id);
    }
}

/// Read audio samples for specific channels - non-consuming!
/// Each output device reads from its own position, allowing multiple outputs
/// to read the same source audio independently.
/// Returns the number of frames actually read
pub fn read_channel_audio(
    device_id: u32,
    left_ch: usize, 
    right_ch: usize, 
    left_out: &mut [f32],
    right_out: &mut [f32],
) -> usize {
    let num_frames = left_out.len().min(right_out.len());
    
    // Initialize to silence
    left_out[..num_frames].fill(0.0);
    right_out[..num_frames].fill(0.0);
    
    let buffers = match AUDIO_BUFFERS.try_read() {
        Some(b) => b,
        None => return 0,
    };
    
    let audio_buffers = match buffers.as_ref() {
        Some(b) => b,
        None => return 0,
    };
    
    if left_ch >= audio_buffers.channels.len() || right_ch >= audio_buffers.channels.len() {
        return 0;
    }
    
    // Get and update read positions for this device
    let mut positions = match DEVICE_READ_POSITIONS.try_write() {
        Some(p) => p,
        None => return 0,
    };
    
    let device_positions = match positions.get_mut(&device_id) {
        Some(p) => p,
        None => {
            // Device not registered, register now with current write positions
            drop(positions);
            register_output_device(device_id);
            // Try again
            positions = match DEVICE_READ_POSITIONS.try_write() {
                Some(p) => p,
                None => return 0,
            };
            match positions.get_mut(&device_id) {
                Some(p) => p,
                None => return 0,
            }
        }
    };
    
    // Read from left channel
    let left_read_pos = device_positions.get(left_ch).copied().unwrap_or(0);
    let new_left_pos = audio_buffers.channels[left_ch].read(left_read_pos, left_out);
    if left_ch < device_positions.len() {
        device_positions[left_ch] = new_left_pos;
    }
    
    // Read from right channel
    let right_read_pos = device_positions.get(right_ch).copied().unwrap_or(0);
    let new_right_pos = audio_buffers.channels[right_ch].read(right_read_pos, right_out);
    if right_ch < device_positions.len() {
        device_positions[right_ch] = new_right_pos;
    }
    
    num_frames
}

/// Legacy API - deprecated, use read_channel_audio instead
/// This is kept for compatibility but now just wraps read_channel_audio
pub fn pop_channel_audio(
    left_ch: usize, 
    right_ch: usize, 
    left_out: &mut [f32],
    right_out: &mut [f32],
) -> usize {
    // Use device_id 0 as a fallback for legacy callers
    read_channel_audio(0, left_ch, right_ch, left_out, right_out)
}

/// Update mixer state with captured levels
pub fn update_mixer_levels() {
    use crate::mixer::get_mixer_state;
    
    let levels = get_capture_levels();
    let mixer_state = get_mixer_state();
    let mut input_levels = mixer_state.input_levels.write();
    
    for (i, level) in levels.iter().enumerate() {
        if i < input_levels.len() {
            input_levels[i] = *level;
        }
    }
}
