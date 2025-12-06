//! CoreAudio Input Capture
//! Captures audio from any input device (including Prism) using broadcast ring buffers
//!
//! Architecture:
//! - Each input device runs its own capture thread
//! - Producer (input callback) writes to shared ring buffers per device
//! - Multiple consumers (output callbacks) can read the SAME data independently
//! - Each output device has its own read position via triple buffering

use crate::mixer::{ChannelLevels, PRISM_CHANNELS};
use crate::vdsp::VDsp;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_device_name, set_device_sample_rate,
};
use coreaudio::sys::{
    kAudioDevicePropertyBufferFrameSize, kAudioDevicePropertyScopeInput,
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster, AudioBuffer, AudioBufferList,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress, AudioObjectSetPropertyData,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread;

/// Maximum channels per device
const MAX_CHANNELS_PER_DEVICE: usize = 64;

/// Sample rate for audio capture
const SAMPLE_RATE: f64 = 48000.0;

/// Number of stereo pairs (legacy Prism)
const STEREO_PAIRS: usize = PRISM_CHANNELS / 2;

/// Ring buffer size per channel (fixed, large enough to prevent underrun)
/// 16384 frames at 48kHz = ~341ms buffer - enough for any I/O buffer size
const RING_BUFFER_SIZE: usize = 16384;

/// Default CoreAudio I/O buffer size (frames per callback)
/// 256 frames at 48kHz = ~5.3ms latency (good balance)
const DEFAULT_IO_BUFFER_SIZE: usize = 256;

/// Current CoreAudio I/O buffer size (can be changed at runtime)
static IO_BUFFER_SIZE: AtomicUsize = AtomicUsize::new(DEFAULT_IO_BUFFER_SIZE);

/// Shared level data - updated from audio thread (legacy Prism support)
static LEVEL_DATA: RwLock<[ChannelLevels; STEREO_PAIRS]> = 
    RwLock::new([ChannelLevels {
        left_rms: 0.0,
        right_rms: 0.0,
        left_peak: 0.0,
        right_peak: 0.0,
    }; STEREO_PAIRS]);

/// Whether Prism audio capture is running (legacy)
static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Prism device ID (0 if not found)
static PRISM_DEVICE_ID: AtomicU32 = AtomicU32::new(0);

// ============================================================================
// Per-Device Capture State
// ============================================================================

/// State for a single input device capture
struct InputDeviceState {
    device_id: u32,
    device_name: String,
    channel_count: usize,
    is_prism: bool,
    running: Arc<AtomicBool>,
    buffers: Arc<RwLock<DeviceBuffers>>,
    levels: Arc<RwLock<Vec<ChannelLevels>>>,
    /// Read positions per output device: output_device_id -> Vec<read_pos per channel>
    read_positions: Arc<RwLock<HashMap<u32, Vec<usize>>>>,
}

impl InputDeviceState {
    fn new(device_id: u32, device_name: String, channel_count: usize, is_prism: bool) -> Self {
        let stereo_pairs = channel_count / 2;
        Self {
            device_id,
            device_name,
            channel_count,
            is_prism,
            running: Arc::new(AtomicBool::new(false)),
            buffers: Arc::new(RwLock::new(DeviceBuffers::new(channel_count))),
            levels: Arc::new(RwLock::new(vec![ChannelLevels::default(); stereo_pairs.max(1)])),
            read_positions: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

/// Audio buffers for one input device
struct DeviceBuffers {
    channels: Vec<ChannelBuffer>,
    channel_count: usize,
}

impl DeviceBuffers {
    fn new(num_channels: usize) -> Self {
        let channels = (0..num_channels)
            .map(|_| ChannelBuffer::new(RING_BUFFER_SIZE))
            .collect();
        Self {
            channels,
            channel_count: num_channels,
        }
    }
}

/// All active input device captures: device_id -> state
static INPUT_DEVICES: LazyLock<RwLock<HashMap<u32, Arc<InputDeviceState>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

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

/// Legacy: Global audio buffers for Prism channels (backward compatibility)
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

/// Legacy: Global audio buffer storage
static AUDIO_BUFFERS: RwLock<Option<AudioBuffers>> = RwLock::new(None);

/// Legacy: Read positions for each output device (device_id -> Vec<read_pos per channel>)
static DEVICE_READ_POSITIONS: LazyLock<RwLock<HashMap<u32, Vec<usize>>>> = 
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Legacy: Global write frame counter (monotonic)
static WRITE_FRAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Legacy: Initialize audio buffers
fn init_audio_buffers() {
    let mut buffers = AUDIO_BUFFERS.write();
    if buffers.is_none() {
        *buffers = Some(AudioBuffers::new(PRISM_CHANNELS, RING_BUFFER_SIZE));
        println!("[AudioCapture] Ring buffers initialized: {} channels x {} samples ({:.1}ms at 48kHz)",
                 PRISM_CHANNELS, RING_BUFFER_SIZE, RING_BUFFER_SIZE as f64 / 48.0);
    }
}

/// Set device I/O buffer size (CoreAudio property)
fn set_device_buffer_size(device_id: u32, buffer_size: u32) -> Result<(), String> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyBufferFrameSize,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMaster,
    };
    
    let status = unsafe {
        AudioObjectSetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            std::mem::size_of::<u32>() as u32,
            &buffer_size as *const u32 as *const _,
        )
    };
    
    if status != 0 {
        return Err(format!("Failed to set buffer size: OSStatus {}", status));
    }
    
    println!("[AudioCapture] Device {} I/O buffer size set to {} samples ({:.1}ms)", 
             device_id, buffer_size, buffer_size as f64 / 48.0);
    Ok(())
}

/// Get device I/O buffer size (CoreAudio property)
fn get_device_buffer_size(device_id: u32) -> Option<u32> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyBufferFrameSize,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMaster,
    };
    
    let mut buffer_size: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut buffer_size as *mut u32 as *mut _,
        )
    };
    
    if status == 0 {
        Some(buffer_size)
    } else {
        None
    }
}

/// Find Prism device ID
pub fn find_prism_device() -> Option<u32> {
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
pub fn get_device_input_channels(device_id: u32) -> u32 {
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

    // Set I/O buffer size (affects latency)
    let io_buffer_size = IO_BUFFER_SIZE.load(Ordering::SeqCst) as u32;
    if let Err(e) = set_device_buffer_size(device_id, io_buffer_size) {
        println!("[AudioCapture] Warning: Could not set I/O buffer size: {}", e);
    }
    
    // Report actual buffer size
    if let Some(actual_size) = get_device_buffer_size(device_id) {
        println!("[AudioCapture] Actual device buffer size: {} samples ({:.1}ms)", 
                 actual_size, actual_size as f64 / 48.0);
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

/// Set CoreAudio I/O buffer size (frames per callback)
/// This directly affects latency: lower = less latency but more CPU
/// Valid values: 32, 64, 128, 256, 512, 1024
pub fn set_io_buffer_size(size: usize) {
    let size = size.max(32).min(2048);
    IO_BUFFER_SIZE.store(size, Ordering::SeqCst);
    println!("[AudioCapture] I/O buffer size set to {} samples ({:.1}ms at 48kHz)", 
             size, size as f64 / 48.0);
}

/// Get current I/O buffer size setting
pub fn get_io_buffer_size() -> usize {
    IO_BUFFER_SIZE.load(Ordering::SeqCst)
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
    
    // Initialize ring buffers (fixed size)
    init_audio_buffers();
    
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

// ============================================================================
// Generic Input Device Capture API
// ============================================================================

/// Get list of all input devices
pub fn get_input_devices() -> Vec<(u32, String, u32, bool)> {
    let mut devices = Vec::new();
    if let Ok(device_ids) = get_audio_device_ids() {
        for id in device_ids {
            let input_ch = get_device_input_channels(id);
            if input_ch > 0 {
                let name = get_device_name(id).unwrap_or_else(|_| format!("Device {}", id));
                let is_prism = name.to_lowercase().contains("prism");
                devices.push((id, name, input_ch, is_prism));
            }
        }
    }
    devices
}

/// Generic capture thread for any input device
fn generic_capture_thread(state: Arc<InputDeviceState>) {
    use coreaudio::audio_unit::audio_format::LinearPcmFlags;
    use coreaudio::audio_unit::render_callback::{self, data};
    use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};

    let device_id = state.device_id;
    println!(
        "[AudioCapture] Starting capture thread for device {} ({})",
        device_id, state.device_name
    );

    // Set sample rate
    if let Err(e) = set_device_sample_rate(device_id, SAMPLE_RATE) {
        println!("[AudioCapture] Warning: Could not set sample rate: {:?}", e);
    }

    // Set I/O buffer size
    let io_buffer_size = IO_BUFFER_SIZE.load(Ordering::SeqCst) as u32;
    if let Err(e) = set_device_buffer_size(device_id, io_buffer_size) {
        println!(
            "[AudioCapture] Warning: Could not set I/O buffer size: {}",
            e
        );
    }

    // Report actual buffer size
    if let Some(actual_size) = get_device_buffer_size(device_id) {
        println!(
            "[AudioCapture] Actual device buffer size: {} samples ({:.1}ms)",
            actual_size,
            actual_size as f64 / 48.0
        );
    }

    // Create HAL audio unit for input
    let audio_unit_result = AudioUnit::new(coreaudio::audio_unit::IOType::HalOutput);
    let mut audio_unit = match audio_unit_result {
        Ok(au) => au,
        Err(e) => {
            eprintln!("[AudioCapture] Failed to create audio unit: {:?}", e);
            state.running.store(false, Ordering::SeqCst);
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
        state.running.store(false, Ordering::SeqCst);
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
        state.running.store(false, Ordering::SeqCst);
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
        state.running.store(false, Ordering::SeqCst);
        return;
    }

    // Get input channel count
    let channels = state.channel_count.min(MAX_CHANNELS_PER_DEVICE) as u32;
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
        state.running.store(false, Ordering::SeqCst);
        return;
    }

    let running_callback = state.running.clone();
    let buffers = state.buffers.clone();
    let levels = state.levels.clone();
    let channel_count = channels as usize;
    let is_prism = state.is_prism;

    // Set input callback
    type Args = render_callback::Args<data::Interleaved<f32>>;

    if let Err(e) = audio_unit.set_input_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args {
            data, num_frames, ..
        } = args;
        let buffer = data.buffer;

        let frames = num_frames as usize;
        let num_channels = channel_count;
        let stereo_pairs = num_channels / 2;

        if buffer.len() < frames * num_channels {
            return Ok(());
        }

        // Write to broadcast buffers
        if let Some(device_buffers) = buffers.try_read() {
            // Deinterleave and write each channel
            for ch in 0..num_channels.min(device_buffers.channels.len()) {
                let mut channel_samples = Vec::with_capacity(frames);
                for frame in 0..frames {
                    channel_samples.push(buffer[frame * num_channels + ch]);
                }
                device_buffers.channels[ch].write(&channel_samples);
            }
        }

        // Calculate levels for each stereo pair
        if let Some(mut device_levels) = levels.try_write() {
            for pair in 0..stereo_pairs.min(device_levels.len()) {
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

                    let old = device_levels[pair];
                    let smooth = 0.3;

                    device_levels[pair] = ChannelLevels {
                        left_rms: old.left_rms * smooth + left_rms * (1.0 - smooth),
                        right_rms: old.right_rms * smooth + right_rms * (1.0 - smooth),
                        left_peak: left_peak.max(old.left_peak * 0.95),
                        right_peak: right_peak.max(old.right_peak * 0.95),
                    };
                }
            }

            // Also update legacy Prism levels if this is the Prism device
            if is_prism {
                if let Some(mut prism_levels) = LEVEL_DATA.try_write() {
                    for (i, level) in device_levels.iter().enumerate() {
                        if i < prism_levels.len() {
                            prism_levels[i] = *level;
                        }
                    }
                }
            }
        }

        Ok(())
    }) {
        eprintln!("[AudioCapture] Failed to set input callback: {:?}", e);
        state.running.store(false, Ordering::SeqCst);
        return;
    }

    // Initialize and start
    if let Err(e) = audio_unit.initialize() {
        eprintln!("[AudioCapture] Failed to initialize audio unit: {:?}", e);
        state.running.store(false, Ordering::SeqCst);
        return;
    }

    if let Err(e) = audio_unit.start() {
        eprintln!("[AudioCapture] Failed to start audio unit: {:?}", e);
        state.running.store(false, Ordering::SeqCst);
        return;
    }

    println!(
        "[AudioCapture] Capture started successfully for device {}",
        device_id
    );

    // Keep thread alive while running
    while state.running.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(100));
    }

    // Stop audio unit
    let _ = audio_unit.stop();
    println!(
        "[AudioCapture] Capture thread stopped for device {}",
        device_id
    );
}

/// Start capture from a specific input device
pub fn start_input_capture(device_id: u32) -> Result<bool, String> {
    // Check if already capturing
    {
        let devices = INPUT_DEVICES.read();
        if let Some(state) = devices.get(&device_id) {
            if state.running.load(Ordering::SeqCst) {
                return Ok(true); // Already running
            }
        }
    }

    // Get device info
    let device_name =
        get_device_name(device_id).map_err(|e| format!("Failed to get device name: {:?}", e))?;
    let channel_count = get_device_input_channels(device_id) as usize;

    if channel_count == 0 {
        return Err("Device has no input channels".to_string());
    }

    let is_prism = device_name.to_lowercase().contains("prism");

    // Create state
    let state = Arc::new(InputDeviceState::new(
        device_id,
        device_name.clone(),
        channel_count,
        is_prism,
    ));

    state.running.store(true, Ordering::SeqCst);

    // Store state
    {
        let mut devices = INPUT_DEVICES.write();
        devices.insert(device_id, state.clone());
    }

    // Update legacy Prism flag if this is Prism
    if is_prism {
        CAPTURE_RUNNING.store(true, Ordering::SeqCst);
        PRISM_DEVICE_ID.store(device_id, Ordering::SeqCst);
        // Also init legacy buffers for backward compatibility
        init_audio_buffers();
    }

    // Start capture thread
    let state_clone = state.clone();
    thread::spawn(move || {
        generic_capture_thread(state_clone);
    });

    println!(
        "[AudioCapture] Started capture for {} (ID: {}, {} channels)",
        device_name, device_id, channel_count
    );

    Ok(true)
}

/// Stop capture from a specific input device
pub fn stop_input_capture(device_id: u32) {
    let state = {
        let devices = INPUT_DEVICES.read();
        devices.get(&device_id).cloned()
    };

    if let Some(state) = state {
        state.running.store(false, Ordering::SeqCst);

        // Update legacy Prism flag if this is Prism
        if state.is_prism {
            CAPTURE_RUNNING.store(false, Ordering::SeqCst);
        }

        println!(
            "[AudioCapture] Stopping capture for device {} ({})",
            device_id, state.device_name
        );
    }

    // Wait a bit then remove from map
    thread::sleep(std::time::Duration::from_millis(150));
    {
        let mut devices = INPUT_DEVICES.write();
        devices.remove(&device_id);
    }
}

/// Stop all input captures
pub fn stop_all_captures() {
    let device_ids: Vec<u32> = {
        let devices = INPUT_DEVICES.read();
        devices.keys().copied().collect()
    };

    for device_id in device_ids {
        stop_input_capture(device_id);
    }
}

/// Get list of active input captures
pub fn get_active_captures() -> Vec<(u32, String, usize, bool)> {
    let devices = INPUT_DEVICES.read();
    devices
        .values()
        .filter(|s| s.running.load(Ordering::SeqCst))
        .map(|s| (s.device_id, s.device_name.clone(), s.channel_count, s.is_prism))
        .collect()
}

/// Check if a specific input device is being captured
pub fn is_device_capturing(device_id: u32) -> bool {
    let devices = INPUT_DEVICES.read();
    if let Some(state) = devices.get(&device_id) {
        state.running.load(Ordering::SeqCst)
    } else {
        false
    }
}

/// Get levels for a specific input device
pub fn get_input_device_levels(device_id: u32) -> Vec<ChannelLevels> {
    let devices = INPUT_DEVICES.read();
    if let Some(state) = devices.get(&device_id) {
        state.levels.read().clone()
    } else {
        Vec::new()
    }
}

/// Register an output device for reading from a specific input device
pub fn register_output_for_input(input_device_id: u32, output_device_id: u32) {
    let devices = INPUT_DEVICES.read();
    if let Some(state) = devices.get(&input_device_id) {
        let buffers = state.buffers.read();
        let mut positions = state.read_positions.write();
        if !positions.contains_key(&output_device_id) {
            let initial_positions: Vec<usize> = buffers
                .channels
                .iter()
                .map(|ch| ch.get_write_pos())
                .collect();
            positions.insert(output_device_id, initial_positions);
            println!(
                "[AudioCapture] Registered output {} for input {}",
                output_device_id, input_device_id
            );
        }
    }
}

/// Unregister an output device from a specific input device
pub fn unregister_output_for_input(input_device_id: u32, output_device_id: u32) {
    let devices = INPUT_DEVICES.read();
    if let Some(state) = devices.get(&input_device_id) {
        let mut positions = state.read_positions.write();
        if positions.remove(&output_device_id).is_some() {
            println!(
                "[AudioCapture] Unregistered output {} from input {}",
                output_device_id, input_device_id
            );
        }
    }
}

/// Read audio samples from a specific input device for a specific output device
pub fn read_input_audio(
    input_device_id: u32,
    output_device_id: u32,
    left_ch: usize,
    right_ch: usize,
    left_out: &mut [f32],
    right_out: &mut [f32],
) -> usize {
    let num_frames = left_out.len().min(right_out.len());

    // Initialize to silence
    left_out[..num_frames].fill(0.0);
    right_out[..num_frames].fill(0.0);

    let devices = match INPUT_DEVICES.try_read() {
        Some(d) => d,
        None => return 0,
    };

    let state = match devices.get(&input_device_id) {
        Some(s) => s,
        None => return 0,
    };

    let buffers = match state.buffers.try_read() {
        Some(b) => b,
        None => return 0,
    };

    if left_ch >= buffers.channels.len() || right_ch >= buffers.channels.len() {
        return 0;
    }

    let mut positions = match state.read_positions.try_write() {
        Some(p) => p,
        None => return 0,
    };

    let device_positions = match positions.get_mut(&output_device_id) {
        Some(p) => p,
        None => {
            // Auto-register
            drop(positions);
            drop(buffers);
            drop(devices);
            register_output_for_input(input_device_id, output_device_id);
            return 0; // Will work on next call
        }
    };

    // Read from left channel
    let left_read_pos = device_positions.get(left_ch).copied().unwrap_or(0);
    let new_left_pos = buffers.channels[left_ch].read(left_read_pos, left_out);
    if left_ch < device_positions.len() {
        device_positions[left_ch] = new_left_pos;
    }

    // Read from right channel
    let right_read_pos = device_positions.get(right_ch).copied().unwrap_or(0);
    let new_right_pos = buffers.channels[right_ch].read(right_read_pos, right_out);
    if right_ch < device_positions.len() {
        device_positions[right_ch] = new_right_pos;
    }

    num_frames
}

/// Get device info for a specific device
pub fn get_device_info(device_id: u32) -> Option<(String, u32, bool)> {
    let name = get_device_name(device_id).ok()?;
    let channels = get_device_input_channels(device_id);
    let is_prism = name.to_lowercase().contains("prism");
    Some((name, channels, is_prism))
}