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

/// Convert fader position (0-100) to dB (-∞ to +6)
/// Logic Pro X style scale:
/// 100 = +6dB, 83 = 0dB, 70 = -6dB, 60 = -10dB, 40 = -20dB, 15 = -40dB, 0 = -∞
fn fader_to_db(fader_value: f32) -> f32 {
    if fader_value <= 0.0 {
        return f32::NEG_INFINITY;
    }
    if fader_value >= 100.0 {
        return 6.0;
    }
    
    if fader_value >= 83.0 {
        // 83-100 maps to 0dB to +6dB
        ((fader_value - 83.0) / 17.0) * 6.0
    } else if fader_value >= 70.0 {
        // 70-83 maps to -6dB to 0dB
        -6.0 + ((fader_value - 70.0) / 13.0) * 6.0
    } else if fader_value >= 60.0 {
        // 60-70 maps to -10dB to -6dB
        -10.0 + ((fader_value - 60.0) / 10.0) * 4.0
    } else if fader_value >= 40.0 {
        // 40-60 maps to -20dB to -10dB
        -20.0 + ((fader_value - 40.0) / 20.0) * 10.0
    } else if fader_value >= 15.0 {
        // 15-40 maps to -40dB to -20dB
        -40.0 + ((fader_value - 15.0) / 25.0) * 20.0
    } else {
        // 0-15 maps to -∞ to -40dB (exponential for smooth fade out)
        -40.0 - (60.0 * (1.0 - fader_value / 15.0).powi(2))
    }
}

/// Convert dB to linear gain
fn db_to_linear(db: f32) -> f32 {
    if db <= -60.0 {
        return 0.0;
    }
    10.0_f32.powf(db / 20.0)
}

/// Update a send connection (1ch unit)
pub fn update_send(
    source_device: u32,
    source_channel: u32,
    target_device: String,
    target_channel: u32,
    level: f32,
    muted: bool,
) {
    let mixer_state = get_mixer_state();
    // Convert fader position (0-100) to linear gain via dB
    let db = fader_to_db(level);
    let linear_gain = db_to_linear(db);
    
    mixer_state.set_send(crate::mixer::Send {
        source_device,
        source_channel,
        target_device,
        target_channel,
        level: linear_gain,
        muted,
    });
}

/// Remove a send connection (1ch unit)
pub fn remove_send(source_device: u32, source_channel: u32, target_device: &str, target_channel: u32) {
    let mixer_state = get_mixer_state();
    mixer_state.remove_send(source_device, source_channel, target_device, target_channel);
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

/// Set output master fader (dB)
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
    
    // DEBUG: Always max level (RMS = 1.0 = 0dBFS) for testing meter display
    for i in 0..stereo_pairs {
        input_levels[i].left_rms = 1.0;
        input_levels[i].right_rms = 1.0;
        input_levels[i].left_peak = 1.0;
        input_levels[i].right_peak = 1.0;
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
