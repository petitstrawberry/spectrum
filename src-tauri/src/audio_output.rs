//! CoreAudio Output
//! Routes audio from input buffer to output devices

use crate::mixer::{get_mixer_state, hash_device_id};
use crate::vdsp::VDsp;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_default_device_id, get_device_name, set_device_sample_rate,
};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::sys::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster, AudioBufferList,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

/// Sample rate for audio output
const SAMPLE_RATE: f64 = 48000.0;

/// Active output devices
static ACTIVE_OUTPUTS: LazyLock<RwLock<HashMap<u32, Arc<AtomicBool>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

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

/// Find output device by name
pub fn find_output_device(name: &str) -> Option<u32> {
    let device_ids = get_audio_device_ids().ok()?;
    let name_lower = name.to_lowercase();

    for id in device_ids {
        if let Ok(dev_name) = get_device_name(id) {
            if dev_name.to_lowercase().contains(&name_lower) {
                let output_ch = get_device_output_channels(id);
                if output_ch > 0 {
                    return Some(id);
                }
            }
        }
    }
    None
}

/// Start output to a specific device
pub fn start_output(device_id: u32) -> Result<(), String> {
    // Check if already running
    {
        let outputs = ACTIVE_OUTPUTS.read();
        if outputs.contains_key(&device_id) {
            return Ok(());
        }
    }

    let device_name = get_device_name(device_id)
        .unwrap_or_else(|_| format!("Device {}", device_id));

    let output_channels = get_device_output_channels(device_id);
    if output_channels == 0 {
        return Err(format!("Device {} has no output channels", device_name));
    }

    println!("[AudioOutput] Starting output to {} (ID: {}, {} channels)",
             device_name, device_id, output_channels);

    // Set sample rate
    if let Err(e) = set_device_sample_rate(device_id, SAMPLE_RATE) {
        println!("[AudioOutput] Warning: Could not set sample rate: {:?}", e);
    }

    // Register this device with the audio capture system
    crate::audio_capture::register_output_device(device_id);

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Store running flag
    {
        let mut outputs = ACTIVE_OUTPUTS.write();
        outputs.insert(device_id, running.clone());
    }

    // Start output thread
    let channels = output_channels;
    std::thread::spawn(move || {
        output_thread(device_id, channels, running_clone);
    });

    Ok(())
}

/// Output thread function
fn output_thread(device_id: u32, output_channels: u32, running: Arc<AtomicBool>) {
    // Create audio unit for output
    let audio_unit_result = AudioUnit::new(coreaudio::audio_unit::IOType::HalOutput);
    let mut audio_unit = match audio_unit_result {
        Ok(au) => au,
        Err(e) => {
            eprintln!("[AudioOutput] Failed to create audio unit: {:?}", e);
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
        eprintln!("[AudioOutput] Failed to set device: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Set stream format - support multi-channel output
    let channels = output_channels;
    let stream_format = StreamFormat {
        sample_rate: SAMPLE_RATE,
        sample_format: SampleFormat::F32,
        flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
        channels,
    };

    if let Err(e) = audio_unit.set_property(
        coreaudio::sys::kAudioUnitProperty_StreamFormat,
        Scope::Input,
        Element::Output,
        Some(&stream_format.to_asbd()),
    ) {
        eprintln!("[AudioOutput] Failed to set stream format: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    let running_callback = running.clone();
    let dev_id_hash = hash_device_id(&device_id.to_string());
    let dev_id_for_callback = device_id;
    let out_ch = channels as usize;

    // Pre-allocated buffers for audio data - avoids allocation in callback
    const MAX_FRAMES: usize = 4096;
    // Maximum unique source pairs we can cache per callback (keep small to avoid stack overflow)
    const MAX_CACHED_PAIRS: usize = 8;

    // Pre-allocate buffers outside the callback closure to avoid stack overflow
    // These are captured by the closure and live on the heap via the closure
    let mut left_bufs: [[f32; MAX_FRAMES]; MAX_CACHED_PAIRS] = [[0.0; MAX_FRAMES]; MAX_CACHED_PAIRS];
    let mut right_bufs: [[f32; MAX_FRAMES]; MAX_CACHED_PAIRS] = [[0.0; MAX_FRAMES]; MAX_CACHED_PAIRS];
    let mut cache_keys: [(u32, usize, usize); MAX_CACHED_PAIRS] = [(0, 0, 0); MAX_CACHED_PAIRS]; // (source_device, pair_idx, read_count)
    let mut cache_valid: [bool; MAX_CACHED_PAIRS] = [false; MAX_CACHED_PAIRS];

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
            return Ok(()); // Safety check
        }

        // Initialize output buffer to silence using vDSP (hardware accelerated)
        VDsp::clear(buffer);

        // Get mixer state - use compact sends for fast iteration
        // Use try_read to avoid blocking - if locked, skip this callback (better than glitch)
        let mixer_state = get_mixer_state();
        let sends = match mixer_state.sends_compact.try_read() {
            Some(s) => s,
            None => return Ok(()), // Skip if locked
        };
        let faders = match mixer_state.source_faders.try_read() {
            Some(f) => *f,
            None => return Ok(()),
        };
        let mutes = match mixer_state.source_mutes.try_read() {
            Some(m) => *m,
            None => return Ok(()),
        };

        // Reset cache for this callback
        let mut cache_count = 0usize;
        for i in 0..MAX_CACHED_PAIRS {
            cache_valid[i] = false;
        }

        // Mix audio from sends targeting this device (1ch unit)
        for send in sends.iter() {
            if !send.active {
                continue;
            }

            // Check if this send targets this device (use hash for fast comparison)
            if send.target_device_hash != dev_id_hash {
                continue;
            }

            // Get source device and channel (1ch unit)
            let source_dev = send.source_device;
            let source_ch = send.source_channel as usize;

            // Check if source pair is muted
            let pair_idx = source_ch / 2;
            if pair_idx < mutes.len() && mutes[pair_idx] {
                continue;
            }

            // Get source fader
            let source_gain = if pair_idx < faders.len() { faders[pair_idx] } else { 1.0 };
            let total_gain = send.level * source_gain;

            if total_gain < 0.0001 {
                continue;
            }

            // Get target channel (1ch unit)
            let target_ch = send.target_channel as usize;

            // Check if target channel is within device's output range
            if target_ch >= out_ch {
                continue;
            }

            // Calculate whether it's the right channel
            let is_right = source_ch % 2 == 1;
            
            // Find or create cache entry (linear search is fine for small N)
            let (cache_idx, read_count) = {
                let mut found_idx: Option<usize> = None;
                for i in 0..cache_count {
                    if cache_valid[i] && cache_keys[i].0 == source_dev && cache_keys[i].1 == pair_idx {
                        found_idx = Some(i);
                        break;
                    }
                }
                
                if let Some(idx) = found_idx {
                    (idx, cache_keys[idx].2)
                } else if cache_count < MAX_CACHED_PAIRS {
                    // Read audio data into pre-allocated buffers
                    let idx = cache_count;
                    let count = if source_dev == 0 {
                        crate::audio_capture::read_channel_audio(
                            dev_id_for_callback,
                            pair_idx * 2,
                            pair_idx * 2 + 1,
                            &mut left_bufs[idx][..frames],
                            &mut right_bufs[idx][..frames],
                        )
                    } else {
                        crate::audio_capture::read_input_audio(
                            source_dev,
                            dev_id_for_callback,
                            pair_idx * 2,
                            pair_idx * 2 + 1,
                            &mut left_bufs[idx][..frames],
                            &mut right_bufs[idx][..frames],
                        )
                    };
                    
                    cache_keys[idx] = (source_dev, pair_idx, count);
                    cache_valid[idx] = true;
                    cache_count += 1;
                    (idx, count)
                } else {
                    continue; // Cache full, skip
                }
            };

            if read_count == 0 {
                continue;
            }

            // Get the correct channel data
            let source_data = if is_right { &right_bufs[cache_idx] } else { &left_bufs[cache_idx] };

            // DAW-style mixing: use vDSP with stride for interleaved output
            VDsp::mix_to_interleaved(
                &source_data[..read_count],
                total_gain,
                buffer,
                target_ch,
                out_ch,
                read_count,
            );
        }

        // Clip protection using vDSP - hardware accelerated
        VDsp::clip(buffer, -1.0, 1.0);

        Ok(())
    }) {
        eprintln!("[AudioOutput] Failed to set render callback: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    // Initialize and start
    if let Err(e) = audio_unit.initialize() {
        eprintln!("[AudioOutput] Failed to initialize audio unit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    if let Err(e) = audio_unit.start() {
        eprintln!("[AudioOutput] Failed to start audio unit: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    println!("[AudioOutput] Output started for device {}", device_id);

    // Keep thread alive
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let _ = audio_unit.stop();
    println!("[AudioOutput] Output stopped for device {}", device_id);
}

/// Stop output to a specific device
pub fn stop_output(device_id: u32) {
    let mut outputs = ACTIVE_OUTPUTS.write();
    if let Some(running) = outputs.remove(&device_id) {
        running.store(false, Ordering::SeqCst);
        // Unregister from audio capture
        crate::audio_capture::unregister_output_device(device_id);
    }
}

/// Stop all outputs
#[allow(dead_code)]
pub fn stop_all_outputs() {
    let mut outputs = ACTIVE_OUTPUTS.write();
    for (device_id, running) in outputs.drain() {
        running.store(false, Ordering::SeqCst);
        crate::audio_capture::unregister_output_device(device_id);
    }
}

/// Start output to default device
pub fn start_default_output() -> Result<(), String> {
    let default_id = get_default_device_id(false)
        .ok_or_else(|| "Failed to get default output device".to_string())?;

    start_output(default_id)
}
