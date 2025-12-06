//! CoreAudio Output
//! Routes audio from input buffer to output devices

use crate::mixer::get_mixer_state;
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
    let dev_id_str = device_id.to_string();
    let dev_id_for_callback = device_id;
    let out_ch = channels as usize;

    // Temporary buffers for audio data - pre-allocate for efficiency
    // These are sized for typical audio buffer sizes (512-2048 frames)
    const MAX_FRAMES: usize = 4096;

    // Set render callback
    type Args = render_callback::Args<data::Interleaved<f32>>;

    if let Err(e) = audio_unit.set_render_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args { data, num_frames, .. } = args;
        let buffer = data.buffer;

        // Get mixer state
        let mixer_state = get_mixer_state();
        let sends = mixer_state.sends.read();
        let output_faders = mixer_state.output_faders.read();

        // Initialize output buffer to silence using vDSP (hardware accelerated)
        VDsp::clear(buffer);

        let frames = num_frames as usize;
        if frames > MAX_FRAMES {
            return Ok(()); // Safety check
        }

        // Get master fader gain for this device
        let master_gain = output_faders.get(&dev_id_str.to_string()).copied().unwrap_or(1.0);

        // Stack-allocated temp buffers
        let mut left_buf = [0.0f32; MAX_FRAMES];
        let mut right_buf = [0.0f32; MAX_FRAMES];

        // Mix audio from sends targeting this device
        for send in sends.iter() {
            if send.muted || send.level <= 0.0 {
                continue;
            }

            // Check if this send targets this device
            if send.target_device != dev_id_str {
                continue;
            }

            // Get source channel pair
            let source_pair = (send.source_offset / 2) as usize;
            let left_ch = source_pair * 2;
            let right_ch = source_pair * 2 + 1;

            // Get target channel pair (this is where the audio should go!)
            let target_pair = send.target_pair as usize;
            let target_left_ch = target_pair * 2;
            let target_right_ch = target_pair * 2 + 1;

            // Check if target channels are within device's output range
            if target_right_ch >= out_ch {
                // Fallback: if target pair is out of range, use pair 0
                continue;
            }

            // Read audio data from broadcast buffer (non-consuming!)
            let read_count = crate::audio_capture::read_channel_audio(
                dev_id_for_callback,
                left_ch,
                right_ch,
                &mut left_buf[..frames],
                &mut right_buf[..frames],
            );

            if read_count == 0 {
                continue;
            }

            // Apply send level AND master fader
            let gain = send.level * master_gain;

            // DAW-style mixing: use vDSP with stride for interleaved output
            // This is fully hardware-accelerated - no Rust loops needed
            // Mix left channel to interleaved buffer at offset target_left_ch, stride out_ch
            VDsp::mix_to_interleaved(
                &left_buf[..read_count],
                gain,
                buffer,
                target_left_ch,
                out_ch,
                read_count,
            );

            // Mix right channel to interleaved buffer at offset target_right_ch, stride out_ch
            VDsp::mix_to_interleaved(
                &right_buf[..read_count],
                gain,
                buffer,
                target_right_ch,
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
