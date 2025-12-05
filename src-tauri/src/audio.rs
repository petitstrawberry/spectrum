//! CoreAudio utilities for device enumeration and level metering

use crate::AudioDevice;
use std::error::Error;

/// Get all audio devices on the system
pub fn get_devices() -> Result<Vec<AudioDevice>, Box<dyn Error + Send + Sync>> {
    // TODO: Implement using coreaudio-rs
    // For now, return mock data
    Ok(vec![
        AudioDevice {
            id: "prism_64ch".to_string(),
            name: "Prism Virtual Bus (64ch)".to_string(),
            channels: 64,
            is_input: true,
            is_output: false,
        },
        AudioDevice {
            id: "builtin_speakers".to_string(),
            name: "Built-in Speakers".to_string(),
            channels: 2,
            is_input: false,
            is_output: true,
        },
        AudioDevice {
            id: "builtin_mic".to_string(),
            name: "Built-in Microphone".to_string(),
            channels: 1,
            is_input: true,
            is_output: false,
        },
        AudioDevice {
            id: "blackhole_16ch".to_string(),
            name: "BlackHole 16ch".to_string(),
            channels: 16,
            is_input: true,
            is_output: true,
        },
    ])
}

/// Get audio levels for a specific device
pub fn get_levels(device_id: &str) -> Result<Vec<f32>, Box<dyn Error + Send + Sync>> {
    // TODO: Implement actual level metering via CoreAudio
    // For now, return random levels for testing
    let channel_count = match device_id {
        "prism_64ch" => 64,
        "blackhole_16ch" => 16,
        _ => 2,
    };

    Ok((0..channel_count)
        .map(|_| rand_level())
        .collect())
}

fn rand_level() -> f32 {
    // Simple pseudo-random for testing
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    ((nanos % 100) as f32) / 100.0
}
