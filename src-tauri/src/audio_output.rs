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

    // Get the buffer pool for this output device (use hash as key)
    let buffer_pool = crate::mixer::get_output_buffer_pool(dev_id_hash);

    // Set render callback
    type Args = render_callback::Args<data::Interleaved<f32>>;

    if let Err(e) = audio_unit.set_render_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args { data, num_frames, .. } = args;
        let buffer = data.buffer;

        let frames = num_frames as usize;
        if frames > crate::mixer::MAX_FRAMES {
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

        // Get bus-related state
        let bus_sends = mixer_state.bus_sends.try_read_sends();
        let buses = mixer_state.bus_sends.try_read_buses();
        let mut bus_buffers = mixer_state.bus_buffers.try_write();

        // Get buffer pool - use try_write to avoid blocking
        let mut pool = match buffer_pool.try_write() {
            Some(p) => p,
            None => return Ok(()), // Skip if locked
        };

        // Track which buffers have been read this callback
        // Using a simple bitset approach with u64 for up to 64 buffers
        let mut buffers_read: u64 = 0;
        let mut buffer_read_counts: [usize; 64] = [0; 64];

        // ========== Bus Processing ==========
        // Process bus sends if available
        if let (Some(bus_sends), Some(buses), Some(ref mut bus_buffers)) = (bus_sends, buses, bus_buffers.as_mut()) {
            // Clear all bus buffers first
            for bus_buf in bus_buffers.iter_mut() {
                bus_buf.clear(frames);
            }

            // We need multiple passes for bus chains (Bus 1 -> Bus 2 -> Output)
            // Do topological-style processing: Input->Bus first, then Bus->Bus, then Bus->Output
            
            // Pass 1: Input -> Bus
            for send in bus_sends.iter() {
                if !send.active || send.source_type != 0 || send.target_type != 0 {
                    continue; // Only Input -> Bus
                }
                
                let bus_idx = send.target_bus_idx as usize;
                if bus_idx >= bus_buffers.len() || bus_idx >= buses.len() {
                    continue;
                }
                
                let bus = &buses[bus_idx];
                if bus.muted {
                    continue;
                }

                let source_dev = send.source_device;
                let source_ch = send.source_channel as usize;
                let pair_idx = source_ch / 2;
                
                // Check source mute
                if pair_idx < mutes.len() && mutes[pair_idx] {
                    continue;
                }

                let source_gain = if pair_idx < faders.len() { faders[pair_idx] } else { 1.0 };
                let total_gain = send.level * source_gain;
                if total_gain < 0.0001 {
                    continue;
                }

                // Read audio from input
                let buffer_idx = pool.get_or_allocate(source_dev, pair_idx);
                let read_count = if buffer_idx < 64 && (buffers_read & (1 << buffer_idx)) != 0 {
                    buffer_read_counts[buffer_idx]
                } else {
                    let pair_buf = match pool.get_buffer_mut(buffer_idx) {
                        Some(b) => b,
                        None => continue,
                    };
                    
                    let count = if source_dev == 0 {
                        crate::audio_capture::read_channel_audio(
                            dev_id_for_callback,
                            pair_idx * 2,
                            pair_idx * 2 + 1,
                            &mut pair_buf.left[..frames],
                            &mut pair_buf.right[..frames],
                        )
                    } else {
                        crate::audio_capture::read_input_audio(
                            source_dev,
                            dev_id_for_callback,
                            pair_idx * 2,
                            pair_idx * 2 + 1,
                            &mut pair_buf.left[..frames],
                            &mut pair_buf.right[..frames],
                        )
                    };
                    
                    if buffer_idx < 64 {
                        buffers_read |= 1 << buffer_idx;
                        buffer_read_counts[buffer_idx] = count;
                    }
                    count
                };

                if read_count == 0 {
                    continue;
                }

                // Get source audio
                let pair_buf = match pool.get_buffer(buffer_idx) {
                    Some(b) => b,
                    None => continue,
                };
                let is_right = source_ch % 2 == 1;
                let source_data = if is_right { &pair_buf.right[..] } else { &pair_buf.left[..] };

                // Mix to bus buffer
                let target_ch = send.target_channel as usize;
                let bus_buf = &mut bus_buffers[bus_idx];
                let target_buf = if target_ch % 2 == 0 { &mut bus_buf.left } else { &mut bus_buf.right };
                VDsp::mix_add(&source_data[..read_count], total_gain, &mut target_buf[..read_count]);
            }

            // Pass 2: Bus -> Bus (for chaining, e.g., Bus 1 -> Bus 2)
            // We do this multiple times to handle chains (max depth = number of buses)
            let bus_count = buses.len();
            for _pass in 0..bus_count {
                for send in bus_sends.iter() {
                    if !send.active || send.source_type != 1 || send.target_type != 0 {
                        continue; // Only Bus -> Bus
                    }
                    
                    let source_bus_idx = send.source_bus_idx as usize;
                    let target_bus_idx = send.target_bus_idx as usize;
                    
                    if source_bus_idx >= bus_buffers.len() || target_bus_idx >= bus_buffers.len() {
                        continue;
                    }
                    if source_bus_idx >= buses.len() || target_bus_idx >= buses.len() {
                        continue;
                    }
                    
                    let source_bus = &buses[source_bus_idx];
                    let target_bus = &buses[target_bus_idx];
                    if source_bus.muted || target_bus.muted {
                        continue;
                    }

                    let total_gain = send.level * source_bus.fader;
                    if total_gain < 0.0001 {
                        continue;
                    }

                    let source_ch = send.source_channel as usize;
                    let target_ch = send.target_channel as usize;
                    
                    // We need to copy to avoid borrowing issues
                    let mut temp_buf = [0.0f32; crate::mixer::MAX_FRAMES];
                    {
                        let source_buf = &bus_buffers[source_bus_idx];
                        let src = if source_ch % 2 == 0 { &source_buf.left } else { &source_buf.right };
                        temp_buf[..frames].copy_from_slice(&src[..frames]);
                    }
                    
                    let target_buf_data = &mut bus_buffers[target_bus_idx];
                    let dst = if target_ch % 2 == 0 { &mut target_buf_data.left } else { &mut target_buf_data.right };
                    VDsp::mix_add(&temp_buf[..frames], total_gain, &mut dst[..frames]);
                }
            }

            // Pass 3: Bus -> Output
            for send in bus_sends.iter() {
                if !send.active || send.source_type != 1 || send.target_type != 1 {
                    continue; // Only Bus -> Output
                }
                
                // Check if targeting this output device
                if send.target_device_hash != dev_id_hash {
                    continue;
                }

                let source_bus_idx = send.source_bus_idx as usize;
                if source_bus_idx >= bus_buffers.len() || source_bus_idx >= buses.len() {
                    continue;
                }
                
                let source_bus = &buses[source_bus_idx];
                if source_bus.muted {
                    continue;
                }

                let total_gain = send.level * source_bus.fader;
                if total_gain < 0.0001 {
                    continue;
                }

                let source_ch = send.source_channel as usize;
                let target_ch = send.target_channel as usize;

                if target_ch >= out_ch {
                    continue;
                }

                let source_buf = &bus_buffers[source_bus_idx];
                let source_data = if source_ch % 2 == 0 { &source_buf.left[..] } else { &source_buf.right[..] };

                // Mix to interleaved output
                VDsp::mix_to_interleaved(
                    &source_data[..frames],
                    total_gain,
                    buffer,
                    target_ch,
                    out_ch,
                    frames,
                );
            }
        }

        // ========== Direct Sends (Input -> Output) ==========
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
            
            // Find or allocate buffer for this source pair
            let buffer_idx = pool.get_or_allocate(source_dev, pair_idx);
            
            // Read audio if not already read this callback
            let read_count = if buffer_idx < 64 && (buffers_read & (1 << buffer_idx)) != 0 {
                // Already read this buffer
                buffer_read_counts[buffer_idx]
            } else {
                // Need to read audio
                let pair_buf = match pool.get_buffer_mut(buffer_idx) {
                    Some(b) => b,
                    None => continue,
                };
                
                let count = if source_dev == 0 {
                    crate::audio_capture::read_channel_audio(
                        dev_id_for_callback,
                        pair_idx * 2,
                        pair_idx * 2 + 1,
                        &mut pair_buf.left[..frames],
                        &mut pair_buf.right[..frames],
                    )
                } else {
                    crate::audio_capture::read_input_audio(
                        source_dev,
                        dev_id_for_callback,
                        pair_idx * 2,
                        pair_idx * 2 + 1,
                        &mut pair_buf.left[..frames],
                        &mut pair_buf.right[..frames],
                    )
                };
                
                if buffer_idx < 64 {
                    buffers_read |= 1 << buffer_idx;
                    buffer_read_counts[buffer_idx] = count;
                }
                count
            };

            if read_count == 0 {
                continue;
            }

            // Get the correct channel data
            let pair_buf = match pool.get_buffer(buffer_idx) {
                Some(b) => b,
                None => continue,
            };
            let source_data = if is_right { &pair_buf.right[..] } else { &pair_buf.left[..] };

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
