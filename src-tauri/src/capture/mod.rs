//! Capture Module - Input audio capture from devices
//!
//! Wraps the existing audio_capture functionality for v2 architecture

mod ring_buffer;

pub use ring_buffer::*;

// Re-export from legacy module for now
// TODO: Refactor into this module structure
pub use crate::audio_capture::{
    find_prism_device, get_device_input_channels, get_input_devices,
    get_io_buffer_size, is_capture_running, read_channel_audio,
    register_output_device, set_io_buffer_size, start_capture,
    stop_capture, unregister_output_device,
    // Generic input capture
    start_input_capture, stop_input_capture, read_input_audio,
    get_active_captures, is_device_capturing, get_input_device_levels,
    register_output_for_input, get_device_info,
};
