//! Audio Router Engine
//! Handles real-time audio routing from Prism to output devices

use crate::mixer::{get_mixer_state, PRISM_CHANNELS};
use coreaudio::audio_unit::macos_helpers::{get_audio_device_ids, get_device_name};
use coreaudio::sys::{
    kAudioDevicePropertyScopeInput,
    kAudioDevicePropertyScopeOutput,
    kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster,
    AudioBuffer,
    AudioBufferList,
    AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
};
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

/// Find Prism device ID
pub fn find_prism_device() -> Option<u32> {
    let device_ids = get_audio_device_ids().ok()?;
    
    for id in device_ids {
        if let Ok(name) = get_device_name(id) {
            if name.to_lowercase().contains("prism") {
                return Some(id);
            }
        }
    }
    None
}

/// Get channel count for a device
pub fn get_channel_count(device_id: u32, is_input: bool) -> u32 {
    let scope = if is_input {
        kAudioDevicePropertyScopeInput
    } else {
        kAudioDevicePropertyScopeOutput
    };

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut size: u32 = 0;
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
        )
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

/// Check if Prism device is available
pub fn is_prism_available() -> bool {
    find_prism_device().is_some()
}

/// Get output levels for a specific device
/// Returns (left_rms, right_rms, left_peak, right_peak) for each stereo pair
pub fn get_output_levels(device_id: &str) -> Vec<(f32, f32, f32, f32)> {
    let mixer_state = get_mixer_state();
    let levels = mixer_state.get_output_levels(device_id);
    
    levels.iter()
        .map(|l| (l.left_rms, l.right_rms, l.left_peak, l.right_peak))
        .collect()
}

/// Update a send connection
pub fn update_send(
    source_offset: u32,
    target_device: String,
    target_pair: u32,
    level: f32,
    muted: bool,
) {
    let mixer_state = get_mixer_state();
    mixer_state.set_send(crate::mixer::Send {
        source_offset,
        target_device,
        target_pair,
        level: level / 100.0, // Convert from 0-100 to 0.0-1.0
        muted,
    });
}

/// Remove a send connection
pub fn remove_send(source_offset: u32, target_device: &str, target_pair: u32) {
    let mixer_state = get_mixer_state();
    mixer_state.remove_send(source_offset, target_device, target_pair);
}

/// Set source fader level (0-100)
pub fn set_source_fader(pair_index: usize, level: f32) {
    let mixer_state = get_mixer_state();
    mixer_state.set_source_fader(pair_index, level);
}

/// Set source mute
pub fn set_source_mute(pair_index: usize, muted: bool) {
    let mixer_state = get_mixer_state();
    mixer_state.set_source_mute(pair_index, muted);
}

/// Set output master fader (0-100)
pub fn set_output_fader(device_id: &str, level: f32) {
    let mixer_state = get_mixer_state();
    mixer_state.set_output_fader(device_id, level);
}

/// Simulated level generation (for testing without real audio)
/// In production, these levels come from the actual audio callback
pub fn simulate_levels() {
    let mixer_state = get_mixer_state();
    let mut input_levels = mixer_state.input_levels.write();
    
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f32;
    
    let stereo_pairs = PRISM_CHANNELS / 2;
    
    // Generate smooth animated levels for testing
    for i in 0..stereo_pairs {
        // Simulate different activity levels for different channels
        let activity = if i == 0 {
            0.7 // MAIN is always active
        } else if i < 8 {
            0.3 + 0.4 * ((now / 500.0 + i as f32).sin() * 0.5 + 0.5)
        } else {
            0.1 * ((now / 1000.0 + i as f32 * 0.5).sin() * 0.5 + 0.5)
        };
        
        let variation = (now / 50.0 + i as f32 * 10.0).sin() * 0.1;
        let base_level = (activity + variation).clamp(0.0, 1.0);
        
        input_levels[i].left_rms = base_level * 0.8;
        input_levels[i].right_rms = base_level * 0.85;
        input_levels[i].left_peak = (base_level * 1.2).min(1.0);
        input_levels[i].right_peak = (base_level * 1.15).min(1.0);
    }
}

/// Get sample rate (from mixer state or default)
pub fn get_sample_rate() -> u32 {
    let mixer_state = get_mixer_state();
    let sample_rate = *mixer_state.sample_rate.read();
    sample_rate
}

/// Get buffer size (from mixer state or default)
pub fn get_buffer_size() -> u32 {
    let mixer_state = get_mixer_state();
    let buffer_size = *mixer_state.buffer_size.read();
    buffer_size
}
