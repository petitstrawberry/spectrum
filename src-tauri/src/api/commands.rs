//! Tauri Commands - API endpoints for frontend

use super::dto::*;
use crate::audio::processor::get_graph_processor;
use crate::audio::{AudioNode, Edge, EdgeId, NodeHandle, PortId};
use crate::audio::source::SourceNode;
use crate::audio::bus::BusNode;
use crate::audio::sink::SinkNode;

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

        // Collect nodes with type-specific info
        for handle in graph.node_handles() {
            if let Some(node) = graph.get_node(handle) {
                let info = match node.node_type() {
                    crate::audio::NodeType::Source => {
                        // Downcast to SourceNode to get source_id
                        if let Some(source_node) = node.as_any().downcast_ref::<SourceNode>() {
                            NodeInfoDto::Source {
                                handle: handle.raw(),
                                source_id: SourceIdDto::from(source_node.source_id().clone()),
                                port_count: node.output_port_count() as u8,
                                label: node.label().to_string(),
                            }
                        } else {
                            // Fallback if downcast fails
                            NodeInfoDto::Source {
                                handle: handle.raw(),
                                source_id: SourceIdDto::PrismChannel { channel: 0 },
                                port_count: node.output_port_count() as u8,
                                label: node.label().to_string(),
                            }
                        }
                    }
                    crate::audio::NodeType::Bus => {
                        // Downcast to BusNode to get bus_id and plugins
                        if let Some(bus_node) = node.as_any().downcast_ref::<BusNode>() {
                            NodeInfoDto::Bus {
                                handle: handle.raw(),
                                bus_id: bus_node.bus_id().to_string(),
                                label: node.label().to_string(),
                                port_count: node.input_port_count() as u8,
                                plugins: bus_node.plugins().iter().map(|p| PluginInstanceDto {
                                    instance_id: p.instance_id.clone(),
                                    plugin_id: p.plugin_id.clone(),
                                    name: p.name.clone(),
                                    enabled: p.enabled,
                                }).collect(),
                            }
                        } else {
                            NodeInfoDto::Bus {
                                handle: handle.raw(),
                                bus_id: "unknown".to_string(),
                                label: node.label().to_string(),
                                port_count: node.input_port_count() as u8,
                                plugins: Vec::new(),
                            }
                        }
                    }
                    crate::audio::NodeType::Sink => {
                        // Downcast to SinkNode to get sink_id
                        if let Some(sink_node) = node.as_any().downcast_ref::<SinkNode>() {
                            NodeInfoDto::Sink {
                                handle: handle.raw(),
                                sink: OutputSinkDto::from(sink_node.sink_id().clone()),
                                port_count: node.input_port_count() as u8,
                                label: node.label().to_string(),
                            }
                        } else {
                            NodeInfoDto::Sink {
                                handle: handle.raw(),
                                sink: OutputSinkDto {
                                    device_id: 0,
                                    channel_offset: 0,
                                    channel_count: node.input_port_count() as u8,
                                },
                                port_count: node.input_port_count() as u8,
                                label: node.label().to_string(),
                            }
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
    let handle = NodeHandle::from_raw(bus_handle);
    let processor = get_graph_processor();

    // Get plugin info
    let plugins = crate::audio_unit::get_effect_audio_units();
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("Plugin not found: {}", plugin_id))?;

    // Generate unique instance ID
    let instance_id = uuid::Uuid::new_v4().to_string();
    let plugin_name = plugin.name.clone();
    let plugin_id_clone = plugin_id.clone();
    let instance_id_clone = instance_id.clone();

    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                if let Some(pos) = position {
                    // Insert at specific position - add then reorder
                    bus.add_plugin(instance_id_clone.clone(), plugin_id_clone.clone(), plugin_name.clone());
                    // Get current order and move new plugin to position
                    let mut ids: Vec<String> = bus.plugins().iter().map(|p| p.instance_id.clone()).collect();
                    if pos < ids.len() - 1 {
                        let new_id = ids.pop().unwrap();
                        ids.insert(pos, new_id);
                        bus.reorder_plugins(&ids);
                    }
                } else {
                    bus.add_plugin(instance_id_clone.clone(), plugin_id_clone.clone(), plugin_name.clone());
                }
            }
        }
    });

    Ok(instance_id)
}

#[tauri::command]
pub async fn remove_plugin_from_bus(bus_handle: u32, instance_id: String) -> Result<(), String> {
    let handle = NodeHandle::from_raw(bus_handle);
    let processor = get_graph_processor();

    let mut found = false;
    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                if bus.remove_plugin(&instance_id).is_some() {
                    found = true;
                }
            }
        }
    });

    if found {
        Ok(())
    } else {
        Err(format!("Plugin instance not found: {}", instance_id))
    }
}

#[tauri::command]
pub async fn reorder_plugins(bus_handle: u32, instance_ids: Vec<String>) -> Result<(), String> {
    let handle = NodeHandle::from_raw(bus_handle);
    let processor = get_graph_processor();

    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                bus.reorder_plugins(&instance_ids);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn open_plugin_ui(instance_id: String) -> Result<(), String> {
    // Verify the instance exists first
    let _au_instance = crate::audio_unit::get_au_manager()
        .get_instance(&instance_id)
        .ok_or_else(|| format!("Plugin instance not found: {}", instance_id))?;

    // UI operations must run on main thread
    // We need to dispatch to main thread and wait for completion
    let instance_id_clone = instance_id.clone();

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    // Dispatch to main thread
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;
        use objc2::class;
        use block2::RcBlock;

        let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

        let block = RcBlock::new(move || {
            let result = crate::audio_unit_ui::open_plugin_ui_by_instance_id(&instance_id_clone);
            let _ = tx.send(result);
        });

        let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
    }

    // Wait for result with timeout
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Timeout waiting for UI to open".to_string())?
}

#[tauri::command]
pub async fn close_plugin_ui(instance_id: String) -> Result<(), String> {
    crate::audio_unit_ui::close_audio_unit_ui(&instance_id);
    Ok(())
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
    let graph_dto = get_graph().await?;

    Ok(GraphStateDto {
        version: 1,
        nodes: graph_dto.nodes,
        edges: graph_dto.edges,
        ui_state: None, // UI state is managed by frontend
    })
}

#[tauri::command]
pub async fn load_graph_state(state: GraphStateDto) -> Result<(), String> {
    let processor = get_graph_processor();

    // Clear existing graph and rebuild from state
    processor.with_graph_mut(|graph| {
        // Clear existing nodes and edges
        let handles: Vec<_> = graph.node_handles().collect();
        for handle in handles {
            graph.remove_node(handle);
        }
    });

    // Recreate nodes
    let mut handle_mapping: std::collections::HashMap<u32, NodeHandle> = std::collections::HashMap::new();

    for node_info in &state.nodes {
        let (old_handle, new_handle) = match node_info {
            NodeInfoDto::Source { handle, source_id, label, .. } => {
                let node: Box<dyn AudioNode> = match source_id {
                    SourceIdDto::PrismChannel { channel } => {
                        Box::new(SourceNode::new_prism(*channel, label.clone()))
                    }
                    SourceIdDto::InputDevice { device_id, channel } => {
                        Box::new(SourceNode::new_device(*device_id, *channel, label.clone()))
                    }
                };
                (*handle, processor.add_node(node))
            }
            NodeInfoDto::Bus { handle, bus_id, label, port_count, plugins } => {
                let mut bus = BusNode::new(bus_id.clone(), label.clone(), *port_count as usize);
                // Add plugins
                for plugin in plugins {
                    bus.add_plugin(
                        plugin.instance_id.clone(),
                        plugin.plugin_id.clone(),
                        plugin.name.clone(),
                    );
                }
                (*handle, processor.add_node(Box::new(bus)))
            }
            NodeInfoDto::Sink { handle, sink, label, .. } => {
                let sink_id = crate::audio::sink::SinkId::from(sink.clone());
                let node = SinkNode::new(sink_id, label.clone());
                (*handle, processor.add_node(Box::new(node)))
            }
        };
        handle_mapping.insert(old_handle, new_handle);
    }

    // Recreate edges with mapped handles
    for edge_info in &state.edges {
        let source_handle = handle_mapping
            .get(&edge_info.source)
            .ok_or_else(|| format!("Source node {} not found in mapping", edge_info.source))?;
        let target_handle = handle_mapping
            .get(&edge_info.target)
            .ok_or_else(|| format!("Target node {} not found in mapping", edge_info.target))?;

        processor.add_edge(
            *source_handle,
            PortId::from(edge_info.source_port),
            *target_handle,
            PortId::from(edge_info.target_port),
            edge_info.gain,
            edge_info.muted,
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn persist_state() -> Result<(), String> {
    use std::fs;

    // Get app data directory
    let app_data = dirs::data_dir()
        .ok_or("Could not find app data directory")?
        .join("spectrum");

    // Create directory if it doesn't exist
    fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    // Save graph state
    let state = save_graph_state().await?;
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;

    let state_file = app_data.join("graph_state_v2.json");
    fs::write(&state_file, json)
        .map_err(|e| format!("Failed to write state file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn restore_state() -> Result<bool, String> {
    use std::fs;

    // Get app data directory
    let app_data = dirs::data_dir()
        .ok_or("Could not find app data directory")?
        .join("spectrum");

    let state_file = app_data.join("graph_state_v2.json");

    // Check if state file exists
    if !state_file.exists() {
        return Ok(false); // No state to restore
    }

    // Read and parse state file
    let json = fs::read_to_string(&state_file)
        .map_err(|e| format!("Failed to read state file: {}", e))?;

    let state: GraphStateDto = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse state file: {}", e))?;

    // Load the state
    load_graph_state(state).await?;

    Ok(true)
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

// =============================================================================
// App Icon (macOS)
// =============================================================================

#[tauri::command]
pub async fn get_app_icon_by_pid(_pid: u32) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        // Icon retrieval by PID is disabled for now.
        // The UI should continue using type/category icons (same as V1).
        Err("get_app_icon_by_pid is temporarily disabled; use type icons".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("get_app_icon_by_pid is only supported on macOS".to_string())
    }
}
