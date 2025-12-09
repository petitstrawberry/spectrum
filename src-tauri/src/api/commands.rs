//! Tauri Commands - API endpoints for frontend

use super::dto::*;
use crate::audio::processor::get_graph_processor;
use crate::audio::{AudioNode, Edge, EdgeId, NodeHandle, PortId};

// =============================================================================
// Device Commands
// =============================================================================

#[tauri::command]
pub async fn get_input_devices() -> Result<Vec<InputDeviceDto>, String> {
    // Use the capture module to get devices
    let devices = crate::capture::get_input_devices();
    Ok(devices
        .into_iter()
        .map(|(id, name, channels, is_prism)| InputDeviceDto {
            id: format!("in_{}", id),
            device_id: id,
            name,
            channel_count: channels as u8,
            is_prism,
            transport_type: "Unknown".to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn get_output_devices() -> Result<Vec<OutputDeviceDto>, String> {
    // Use the device module to get output devices
    let devices = crate::device::get_output_devices();
    Ok(devices)
}

#[tauri::command]
pub async fn get_prism_status() -> Result<PrismStatusDto, String> {
    let connected = crate::capture::is_capture_running();
    let apps = crate::prismd::get_processes()
        .into_iter()
        .map(|p| PrismAppDto {
            pid: p.pid,
            name: p.name,
            channel_offset: (p.channel_offset / 2) as u8, // Convert to stereo pair index
        })
        .collect();

    Ok(PrismStatusDto {
        connected,
        channels: if connected { 64 } else { 0 },
        apps,
    })
}

// =============================================================================
// Graph Commands
// =============================================================================

#[tauri::command]
pub async fn add_source_node(
    source_id: SourceIdDto,
    label: Option<String>,
) -> Result<u32, String> {
    let processor = get_graph_processor();

    let node: Box<dyn AudioNode> = match source_id {
        SourceIdDto::PrismChannel { channel } => {
            let label = label.unwrap_or_else(|| format!("Prism Ch {}", channel));
            Box::new(crate::audio::source::SourceNode::new_prism(channel, label))
        }
        SourceIdDto::InputDevice { device_id, channel } => {
            let label = label.unwrap_or_else(|| format!("Input {}/{}", device_id, channel));
            Box::new(crate::audio::source::SourceNode::new_device(
                device_id, channel, label,
            ))
        }
    };

    let handle = processor.add_node(node);
    Ok(handle.raw())
}

#[tauri::command]
pub async fn add_bus_node(label: String, port_count: Option<u8>) -> Result<u32, String> {
    let processor = get_graph_processor();
    let port_count = port_count.unwrap_or(2);
    
    let bus_id = format!("bus_{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0"));
    let node: Box<dyn AudioNode> = if port_count == 2 {
        Box::new(crate::audio::bus::BusNode::new_stereo(&bus_id, &label))
    } else {
        Box::new(crate::audio::bus::BusNode::new(&bus_id, &label, port_count as usize))
    };
    
    let handle = processor.add_node(node);
    Ok(handle.raw())
}

#[tauri::command]
pub async fn add_sink_node(sink: OutputSinkDto, label: Option<String>) -> Result<u32, String> {
    let processor = get_graph_processor();
    
    let label = label.unwrap_or_else(|| format!("Output {}", sink.device_id));
    let sink_id = crate::audio::sink::SinkId::from(sink);
    let node: Box<dyn AudioNode> = Box::new(crate::audio::sink::SinkNode::new(sink_id, &label));
    
    let handle = processor.add_node(node);
    Ok(handle.raw())
}

#[tauri::command]
pub async fn remove_node(handle: u32) -> Result<(), String> {
    let processor = get_graph_processor();
    let node_handle = NodeHandle::from(handle);
    
    if processor.remove_node(node_handle) {
        Ok(())
    } else {
        Err(format!("Node {} not found", handle))
    }
}

#[tauri::command]
pub async fn add_edge(
    source: u32,
    source_port: u8,
    target: u32,
    target_port: u8,
    gain: Option<f32>,
    muted: Option<bool>,
) -> Result<u32, String> {
    let processor = get_graph_processor();
    
    let edge_id = processor.add_edge(
        NodeHandle::from(source),
        PortId::from(source_port),
        NodeHandle::from(target),
        PortId::from(target_port),
        gain.unwrap_or(1.0),
        muted.unwrap_or(false),
    );
    
    match edge_id {
        Some(id) => Ok(id.raw()),
        None => Err("Failed to add edge (nodes may not exist or edge already exists)".to_string()),
    }
}

#[tauri::command]
pub async fn remove_edge(id: u32) -> Result<(), String> {
    let processor = get_graph_processor();
    
    if processor.remove_edge(EdgeId::from(id)) {
        Ok(())
    } else {
        Err(format!("Edge {} not found", id))
    }
}

#[tauri::command]
pub async fn get_graph() -> Result<GraphDto, String> {
    let processor = get_graph_processor();
    
    processor.with_graph(|graph| {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();

        // Collect nodes - need type-specific info
        // For now, we create a basic representation
        for handle in graph.node_handles() {
            if let Some(node) = graph.get_node(handle) {
                // Create NodeInfoDto based on node type
                // Note: We need additional methods on nodes to get full info
                // This is a simplified version
                let info = match node.node_type() {
                    crate::audio::NodeType::Source => {
                        NodeInfoDto::Source {
                            handle: handle.raw(),
                            source_id: SourceIdDto::PrismChannel { channel: 0 }, // TODO: Get actual source_id
                            port_count: node.output_port_count() as u8,
                            label: node.label().to_string(),
                        }
                    }
                    crate::audio::NodeType::Bus => {
                        NodeInfoDto::Bus {
                            handle: handle.raw(),
                            bus_id: "unknown".to_string(), // TODO: Get actual bus_id
                            label: node.label().to_string(),
                            port_count: node.input_port_count() as u8,
                            plugins: Vec::new(), // TODO: Get plugins
                        }
                    }
                    crate::audio::NodeType::Sink => {
                        NodeInfoDto::Sink {
                            handle: handle.raw(),
                            sink: OutputSinkDto {
                                device_id: 0, // TODO: Get actual device_id
                                channel_offset: 0,
                                channel_count: node.input_port_count() as u8,
                            },
                            port_count: node.input_port_count() as u8,
                            label: node.label().to_string(),
                        }
                    }
                };
                nodes.push(info);
            }
        }

        // Collect edges
        for edge in graph.edges() {
            edges.push(EdgeInfoDto::from(edge.clone()));
        }

        Ok(GraphDto { nodes, edges })
    })
}

// =============================================================================
// Edge Commands (Hot Path - Realtime Parameter Changes)
// =============================================================================

#[tauri::command]
pub async fn set_edge_gain(id: u32, gain: f32) -> Result<(), String> {
    let processor = get_graph_processor();
    
    if processor.set_edge_gain(EdgeId::from(id), gain) {
        Ok(())
    } else {
        Err(format!("Edge {} not found", id))
    }
}

#[tauri::command]
pub async fn set_edge_muted(id: u32, muted: bool) -> Result<(), String> {
    let processor = get_graph_processor();
    
    if processor.set_edge_muted(EdgeId::from(id), muted) {
        Ok(())
    } else {
        Err(format!("Edge {} not found", id))
    }
}

#[tauri::command]
pub async fn set_edge_gains_batch(updates: Vec<EdgeGainUpdate>) -> Result<(), String> {
    let processor = get_graph_processor();
    
    let batch: Vec<_> = updates
        .into_iter()
        .map(|u| (EdgeId::from(u.id), u.gain))
        .collect();
    
    processor.set_edge_gains_batch(&batch);
    Ok(())
}

// =============================================================================
// Plugin Commands
// =============================================================================

#[tauri::command]
pub async fn get_available_plugins() -> Result<Vec<PluginInfoDto>, String> {
    let plugins = crate::audio_unit::get_effect_audio_units();
    Ok(plugins
        .into_iter()
        .map(|p| PluginInfoDto {
            plugin_id: p.id.clone(),
            name: p.name.clone(),
            manufacturer: p.manufacturer.clone(),
            category: p.plugin_type.clone(),
        })
        .collect())
}

#[tauri::command]
pub async fn add_plugin_to_bus(
    bus_handle: u32,
    plugin_id: String,
    position: Option<usize>,
) -> Result<String, String> {
    Err("Plugin management not yet implemented".to_string())
}

#[tauri::command]
pub async fn remove_plugin_from_bus(bus_handle: u32, instance_id: String) -> Result<(), String> {
    Err("Plugin management not yet implemented".to_string())
}

#[tauri::command]
pub async fn reorder_plugins(bus_handle: u32, instance_ids: Vec<String>) -> Result<(), String> {
    Err("Plugin management not yet implemented".to_string())
}

#[tauri::command]
pub async fn open_plugin_ui(instance_id: String) -> Result<(), String> {
    Err("Plugin UI not yet implemented".to_string())
}

#[tauri::command]
pub async fn close_plugin_ui(instance_id: String) -> Result<(), String> {
    Err("Plugin UI not yet implemented".to_string())
}

// =============================================================================
// Meter Commands
// =============================================================================

#[tauri::command]
pub async fn get_meters() -> Result<GraphMetersDto, String> {
    let processor = get_graph_processor();
    let meters = processor.get_meters();
    Ok(GraphMetersDto::from((*meters).clone()))
}

#[tauri::command]
pub async fn get_node_meters(handles: Vec<u32>) -> Result<Vec<NodeMeterDto>, String> {
    let processor = get_graph_processor();
    let meters = processor.get_meters();

    let filtered: Vec<_> = meters
        .nodes
        .iter()
        .filter(|m| handles.contains(&m.handle.raw()))
        .map(|m| NodeMeterDto {
            handle: m.handle.raw(),
            inputs: m
                .inputs
                .iter()
                .map(|p| PortMeterDto {
                    peak: p.peak,
                    rms: p.rms,
                })
                .collect(),
            outputs: m
                .outputs
                .iter()
                .map(|p| PortMeterDto {
                    peak: p.peak,
                    rms: p.rms,
                })
                .collect(),
        })
        .collect();

    Ok(filtered)
}

#[tauri::command]
pub async fn get_edge_meters(ids: Vec<u32>) -> Result<Vec<EdgeMeterDto>, String> {
    let processor = get_graph_processor();
    let meters = processor.get_meters();

    let filtered: Vec<_> = meters
        .edges
        .iter()
        .filter(|m| ids.contains(&m.edge_id.raw()))
        .map(|m| EdgeMeterDto {
            edge_id: m.edge_id.raw(),
            post_gain: PortMeterDto {
                peak: m.post_gain.peak,
                rms: m.post_gain.rms,
            },
        })
        .collect();

    Ok(filtered)
}

// =============================================================================
// State Commands
// =============================================================================

#[tauri::command]
pub async fn save_graph_state() -> Result<GraphStateDto, String> {
    Err("State persistence not yet implemented".to_string())
}

#[tauri::command]
pub async fn load_graph_state(state: GraphStateDto) -> Result<(), String> {
    Err("State persistence not yet implemented".to_string())
}

#[tauri::command]
pub async fn persist_state() -> Result<(), String> {
    Err("State persistence not yet implemented".to_string())
}

// =============================================================================
// System Commands
// =============================================================================

#[tauri::command]
pub async fn start_audio() -> Result<(), String> {
    crate::capture::start_capture()?;
    // TODO: Start output
    Ok(())
}

#[tauri::command]
pub async fn stop_audio() -> Result<(), String> {
    crate::capture::stop_capture();
    // TODO: Stop output
    Ok(())
}

#[tauri::command]
pub async fn get_system_status() -> Result<SystemStatusDto, String> {
    let audio_running = crate::capture::is_capture_running();

    Ok(SystemStatusDto {
        audio_running,
        sample_rate: 48000,
        buffer_size: crate::capture::get_io_buffer_size() as u32,
        cpu_load: 0.0, // TODO: Implement CPU load monitoring
    })
}

#[tauri::command]
pub async fn set_buffer_size(size: u32) -> Result<(), String> {
    crate::capture::set_io_buffer_size(size as usize);
    Ok(())
}
