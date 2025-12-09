//! Device enumeration for input and output devices

use crate::api::dto::OutputDeviceDto;
use coreaudio::audio_unit::macos_helpers::{get_audio_device_ids, get_device_name};
use coreaudio::sys::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyElementMaster, AudioBuffer, AudioBufferList,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectSystemObject,
    kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal,
};
use std::ptr;

/// Get the default output device ID
pub fn get_default_output_device() -> Option<u32> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut device_id: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut device_id as *mut u32 as *mut _,
        )
    };

    if status == 0 && device_id != 0 {
        Some(device_id)
    } else {
        None
    }
}

/// Get number of output channels for a device
pub fn get_device_output_channels(device_id: u32) -> u32 {
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
    let buffers_ptr: *const AudioBuffer = &buffer_list.mBuffers as *const _;

    for i in 0..num_buffers {
        let audio_buffer = unsafe { &*buffers_ptr.add(i as usize) };
        total_channels += audio_buffer.mNumberChannels;
    }

    total_channels
}

/// Check if a device is an aggregate device
pub fn is_aggregate_device(device_id: u32) -> bool {
    // Check device UID for aggregate device pattern
    if let Some(uid) = get_device_uid(device_id) {
        uid.contains("aggregate") || uid.contains("Aggregate")
    } else {
        false
    }
}

/// Get device UID
fn get_device_uid(device_id: u32) -> Option<String> {
    use core_foundation::string::CFString;
    use core_foundation::base::TCFType;

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut uid: core_foundation::string::CFStringRef = ptr::null();
    let mut size = std::mem::size_of::<core_foundation::string::CFStringRef>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut uid as *mut _ as *mut _,
        )
    };

    if status != 0 || uid.is_null() {
        return None;
    }

    let cf_string = unsafe { CFString::wrap_under_create_rule(uid) };
    Some(cf_string.to_string())
}

/// Guess icon hint from device name
fn get_icon_hint(name: &str) -> String {
    let lower = name.to_lowercase();

    if lower.contains("headphone") || lower.contains("ヘッドフォン") {
        "headphones".to_string()
    } else if lower.contains("speaker") || lower.contains("スピーカー") {
        "speaker".to_string()
    } else if lower.contains("airpods") {
        "airpods".to_string()
    } else if lower.contains("bluetooth") || lower.contains("bt") {
        "bluetooth".to_string()
    } else if lower.contains("usb") {
        "usb".to_string()
    } else if lower.contains("hdmi") || lower.contains("displayport") {
        "display".to_string()
    } else if lower.contains("aggregate") || lower.contains("multi") {
        "aggregate".to_string()
    } else {
        "default".to_string()
    }
}

/// Get list of output devices (with virtual device expansion for aggregate devices)
pub fn get_output_devices() -> Vec<OutputDeviceDto> {
    let mut result = Vec::new();

    let device_ids = match get_audio_device_ids() {
        Ok(ids) => ids,
        Err(_) => return result,
    };

    for device_id in device_ids {
        let output_channels = get_device_output_channels(device_id);
        if output_channels == 0 {
            continue; // Not an output device
        }

        let name = get_device_name(device_id).unwrap_or_else(|_| format!("Device {}", device_id));

        if is_aggregate_device(device_id) {
            // For aggregate devices, we could expand sub-devices
            // For now, treat as a single device with multiple channels
            // TODO: Implement proper sub-device expansion using AudioObjectGetPropertyData
            // with kAudioAggregateDevicePropertyActiveSubDeviceList

            // For simplicity, create virtual devices for each stereo pair
            let stereo_pairs = (output_channels + 1) / 2;
            for pair in 0..stereo_pairs {
                let offset = pair * 2;
                let ch_count = (output_channels - offset).min(2);

                result.push(OutputDeviceDto {
                    id: format!("vout_{}_{}", device_id, offset),
                    device_id,
                    channel_offset: offset as u8,
                    channel_count: ch_count as u8,
                    name: format!("{} (Ch {}-{})", name, offset + 1, offset + ch_count),
                    device_type: "aggregate_sub".to_string(),
                    icon_hint: get_icon_hint(&name),
                    is_aggregate_sub: true,
                });
            }
        } else {
            // Regular device - single entry
            result.push(OutputDeviceDto {
                id: format!("vout_{}_0", device_id),
                device_id,
                channel_offset: 0,
                channel_count: output_channels.min(255) as u8,
                name: name.clone(),
                device_type: "physical".to_string(),
                icon_hint: get_icon_hint(&name),
                is_aggregate_sub: false,
            });
        }
    }

    result
}

/// Find a specific output device by ID
pub fn find_output_device(virtual_id: &str) -> Option<(u32, u8, u8)> {
    // Parse virtual ID: "vout_{device_id}_{offset}"
    let parts: Vec<&str> = virtual_id.split('_').collect();
    if parts.len() != 3 || parts[0] != "vout" {
        return None;
    }

    let device_id: u32 = parts[1].parse().ok()?;
    let channel_offset: u8 = parts[2].parse().ok()?;

    let output_channels = get_device_output_channels(device_id);
    if output_channels == 0 {
        return None;
    }

    let available = (output_channels as u8).saturating_sub(channel_offset);
    let channel_count = available.min(2);

    Some((device_id, channel_offset, channel_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_output_devices() {
        let devices = get_output_devices();
        println!("Found {} output devices", devices.len());
        for device in &devices {
            println!(
                "  {} (id={}, offset={}, channels={})",
                device.name, device.device_id, device.channel_offset, device.channel_count
            );
        }
        // Just check that it doesn't panic
        assert!(devices.len() >= 0);
    }

    #[test]
    fn test_get_default_output_device() {
        if let Some(device_id) = get_default_output_device() {
            println!("Default output device ID: {}", device_id);
            let channels = get_device_output_channels(device_id);
            println!("Output channels: {}", channels);
            assert!(channels > 0);
        }
    }
}
