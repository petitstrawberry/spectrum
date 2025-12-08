//! CoreAudio Output
//! Routes audio from input buffer to a SINGLE output device
//!
//! ## Single Device Architecture
//! Only ONE output device is active at a time. When using multi-output,
//! the user selects an Aggregate Device which macOS handles internally.
//! This eliminates all clock synchronization issues - the OS does it for us.
//!
//! Virtual sub-devices (from Aggregate Device) are represented in the UI
//! but internally they're just channel ranges within the single device.

use crate::audio_unit::get_au_manager;
use crate::mixer::{get_mixer_state, hash_device_id, get_graph_processor, NodeId};
use crate::vdsp::VDsp;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_default_device_id, get_device_name, set_device_sample_rate,
};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::sys::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal,
    AudioBufferList, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::string::CFString;
use parking_lot::RwLock;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

/// Sample rate for audio output
const SAMPLE_RATE: f64 = 48000.0;

// CoreAudio Aggregate Device constants
const kAudioObjectPropertyClass: u32 = 0x636c6173; // 'clas'
const kAudioAggregateDeviceClassID: u32 = 0x61616767; // 'aagg'
const kAudioAggregateDevicePropertyFullSubDeviceList: u32 = 0x67727570; // 'grup'

/// Callback count for diagnostics
static CALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);

/// Current active output device (only ONE at a time)
static ACTIVE_OUTPUT: LazyLock<RwLock<Option<ActiveOutput>>> =
    LazyLock::new(|| RwLock::new(None));

/// Represents the currently active output device
struct ActiveOutput {
    device_id: u32,
    running: Arc<AtomicBool>,
}

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

/// Check if a device is an Aggregate Device
pub fn is_aggregate_device(device_id: u32) -> bool {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioObjectPropertyClass,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut class_id: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut class_id as *mut u32 as *mut _,
        )
    };

    status == 0 && class_id == kAudioAggregateDeviceClassID
}

/// Sub-device info for Aggregate Device
#[derive(Debug, Clone)]
pub struct SubDeviceInfo {
    pub device_id: u32,
    pub name: String,
    pub output_channels: u32,
}

/// Get sub-devices of an Aggregate Device
/// Returns None if not an aggregate device, or empty vec if no sub-devices
pub fn get_aggregate_sub_devices(device_id: u32) -> Option<Vec<SubDeviceInfo>> {
    if !is_aggregate_device(device_id) {
        return None;
    }

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioAggregateDevicePropertyFullSubDeviceList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut size: u32 = 0;
    let status = unsafe {
        AudioObjectGetPropertyDataSize(device_id, &address, 0, ptr::null(), &mut size)
    };

    if status != 0 || size == 0 {
        return Some(vec![]);
    }

    let mut cf_array_ref: CFArrayRef = ptr::null();
    let mut size = std::mem::size_of::<CFArrayRef>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut cf_array_ref as *mut CFArrayRef as *mut _,
        )
    };

    if status != 0 || cf_array_ref.is_null() {
        return Some(vec![]);
    }

    // Convert CFArray to Vec<SubDeviceInfo>
    let cf_array: CFArray<CFType> = unsafe { CFArray::wrap_under_get_rule(cf_array_ref) };
    let mut sub_devices = Vec::new();

    for i in 0..cf_array.len() {
        if let Some(item) = cf_array.get(i as isize) {
            let cf_string: CFString = unsafe { CFString::wrap_under_get_rule(item.as_concrete_TypeRef() as _) };
            let uid = cf_string.to_string();

            if let Some(sub_device_id) = find_device_by_uid(&uid) {
                let name = get_device_name(sub_device_id).unwrap_or_else(|_| uid.clone());
                let output_channels = get_device_output_channels(sub_device_id);

                if output_channels > 0 {
                    sub_devices.push(SubDeviceInfo {
                        device_id: sub_device_id,
                        name,
                        output_channels,
                    });
                }
            }
        }
    }

    Some(sub_devices)
}

/// Find device ID by UID
fn find_device_by_uid(uid: &str) -> Option<u32> {
    const kAudioDevicePropertyDeviceUID: u32 = 0x75696420;

    let device_ids = get_audio_device_ids().ok()?;

    for device_id in device_ids {
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };

        let mut cf_string_ref: core_foundation::string::CFStringRef = ptr::null();
        let mut size = std::mem::size_of::<core_foundation::string::CFStringRef>() as u32;

        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                &address,
                0,
                ptr::null(),
                &mut size,
                &mut cf_string_ref as *mut _ as *mut _,
            )
        };

        if status == 0 && !cf_string_ref.is_null() {
            let cf_string: CFString = unsafe { CFString::wrap_under_get_rule(cf_string_ref) };
            if cf_string.to_string() == uid {
                return Some(device_id);
            }
        }
    }

    None
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
/// This will stop any currently active output first (single device only)
pub fn start_output(device_id: u32) -> Result<(), String> {
    // Check if this device is already active
    {
        let active = ACTIVE_OUTPUT.read();
        if let Some(ref output) = *active {
            if output.device_id == device_id && output.running.load(Ordering::SeqCst) {
                // Already running on this device, no need to restart
                return Ok(());
            }
        }
    }

    // Stop any existing output first (different device)
    stop_all_outputs();

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

    // Store as active output
    {
        let mut active = ACTIVE_OUTPUT.write();
        *active = Some(ActiveOutput {
            device_id,
            running: running.clone(),
        });
    }

    // Start output thread
    let channels = output_channels;
    std::thread::spawn(move || {
        output_thread(device_id, channels, running_clone);
    });

    Ok(())
}

/// Output thread function - simplified single-device design
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
        eprintln!("[AudioOutput] Failed to set stream format: {:?}", e);
        running.store(false, Ordering::SeqCst);
        return;
    }

    let running_callback = running.clone();
    let dev_id_hash = hash_device_id(&device_id.to_string());
    let dev_id_for_callback = device_id;
    let out_ch = output_channels as usize;

    println!("[AudioOutput] Device {} hash={:x} channels={}",
        device_id, dev_id_hash, out_ch);

    // Set render callback - SIMPLE: process graph directly into output buffer
    type Args = render_callback::Args<data::Interleaved<f32>>;

    if let Err(e) = audio_unit.set_render_callback(move |args: Args| {
        if !running_callback.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Args { data, num_frames, .. } = args;
        let buffer = data.buffer;
        let frames = num_frames as usize;

        if frames > crate::mixer::MAX_FRAMES {
            return Ok(());
        }

        // Track callback count
        let callback_num = CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);

        // Clear output buffer
        VDsp::clear(buffer);

        // Get mixer state and graph
        let mixer_state = get_mixer_state();
        let snapshot = mixer_state.load_snapshot();
        let graph = &snapshot.audio_graph;

        if graph.processing_order.is_empty() {
            return Ok(());
        }

        // Get graph processor
        let processor_arc = get_graph_processor();
        let mut processor = match processor_arc.try_write() {
            Some(p) => p,
            None => {
                // Lock contention - skip this callback
                return Ok(());
            }
        };

        // Define input reader
        let read_input = |_device_id: u32, pair_idx: u8, left: &mut [f32], right: &mut [f32]| -> usize {
            crate::audio_capture::read_channel_audio_any(
                pair_idx as usize * 2,
                pair_idx as usize * 2 + 1,
                left,
                right,
            )
        };

        // Define plugin processor
        let au_manager = get_au_manager();
        let buses = &graph.buses;
        let process_plugins = |bus_idx: u8, left: &mut [f32], right: &mut [f32]| {
            if let Some(bus) = buses.get(bus_idx as usize) {
                if !bus.plugin_ids.is_empty() {
                    au_manager.process_chain(
                        &bus.plugin_ids,
                        left,
                        right,
                        0.0,
                    );
                }
            }
        };

        // Process the audio graph
        processor.process(
            graph,
            frames,
            callback_num,
            read_input,
            process_plugins,
        );

        // Copy output node buffers directly to interleaved output buffer
        // All output nodes target the SAME device, just different channel pairs
        // Also calculate metering for each output node
        for &node_id in graph.processing_order.iter() {
            if node_id.is_output() {
                if let Some(buf) = processor.get_buffer(node_id) {
                    if buf.valid_frames == 0 {
                        continue;
                    }

                    // Get target channel pair from NodeId
                    let pair_idx = (node_id.0 & 0x0F) as usize;
                    let left_ch = pair_idx * 2;
                    let right_ch = left_ch + 1;

                    // Write to interleaved output buffer
                    let valid = buf.valid_frames.min(frames);
                    for i in 0..valid {
                        if left_ch < out_ch {
                            let out_idx = i * out_ch + left_ch;
                            if out_idx < buffer.len() {
                                buffer[out_idx] += buf.left[i];
                            }
                        }
                        if right_ch < out_ch {
                            let out_idx = i * out_ch + right_ch;
                            if out_idx < buffer.len() {
                                buffer[out_idx] += buf.right[i];
                            }
                        }
                    }

                    // Update output metering for this channel pair
                    // Key format: "{device_id}_{pair_idx}"
                    let meter_key = format!("{}_{}", dev_id_for_callback, pair_idx);
                    let left_rms = VDsp::rms(&buf.left[..valid]);
                    let left_peak = VDsp::peak(&buf.left[..valid]);
                    let right_rms = VDsp::rms(&buf.right[..valid]);
                    let right_peak = VDsp::peak(&buf.right[..valid]);

                    mixer_state.update_output_levels(&meter_key, vec![
                        crate::mixer::ChannelLevels {
                            left_rms,
                            right_rms,
                            left_peak,
                            right_peak,
                        }
                    ]);
                }
            }
        }

        // Update bus metering
        for (bus_idx, bus) in graph.buses.iter().enumerate() {
            if bus.muted {
                continue;
            }
            let node_id = NodeId::bus(bus_idx as u8);
            if let Some(buf) = processor.get_buffer(node_id) {
                if buf.valid_frames > 0 {
                    let fader = bus.fader;
                    let left_rms = VDsp::rms(&buf.left[..frames]) * fader;
                    let left_peak = VDsp::peak(&buf.left[..frames]) * fader;
                    let right_rms = VDsp::rms(&buf.right[..frames]) * fader;
                    let right_peak = VDsp::peak(&buf.right[..frames]) * fader;
                    mixer_state.update_bus_level(bus_idx, left_rms, right_rms, left_peak, right_peak);
                }
            }
        }

        // Clip protection
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
    let mut active = ACTIVE_OUTPUT.write();
    if let Some(ref output) = *active {
        if output.device_id == device_id {
            output.running.store(false, Ordering::SeqCst);
            crate::audio_capture::unregister_output_device(device_id);
            *active = None;
        }
    }
}

/// Stop all outputs (there's only one, but keep the API)
pub fn stop_all_outputs() {
    let mut active = ACTIVE_OUTPUT.write();
    if let Some(ref output) = *active {
        output.running.store(false, Ordering::SeqCst);
        crate::audio_capture::unregister_output_device(output.device_id);
    }
    *active = None;
}

/// Start output to default device
pub fn start_default_output() -> Result<(), String> {
    let default_id = get_default_device_id(false)
        .ok_or_else(|| "Failed to get default output device".to_string())?;

    start_output(default_id)
}

/// Get the currently active output device ID
pub fn get_active_output_device() -> Option<u32> {
    let active = ACTIVE_OUTPUT.read();
    active.as_ref().map(|o| o.device_id)
}
