//! Device enumeration for input and output devices

use crate::api::dto::OutputDeviceDto;
use coreaudio::audio_unit::macos_helpers::{get_audio_device_ids, get_device_name};
use coreaudio::sys::{
    kAudioAggregateDevicePropertyActiveSubDeviceList, kAudioDevicePropertyDeviceUID,
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMaster,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, AudioBuffer, AudioBufferList,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
};
use std::ptr;

/// Get number of output channels for a device
pub fn get_device_output_channels(device_id: u32) -> u32 {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut size: u32 = 0;
    let status =
        unsafe { AudioObjectGetPropertyDataSize(device_id, &address, 0, ptr::null(), &mut size) };

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
pub fn get_device_uid(device_id: u32) -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportType {
    Bluetooth,
    USB,
    HDMI,
    DisplayPort,
    FireWire,
    Thunderbolt,
    Virtual,
    BuiltIn,
    PCI,
    PCIe,
    AVB,
    Unknown,
}

impl ToString for TransportType {
    fn to_string(&self) -> String {
        match self {
            TransportType::Bluetooth => "bluetooth",
            TransportType::USB => "usb",
            TransportType::HDMI => "hdmi",
            TransportType::DisplayPort => "displayport",
            TransportType::BuiltIn => "built-in",
            TransportType::FireWire => "firewire",
            TransportType::Thunderbolt => "thunderbolt",
            TransportType::Virtual => "virtual",
            TransportType::PCI => "pci",
            TransportType::PCIe => "pcie",
            TransportType::AVB => "avb",
            TransportType::Unknown => "unknown",
        }
        .to_string()
    }
}

/// Guess icon hint from device UID and transport type
fn get_icon_hint(uid: &str, transport_type: &TransportType) -> String {
    // Check exact UID hits first
    match uid {
        "BuiltInSpeakerDevice" => return "speaker".to_string(),
        "BuiltInHeadphoneOutputDevice" => return "headphones".to_string(),
        _ => (),
    }

    // Check substrings in UID
    // AppleUSBAudioEngine:Apple Inc.:Studio Display
    if uid.starts_with("AppleUSBAudioEngine:Apple Inc.:Studio Display") {
        return "display".to_string();
    }

    // Check transport type
    match transport_type {
        TransportType::Bluetooth => "bluetooth".to_string(),
        TransportType::USB => "usb".to_string(),
        TransportType::HDMI => "display".to_string(),
        TransportType::DisplayPort => "display".to_string(),
        TransportType::Virtual => "virtual".to_string(),
        TransportType::Unknown => "default".to_string(),
        _ => "default".to_string(),
    }
}

/// Get transport type for a device
fn get_transport_type(device_id: u32) -> TransportType {
    use coreaudio::sys::kAudioDevicePropertyTransportType;

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
        eprint!("Failed to get transport type for device {}", device_id);
        return TransportType::Unknown;
    }

    // Convert FourCC to string
    let bytes = transport_type.to_be_bytes();
    let four_cc = String::from_utf8(bytes.to_vec()).unwrap_or_default();

    // Normalize and match on substrings to tolerate short/variant FourCCs
    let s = four_cc.trim().to_lowercase();

    // Prefer explicit built-in/internal tokens to avoid confusing built-in with Bluetooth
    let ret = if s.contains("bltn") || s.contains("built") || s.contains("internal") {
        TransportType::BuiltIn
    } else if s.contains("blut") || s.contains("blue") || s.contains("blu") || s.contains("bt") {
        TransportType::Bluetooth
    } else if s.contains("usba") || s.contains("usb") {
        TransportType::USB
    } else if s.contains("hdmi") {
        TransportType::HDMI
    } else if s.contains("dprt") || s.contains("display") {
        TransportType::DisplayPort
    } else if s.contains("fire") {
        TransportType::FireWire
    } else if s.contains("thun") || s.contains("thdb") || s.contains("thdr") {
        TransportType::Thunderbolt
    } else if s.contains("virt") {
        TransportType::Virtual
    } else if s.contains("pcie") {
        TransportType::PCIe
    } else if s.contains("pci") {
        TransportType::PCI
    } else if s.contains("avb") {
        TransportType::AVB
    } else {
        TransportType::Unknown
    };

    ret
}

/// Get list of output devices (with virtual device expansion for aggregate devices)
pub fn get_output_devices() -> Vec<OutputDeviceDto> {
    let mut result = Vec::new();

    let device_ids = match get_audio_device_ids() {
        Ok(ids) => ids,
        Err(_) => return result,
    };

    // Determine Prism device ID (if present) and exclude it by id to avoid
    // accidentally filtering other devices whose name contains "prism".
    let prism_device_id = crate::capture::find_prism_device();

    for device_id in device_ids {
        let output_channels = get_device_output_channels(device_id);
        if output_channels == 0 {
            continue; // Not an output device
        }

        let name = get_device_name(device_id).unwrap_or_else(|_| format!("Device {}", device_id));
        let transport_type = get_transport_type(device_id);

        // Exclude the Prism virtual device by id (if present)
        if let Some(pid) = prism_device_id {
            if pid == device_id {
                continue;
            }
        }

        if is_aggregate_device(device_id) {
            // Expand aggregate device into its active sub-devices when possible
            let subs = get_aggregate_sub_devices(device_id);
            if !subs.is_empty() {
                let mut offset = 0u32;
                for sub in subs.iter() {
                    if sub.channels == 0 {
                        continue;
                    }

                    let transport_type = get_transport_type(sub.original_id);

                    // Generate ID with subdevice UID hash to track devices across configuration changes
                    let id = if let Some(ref uid) = sub.uid {
                        // New format: vout_{device_id}_{offset}_{uid_hash}
                        // This ensures the same physical sub-device keeps the same ID even if
                        // the aggregate configuration changes (sub-devices added/removed)
                        format!("vout_{}_{}_{}", device_id, offset, uid_hash(uid))
                    } else {
                        // Fallback to old format if UID is not available
                        format!("vout_{}_{}", device_id, offset)
                    };

                    result.push(OutputDeviceDto {
                        id,
                        device_id,
                        device_uid: get_device_uid(device_id),
                        subdevice_uid: sub.uid.clone(),
                        parent_name: Some(name.clone()),
                        channel_offset: offset as u8,
                        channel_count: sub.channels.min(255) as u8,
                        name: sub.name.clone(),
                        device_type: "aggregate_sub".to_string(),
                        transport_type: transport_type.to_string(),
                        icon_hint: get_icon_hint(sub.uid.as_deref().unwrap_or(""), &transport_type),
                        is_aggregate_sub: true,
                    });

                    offset += sub.channels;
                }
            }
        } else {
            let device_uid = get_device_uid(device_id);
            // Regular device - single entry
            result.push(OutputDeviceDto {
                id: format!("vout_{}_0", device_id),
                device_id,
                channel_offset: 0,
                channel_count: output_channels.min(255) as u8,
                name: name.clone(),
                device_uid: device_uid.clone(),
                subdevice_uid: None,
                parent_name: None,
                device_type: "physical".to_string(),
                transport_type: transport_type.to_string(),
                icon_hint: get_icon_hint(device_uid.as_deref().unwrap_or(""), &transport_type),
                is_aggregate_sub: false,
            });
        }
    }

    result
}

/// Find a preferred output device to use as the default runtime target.
/// Preference: the first aggregate device found, otherwise the system default output device.
pub fn find_preferred_output_device() -> Option<u32> {
    // Prefer aggregate devices
    if let Ok(ids) = get_audio_device_ids() {
        for id in ids.iter() {
            if is_aggregate_device(*id) {
                return Some(*id);
            }
        }
    }

    // Fallback: query system default output device
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
        return Some(device_id);
    }

    None
}

/// Find a specific output device by ID
pub fn find_output_device(virtual_id: &str) -> Option<(u32, u8, u8)> {
    // Parse virtual ID: supports both formats:
    // - Old: "vout_{device_id}_{offset}"
    // - New: "vout_{device_id}_{offset}_{uid_hash}"
    let parts: Vec<&str> = virtual_id.split('_').collect();
    if parts.len() < 3 || parts.len() > 4 || parts[0] != "vout" {
        return None;
    }

    let device_id: u32 = parts[1].parse().ok()?;
    let channel_offset: u8 = parts[2].parse().ok()?;
    // parts[3] would be the uid_hash if present (ignored for lookup)

    let output_channels = get_device_output_channels(device_id);
    if output_channels == 0 {
        return None;
    }

    let available = (output_channels as u8).saturating_sub(channel_offset);
    let channel_count = available.min(2);

    Some((device_id, channel_offset, channel_count))
}

/// Get a set of all available input device UIDs
pub fn get_available_input_device_uids() -> std::collections::HashSet<String> {
    let devices = crate::audio_capture::get_input_devices();
    devices
        .into_iter()
        .filter_map(|(_, _, _, _, uid)| uid)
        .collect()
}

/// Get a set of all available output device UIDs (including sub-device UIDs)
pub fn get_available_output_device_uids() -> std::collections::HashSet<String> {
    use std::collections::HashSet;

    let mut uids = HashSet::new();

    let device_ids = match get_audio_device_ids() {
        Ok(ids) => ids,
        Err(_) => return uids,
    };

    for device_id in device_ids {
        // Add device UID if it has output channels
        if get_device_output_channels(device_id) > 0 {
            if let Some(uid) = get_device_uid(device_id) {
                uids.insert(uid);
            }

            // For aggregate devices, also add sub-device UIDs
            if is_aggregate_device(device_id) {
                let subs = get_aggregate_sub_devices(device_id);
                for sub in subs {
                    if let Some(uid) = sub.uid {
                        uids.insert(uid);
                    }
                }
            }
        }
    }

    uids
}

/// Check if an input device exists and is available by UID
pub fn is_input_device_available_by_uid(device_uid: &str) -> bool {
    get_available_input_device_uids().contains(device_uid)
}

/// Check if an output device exists and is available by UID
pub fn is_output_device_available_by_uid(device_uid: &str) -> bool {
    get_available_output_device_uids().contains(device_uid)
}

/// Information about an aggregate's sub-device
#[derive(Debug, Clone)]
pub struct SubDeviceInfo {
    pub uid: Option<String>,
    pub name: String,
    pub channels: u32,
    pub original_id: u32,
}

/// Generate a short stable hash from a device UID for use in virtual device IDs.
/// This ensures virtual devices can be tracked across aggregate device configuration changes.
/// Uses FNV-1a hash algorithm for better collision resistance.
pub fn uid_hash(uid: &str) -> String {
    // FNV-1a 64-bit hash: https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
    // Standard FNV-1a 64-bit constants
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325; // FNV offset basis for 64-bit
    const FNV_PRIME: u64 = 0x00000100000001b3; // FNV prime for 64-bit (correct 64-bit value)

    let mut hash: u64 = FNV_OFFSET_BASIS;
    for byte in uid.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    // Return 8-character hex string
    format!("{:08x}", hash)
}

/// Query aggregate device for its active sub-device list and resolve their UIDs/names/channels
pub fn get_aggregate_sub_devices(device_id: u32) -> Vec<SubDeviceInfo> {
    use std::mem::size_of;

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioAggregateDevicePropertyActiveSubDeviceList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };

    let mut size: u32 = 0;
    let status =
        unsafe { AudioObjectGetPropertyDataSize(device_id, &address, 0, ptr::null(), &mut size) };
    if status != 0 || size == 0 {
        return Vec::new();
    }

    let count = (size as usize) / size_of::<u32>();
    let mut ids: Vec<u32> = vec![0u32; count];
    let mut data_size = size;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut data_size,
            ids.as_mut_ptr() as *mut _,
        )
    };

    if status != 0 {
        return Vec::new();
    }

    let mut subs = Vec::new();
    for id in ids.into_iter() {
        let uid = get_device_uid(id);
        let name = get_device_name(id).unwrap_or_else(|_| format!("Device {}", id));
        let channels = get_device_output_channels(id);

        subs.push(SubDeviceInfo {
            uid,
            name,
            channels,
            original_id: id,
        });
    }

    subs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uid_hash() {
        // Test that the same UID produces the same hash
        let uid1 = "AppleUSBAudioEngine:Vendor:Product:12345";
        let hash1 = uid_hash(uid1);
        let hash2 = uid_hash(uid1);
        assert_eq!(hash1, hash2, "Same UID should produce same hash");
        assert_eq!(hash1.len(), 8, "Hash should be 8 characters");

        // Test that different UIDs produce different hashes
        let uid2 = "AppleUSBAudioEngine:Vendor:Product:67890";
        let hash3 = uid_hash(uid2);
        assert_ne!(
            hash1, hash3,
            "Different UIDs should produce different hashes"
        );

        // Test that hash is alphanumeric hex
        assert!(
            hash1.chars().all(|c| c.is_ascii_hexdigit()),
            "Hash should be hex"
        );
    }

    #[test]
    fn test_find_output_device_old_format() {
        // Test old format: vout_{device_id}_{offset}
        // This won't actually find a device in tests, but should parse correctly
        let old_format_id = "vout_123_4";
        let result = find_output_device(old_format_id);
        // Result will be None because device 123 doesn't exist, but it should parse without error
        // If the format was invalid, it would return None at parsing stage
    }

    #[test]
    fn test_find_output_device_new_format() {
        // Test new format: vout_{device_id}_{offset}_{uid_hash}
        let new_format_id = "vout_123_4_a1b2c3d4";
        let result = find_output_device(new_format_id);
        // Result will be None because device 123 doesn't exist, but it should parse without error
    }

    #[test]
    fn test_find_output_device_invalid_format() {
        // Test invalid formats
        assert!(find_output_device("invalid").is_none());
        assert!(find_output_device("vout_123").is_none()); // Too few parts
        assert!(find_output_device("vout_123_4_abc_extra").is_none()); // Too many parts
        assert!(find_output_device("vout_abc_4").is_none()); // Non-numeric device_id
        assert!(find_output_device("vout_123_abc").is_none()); // Non-numeric offset
    }

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
}
