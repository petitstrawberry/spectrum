//! Capture Module - Input audio capture from devices
//!
//! Wraps the existing audio_capture functionality for v2 architecture

mod ring_buffer;

pub use ring_buffer::*;

// Re-export from legacy module for now
// TODO: Refactor into this module structure
pub use crate::audio_capture::{
    find_prism_device,
    get_active_captures,
    get_device_info,
    get_device_input_channels,
    get_input_device_levels,
    get_input_devices,
    get_io_buffer_size,
    is_capture_running,
    is_device_capturing,
    read_channel_audio,
    read_input_audio,
    register_output_device,
    register_output_for_input,
    set_io_buffer_size,
    start_capture,
    // Generic input capture
    start_input_capture,
    stop_capture,
    stop_input_capture,
    unregister_output_device,
};
