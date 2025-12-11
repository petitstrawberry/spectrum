//! Audio Output Module (v2)
//!
//! GraphProcessor ベースの出力コールバック実装
//!
//! ## 設計
//! - GraphProcessor.process() でグラフ全体を処理
//! - SinkNode の入力バッファから出力デバイスに書き込み
//! - 各デバイスに対して1つの AudioUnit コールバック

use crate::audio::processor::get_graph_processor;
use crate::audio::sink::SinkNode;
use crate::audio::source::SourceId;
use crate::vdsp::VDsp;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_device_name, set_device_sample_rate,
};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::sys::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster,
    AudioBufferList, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
};
use parking_lot::RwLock;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

/// Sample rate for audio output
const SAMPLE_RATE: f64 = 48000.0;

/// Maximum frames per callback
const MAX_FRAMES: usize = crate::audio::MAX_FRAMES;

/// Active output state (AudioUnit is managed in thread, not stored here)
struct ActiveOutput {
    device_id: u32,
    running: Arc<AtomicBool>,
}

/// Global active output (single device at a time)
static ACTIVE_OUTPUT: LazyLock<RwLock<Option<ActiveOutput>>> =
    LazyLock::new(|| RwLock::new(None));

/// Get output channel count for a device
fn get_device_output_channels(device_id: u32) -> u32 {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
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
    let buffers_ptr = &buffer_list.mBuffers as *const coreaudio::sys::AudioBuffer;

    for i in 0..num_buffers {
        let audio_buffer = unsafe { &*buffers_ptr.add(i as usize) };
        total_channels += audio_buffer.mNumberChannels;
    }

    total_channels
}

/// Start audio output for a device (v2 architecture)
pub fn start_output_v2(device_id: u32) -> Result<(), String> {
    // Check if already running with same device
    {
        let active = ACTIVE_OUTPUT.read();
        if let Some(ref output) = *active {
            if output.device_id == device_id && output.running.load(Ordering::Relaxed) {
                return Ok(()); // Already running
            }
        }
    }

    // Stop any existing output
    stop_output_v2();

    let output_channels = get_device_output_channels(device_id);
    if output_channels == 0 {
        return Err(format!("Device {} has no output channels", device_id));
    }

    let device_name = get_device_name(device_id)
        .unwrap_or_else(|_| format!("Device {}", device_id));
    println!("[AudioOutput v2] Starting output to {} (ID: {}, {} channels)",
             device_name, device_id, output_channels);

    // Set sample rate
    if let Err(e) = set_device_sample_rate(device_id, SAMPLE_RATE) {
        eprintln!("[AudioOutput v2] Warning: Could not set sample rate: {:?}", e);
    }

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Store as active output
    {
        let mut active = ACTIVE_OUTPUT.write();
        *active = Some(ActiveOutput {
            device_id,
            running: running.clone(),
        });
    }

    // Start output thread
    std::thread::spawn(move || {
        output_thread_v2(device_id, output_channels, running_clone);
    });

    Ok(())
}

/// Output thread function - v2 architecture using GraphProcessor
fn output_thread_v2(device_id: u32, output_channels: u32, running: Arc<AtomicBool>) {
    // Create audio unit for output
    let mut audio_unit = match AudioUnit::new(coreaudio::audio_unit::IOType::HalOutput) {
        Ok(au) => au,
        Err(e) => {
            eprintln!("[AudioOutput v2] Failed to create audio unit: {:?}", e);
            running.store(false, Ordering::SeqCst);
            return;
        }
    };

    // Set output device
    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioOutputUnitProperty_CurrentDevice,
        Scope::Global,
        Element::Output,
        Some(&device_id),
    ) {
        eprintln!("[AudioOutput v2] Failed to set device: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Set stream format
    let stream_format = StreamFormat {
        sample_rate: SAMPLE_RATE,
        sample_format: SampleFormat::F32,
        flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
        channels: output_channels,
    };

    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioUnitProperty_StreamFormat,
        Scope::Input,
        Element::Output,
        Some(&stream_format.to_asbd()),
    ) {
        eprintln!("[AudioOutput v2] Failed to set stream format: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    let running_callback = running.clone();
    let out_ch = output_channels as usize;

    // Set render callback
    type Args = render_callback::Args<data::Interleaved<f32>>;

    if let Err(e) = audio_unit.set_render_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args { data, num_frames, .. } = args;
        let buffer = data.buffer;
        let frames = num_frames as usize;

        if frames > MAX_FRAMES {
            return Ok(());
        }

        // Clear output buffer
        VDsp::clear(buffer);

        // Get graph processor
        let processor = get_graph_processor();

        // Define source reader (reads from capture system)
        let read_source = |source_id: &SourceId, buf: &mut [f32]| {
            match source_id {
                SourceId::PrismChannel { channel } => {
                    // Read mono channel - use channel as pair index * 2 + offset
                    let pair_idx = *channel / 2;
                    let is_right = *channel % 2 == 1;
                    let mut dummy = vec![0.0f32; buf.len()];
                    if is_right {
                        crate::audio_capture::read_channel_audio_any(
                            (pair_idx * 2) as usize,
                            (pair_idx * 2 + 1) as usize,
                            &mut dummy,
                            buf,
                        );
                    } else {
                        crate::audio_capture::read_channel_audio_any(
                            (pair_idx * 2) as usize,
                            (pair_idx * 2 + 1) as usize,
                            buf,
                            &mut dummy,
                        );
                    }
                }
                SourceId::InputDevice { device_id: dev_id, channel } => {
                    // Read from input device
                    let pair_idx = *channel / 2;
                    let is_right = *channel % 2 == 1;
                    let mut dummy = vec![0.0f32; buf.len()];
                    if is_right {
                        crate::audio_capture::read_channel_audio(
                            *dev_id,
                            (pair_idx * 2) as usize,
                            (pair_idx * 2 + 1) as usize,
                            &mut dummy,
                            buf,
                        );
                    } else {
                        crate::audio_capture::read_channel_audio(
                            *dev_id,
                            (pair_idx * 2) as usize,
                            (pair_idx * 2 + 1) as usize,
                            buf,
                            &mut dummy,
                        );
                    }
                }
            }
        };

        // Process the audio graph
        processor.process(frames, &read_source);

        // Read from SinkNodes that match this device
        processor.with_graph(|graph| {
            for handle in graph.sink_nodes() {
                if let Some(node) = graph.get_node(handle) {
                    if let Some(sink) = node.as_any().downcast_ref::<SinkNode>() {
                        // Check if this sink is for our device
                        if sink.device_id() != device_id {
                            continue;
                        }

                        let channel_offset = sink.channel_offset() as usize;
                        let port_count = node.input_port_count();

                        // Copy each port to corresponding channel
                        for port in 0..port_count {
                            let target_ch = channel_offset + port;
                            if target_ch >= out_ch {
                                continue;
                            }

                            if let Some(samples) = sink.get_output_samples(port) {
                                let valid = samples.len().min(frames);
                                for i in 0..valid {
                                    let out_idx = i * out_ch + target_ch;
                                    if out_idx < buffer.len() {
                                        buffer[out_idx] += samples[i];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Clip protection
        VDsp::clip(buffer, -1.0, 1.0);

        Ok(())
    }) {
        eprintln!("[AudioOutput v2] Failed to set render callback: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Initialize and start
    if let Err(e) = audio_unit.initialize() {
        eprintln!("[AudioOutput v2] Failed to initialize AudioUnit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    if let Err(e) = audio_unit.start() {
        eprintln!("[AudioOutput v2] Failed to start AudioUnit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    println!("[AudioOutput v2] Started successfully, waiting for stop signal...");

    // Wait until running is set to false
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Stop and cleanup
    let _ = audio_unit.stop();
    println!("[AudioOutput v2] Stopped");
}

/// Stop audio output
pub fn stop_output_v2() {
    let mut active = ACTIVE_OUTPUT.write();
    if let Some(output) = active.take() {
        println!("[AudioOutput v2] Stopping device {}", output.device_id);
        output.running.store(false, Ordering::SeqCst);
    }
}

/// Check if output is running
pub fn is_output_running_v2() -> bool {
    let active = ACTIVE_OUTPUT.read();
    active.as_ref().map_or(false, |o| o.running.load(Ordering::Relaxed))
}

/// Get the currently configured active output device, if any.
pub fn get_active_output_device() -> Option<u32> {
    let active = ACTIVE_OUTPUT.read();
    active.as_ref().map(|o| o.device_id)
}
