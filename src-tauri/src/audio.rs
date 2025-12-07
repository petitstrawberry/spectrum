//! CoreAudio utilities for device enumeration and level metering

use crate::AudioDevice;
use coreaudio::audio_unit::macos_helpers::{
    get_audio_device_ids, get_device_name,
};
use coreaudio::sys::{
    kAudioDevicePropertyStreamConfiguration,
    kAudioDevicePropertyScopeInput,
    kAudioDevicePropertyScopeOutput,
    kAudioObjectPropertyElementMaster,
    kAudioObjectPropertyScopeGlobal,
    kAudioDevicePropertyTransportType,
    kAudioDeviceTransportTypeUnknown,
    kAudioDeviceTransportTypeBuiltIn,
    kAudioDeviceTransportTypeAggregate,
    kAudioDeviceTransportTypeVirtual,
    kAudioDeviceTransportTypePCI,
    kAudioDeviceTransportTypeUSB,
    kAudioDeviceTransportTypeFireWire,
    kAudioDeviceTransportTypeBluetooth,
    kAudioDeviceTransportTypeBluetoothLE,
    kAudioDeviceTransportTypeHDMI,
    kAudioDeviceTransportTypeDisplayPort,
    kAudioDeviceTransportTypeAirPlay,
    kAudioDeviceTransportTypeAVB,
    kAudioDeviceTransportTypeThunderbolt,
    AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize,
    AudioObjectPropertyAddress,
    AudioBufferList,
    AudioBuffer,
};
use std::error::Error;
use std::ptr;

/// Get transport type for a device (usb, bluetooth, hdmi, etc.)
fn get_transport_type(device_id: u32) -> String {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut transport_type: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;

    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            &mut transport_type as *mut u32 as *mut _,
        )
    };

    if status != 0 {
        return "unknown".to_string();
    }

    match transport_type {
        x if x == kAudioDeviceTransportTypeBuiltIn => "builtin",
        x if x == kAudioDeviceTransportTypeUSB => "usb",
        x if x == kAudioDeviceTransportTypeBluetooth => "bluetooth",
        x if x == kAudioDeviceTransportTypeBluetoothLE => "bluetooth",
        x if x == kAudioDeviceTransportTypeHDMI => "hdmi",
        x if x == kAudioDeviceTransportTypeDisplayPort => "displayport",
        x if x == kAudioDeviceTransportTypeAirPlay => "airplay",
        x if x == kAudioDeviceTransportTypeThunderbolt => "thunderbolt",
        x if x == kAudioDeviceTransportTypePCI => "pci",
        x if x == kAudioDeviceTransportTypeFireWire => "firewire",
        x if x == kAudioDeviceTransportTypeVirtual => "virtual",
        x if x == kAudioDeviceTransportTypeAggregate => "aggregate",
        x if x == kAudioDeviceTransportTypeAVB => "avb",
        x if x == kAudioDeviceTransportTypeUnknown => "unknown",
        _ => "unknown",
    }.to_string()
}

/// Get channel count for a device in a specific scope (input/output)
fn get_channel_count(device_id: u32, is_input: bool) -> u32 {
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

    // Get the size of the buffer list
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

    // Allocate buffer and get the data
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

    // Parse AudioBufferList to count channels
    let buffer_list = unsafe { &*(buffer.as_ptr() as *const AudioBufferList) };
    let num_buffers = buffer_list.mNumberBuffers;
    
    if num_buffers == 0 {
        return 0;
    }

    // Sum up channels from all buffers
    let mut total_channels = 0u32;
    let buffers_ptr: *const AudioBuffer = &buffer_list.mBuffers as *const _;
    
    for i in 0..num_buffers {
        let audio_buffer = unsafe { &*buffers_ptr.add(i as usize) };
        total_channels += audio_buffer.mNumberChannels;
    }

    total_channels
}

/// Get all audio devices on the system
pub fn get_devices() -> Result<Vec<AudioDevice>, Box<dyn Error + Send + Sync>> {
    let device_ids = get_audio_device_ids()
        .map_err(|e| format!("Failed to get device IDs: {:?}", e))?;

    let mut devices = Vec::new();

    for device_id in device_ids {
        let name = get_device_name(device_id)
            .unwrap_or_else(|_| format!("Unknown Device {}", device_id));

        let input_channels = get_channel_count(device_id, true);
        let output_channels = get_channel_count(device_id, false);

        // Skip devices with no channels
        if input_channels == 0 && output_channels == 0 {
            continue;
        }

        // Determine device type based on name
        let device_type = if name.to_lowercase().contains("prism") {
            "prism"
        } else if name.to_lowercase().contains("blackhole") {
            "virtual"
        } else if name.to_lowercase().contains("virtual") || name.to_lowercase().contains("loopback") {
            "virtual"
        } else if name.to_lowercase().contains("built-in") || name.to_lowercase().contains("macbook") {
            "builtin"
        } else {
            "external"
        };

        // Get transport type from CoreAudio
        let transport_type = get_transport_type(device_id);

        devices.push(AudioDevice {
            id: device_id.to_string(),
            name,
            channels: input_channels.max(output_channels),
            is_input: input_channels > 0,
            is_output: output_channels > 0,
            device_type: device_type.to_string(),
            input_channels,
            output_channels,
            transport_type,
        });
    }

    // Sort: Prism first, then virtual, then builtin, then external
    devices.sort_by(|a, b| {
        let order = |t: &str| match t {
            "prism" => 0,
            "virtual" => 1,
            "builtin" => 2,
            "external" => 3,
            _ => 4,
        };
        order(&a.device_type).cmp(&order(&b.device_type))
    });

    Ok(devices)
}

/// Get audio levels for a specific device (mock for now)
pub fn get_levels(device_id: &str) -> Result<Vec<f32>, Box<dyn Error + Send + Sync>> {
    // TODO: Implement actual level metering via CoreAudio AudioDeviceIOProc
    // For now, return simulated levels
    let channel_count: usize = device_id.parse::<u32>()
        .ok()
        .and_then(|id| Some(get_channel_count(id, true).max(get_channel_count(id, false)) as usize))
        .unwrap_or(2);

    Ok((0..channel_count)
        .map(|_| rand_level())
        .collect())
}

fn rand_level() -> f32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    ((nanos % 100) as f32) / 100.0
}
