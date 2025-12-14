//! Tauri Commands - API endpoints for frontend

use super::dto::*;
use crate::audio::output::start_output_v2;
use crate::audio::processor::get_graph_processor;
use crate::audio::{AudioNode, EdgeId, NodeHandle, PortId};
use crate::audio::source::SourceNode;
use crate::audio::bus::BusNode;
use crate::audio::sink::SinkNode;
use crate::UiStateCache;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tauri::State;

// =============================================================================
// State Logging
// =============================================================================

/// State log level:
/// - 0: off (default in release)
/// - 1: summary (default in debug builds)
/// - 2: verbose (set `SPECTRUM_STATE_LOG=2`)
fn state_log_level() -> u8 {
    if let Ok(v) = std::env::var("SPECTRUM_STATE_LOG") {
        let v = v.trim().to_ascii_lowercase();
        if v == "2" || v == "verbose" {
            2
        } else if v == "0" || v == "off" || v == "false" {
            0
        } else {
            1
        }
    } else if cfg!(debug_assertions) {
        1
    } else {
        0
    }
}

fn state_log_summary(msg: impl AsRef<str>) {
    if state_log_level() >= 1 {
        println!("[state] {}", msg.as_ref());
    }
}

fn state_log_verbose(msg: impl AsRef<str>) {
    if state_log_level() >= 2 {
        println!("[state] {}", msg.as_ref());
    }
}

fn state_uptime_ms() -> u128 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis()
}

static RESTORE_CALL_SEQ: AtomicU64 = AtomicU64::new(0);
static PERSIST_CALL_SEQ: AtomicU64 = AtomicU64::new(0);

// =============================================================================
// Stable Node IDs (for persistence)
// =============================================================================

fn stable_id_for_source_id(source_id: &SourceIdDto) -> String {
    match source_id {
        SourceIdDto::PrismChannel { channel } => format!("source:prism:{}", channel),
        SourceIdDto::InputDevice { device_id, channel } => {
            format!("source:device:{}:{}", device_id, channel)
        }
    }
}

fn stable_id_for_bus_id(bus_id: &str) -> String {
    format!("bus:{}", bus_id)
}

fn stable_id_for_sink(sink: &OutputSinkDto) -> String {
    format!(
        "sink:{}:{}:{}",
        sink.device_id, sink.channel_offset, sink.channel_count
    )
}

fn compute_stable_id_for_node(node: &NodeInfoDto) -> String {
    match node {
        NodeInfoDto::Source { source_id, .. } => stable_id_for_source_id(source_id),
        NodeInfoDto::Bus { bus_id, .. } => stable_id_for_bus_id(bus_id),
        NodeInfoDto::Sink { sink, .. } => stable_id_for_sink(sink),
    }
}

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
    // connected should reflect prismd daemon connection, not whether audio capture is active
    let connected = crate::prismd::is_connected();
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

    // De-dup: ensure only one node exists per logical source (Prism channel / device input).
    // This guards against UI races / double-dispatch and keeps the patch graph consistent.
    let target_stable_id = stable_id_for_source_id(&source_id);
    if let Some(existing) = processor.with_graph(|graph| {
        for handle in graph.node_handles() {
            let Some(node) = graph.get_node(handle) else { continue };
            let Some(source_node) = node.as_any().downcast_ref::<SourceNode>() else { continue };
            let existing_id = stable_id_for_source_id(&SourceIdDto::from(source_node.source_id().clone()));
            if existing_id == target_stable_id {
                return Some(handle.raw());
            }
        }
        None
    }) {
        println!(
            "[api] add_source_node de-dup: source_id={:?} -> existing_handle={}",
            source_id, existing
        );
        return Ok(existing);
    }

    // Debug log: indicate frontend requested adding a source
    println!("[api] add_source_node invoked: source_id={:?}, label={:?}", source_id, label);
    let node: Box<dyn AudioNode> = match source_id {
        SourceIdDto::PrismChannel { channel } => {
            let label = label.unwrap_or_else(|| format!("Prism Ch {}", channel));
            Box::new(crate::audio::source::SourceNode::new_prism(channel, label))
        }
        SourceIdDto::InputDevice { device_id, channel } => {
            let label = label.unwrap_or_else(|| format!("Input {}/{}", device_id, channel));
            // 外部入力デバイスはデバイスの実ch数に合わせてポート数を作る。
            // 以前は常に2ch(ステレオ)固定だったため、UI側が一瞬正しいch数で描画しても
            // 次のスナップショット更新で2chへ戻ってしまい、Canvas上で壊れる原因になっていた。
            let channel_count = crate::capture::get_device_input_channels(device_id) as usize;
            let channel_count = if channel_count == 0 { 2 } else { channel_count };
            Box::new(crate::audio::source::SourceNode::new_device_with_channels(
                device_id,
                channel,
                label,
                channel_count,
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

    // De-dup: avoid accidentally creating multiple identical buses (common during UI/dev refreshes).
    // We treat (label + port_count) as the logical identity.
    if let Some(existing) = processor.with_graph(|graph| {
        for handle in graph.node_handles() {
            let Some(node) = graph.get_node(handle) else { continue };
            let Some(bus) = node.as_any().downcast_ref::<BusNode>() else { continue };
            if bus.label() == label && bus.input_port_count() == port_count as usize {
                return Some(handle.raw());
            }
        }
        None
    }) {
        println!(
            "[api] add_bus_node de-dup: label={:?} port_count={} -> existing_handle={} ",
            label, port_count, existing
        );
        return Ok(existing);
    }

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

    // De-dup: ensure only one node exists per logical sink (device + offset + count).
    let target_stable_id = stable_id_for_sink(&sink);
    if let Some(existing) = processor.with_graph(|graph| {
        for handle in graph.node_handles() {
            let Some(node) = graph.get_node(handle) else { continue };
            let Some(sink_node) = node.as_any().downcast_ref::<SinkNode>() else { continue };
            let dto = OutputSinkDto::from(sink_node.sink_id().clone());
            let existing_id = stable_id_for_sink(&dto);
            if existing_id == target_stable_id {
                return Some(handle.raw());
            }
        }
        None
    }) {
        println!(
            "[api] add_sink_node de-dup: sink={:?} -> existing_handle={}",
            sink, existing
        );
        return Ok(existing);
    }

    // Debug log: indicate frontend requested adding a sink
    println!("[api] add_sink_node invoked: sink={:?}, label={:?}", sink, label);
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

    // If a bus node is being removed, close any open plugin UI windows first
    // and release plugin instances from the AudioUnit manager.
    // Best-effort: if closing times out, we still proceed with removal.
    let plugin_instance_ids: Vec<String> = processor.with_graph(|graph| {
        graph.get_node(node_handle)
            .and_then(|node| node.as_any().downcast_ref::<BusNode>())
            .map(|bus| bus.plugins().iter().map(|p| p.instance_id.clone()).collect())
            .unwrap_or_default()
    });

    if !plugin_instance_ids.is_empty() {
        let ids_for_ui = plugin_instance_ids.clone();
        let (tx, rx) = std::sync::mpsc::channel::<()>();

        unsafe {
            use block2::RcBlock;
            use objc2::class;
            use objc2::msg_send;
            use objc2::runtime::AnyObject;

            let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

            let block = RcBlock::new(move || {
                for id in &ids_for_ui {
                    crate::audio_unit_ui::close_audio_unit_ui(id);
                }
                let _ = tx.send(());
            });

            let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
        }

        if rx.recv_timeout(std::time::Duration::from_secs(2)).is_err() {
            eprintln!(
                "[api] remove_node: timeout closing plugin UIs for bus {}",
                handle
            );
        }

        // Release AU instances (best-effort)
        let au_manager = crate::audio_unit::get_au_manager();
        for id in &plugin_instance_ids {
            let _ = au_manager.remove_instance(id);
        }
    }

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

    let gain_v = gain.unwrap_or(1.0);
    let muted_v = muted.unwrap_or(false);

    // Debug log: indicate frontend requested adding an edge (graph mutation)
    println!(
        "[graph] add_edge invoked: {}:{} -> {}:{} gain={} muted={}",
        source, source_port, target, target_port, gain_v, muted_v
    );

    let edge_id = processor.add_edge(
        NodeHandle::from(source),
        PortId::from(source_port),
        NodeHandle::from(target),
        PortId::from(target_port),
        gain_v,
        muted_v,
    );

    match edge_id {
        Some(id) => {
            let (node_count, edge_count) = processor.with_graph(|g| (g.node_handles().count(), g.edges().len()));
            println!(
                "[graph] add_edge ok: edge_id={} nodes={} edges={}",
                id.raw(),
                node_count,
                edge_count
            );
            Ok(id.raw())
        }
        None => {
            let (node_count, edge_count) = processor.with_graph(|g| (g.node_handles().count(), g.edges().len()));
            println!(
                "[graph] add_edge FAILED: {}:{} -> {}:{} (nodes={} edges={})",
                source,
                source_port,
                target,
                target_port,
                node_count,
                edge_count
            );
            Err("Failed to add edge (nodes may not exist or edge already exists)".to_string())
        }
    }
}

#[tauri::command]
pub async fn remove_edge(id: u32) -> Result<(), String> {
    let processor = get_graph_processor();

    // Debug log: indicate frontend requested removing an edge (graph mutation)
    println!("[graph] remove_edge invoked: edge_id={}", id);

    if processor.remove_edge(EdgeId::from(id)) {
        let (node_count, edge_count) = processor.with_graph(|g| (g.node_handles().count(), g.edges().len()));
        println!(
            "[graph] remove_edge ok: edge_id={} nodes={} edges={}",
            id,
            node_count,
            edge_count
        );
        Ok(())
    } else {
        let (node_count, edge_count) = processor.with_graph(|g| (g.node_handles().count(), g.edges().len()));
        println!(
            "[graph] remove_edge NOT_FOUND: edge_id={} (nodes={} edges={})",
            id,
            node_count,
            edge_count
        );
        Err(format!("Edge {} not found", id))
    }
}

#[tauri::command]
pub async fn get_graph() -> Result<GraphDto, String> {
    let processor = get_graph_processor();

    processor.with_graph(|graph| {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();

        // Prism app lookup: channel_offset (stereo pair index) -> first app name.
        // Best-effort and local to this snapshot.
        let mut prism_app_by_offset: Option<std::collections::HashMap<u32, String>> = None;

        // Optional on-demand lookup for filling missing plugin metadata (old saved state).
        // Built lazily only if we detect missing fields to avoid extra work.
        let mut plugin_lookup: Option<HashMap<String, (String, String)>> = None;

        // Collect nodes with type-specific info
        for handle in graph.node_handles() {
            if let Some(node) = graph.get_node(handle) {
                let info = match node.node_type() {
                    crate::audio::NodeType::Source => {
                        // Downcast to SourceNode to get source_id
                        if let Some(source_node) = node.as_any().downcast_ref::<SourceNode>() {
                            // Normalize Prism source label semantics:
                            // - label: app name (or MAIN/Empty)
                            // - sub_label: channel label ("Ch 1-2")
                            let (label, sub_label) = match source_node.source_id() {
                                crate::audio::source::SourceId::PrismChannel { channel } => {
                                    if prism_app_by_offset.is_none() {
                                        let mut map: std::collections::HashMap<u32, String> =
                                            std::collections::HashMap::new();
                                        let list = crate::prismd::get_processes();
                                        for p in list {
                                            map.entry(p.channel_offset)
                                                .or_insert_with(|| p.name);
                                        }
                                        prism_app_by_offset = Some(map);
                                    }

                                    let app = prism_app_by_offset
                                        .as_ref()
                                        .and_then(|m| m.get(&(*channel as u32)).cloned());

                                    // Channel is stereo-pair index; convert to 1-based absolute channels.
                                    let base = (*channel as u16) * 2;
                                    let ch_l = base + 1;
                                    let ch_r = base + 2;
                                    let ch_label = format!("Ch {}-{}", ch_l, ch_r);

                                    // Channel 0 is treated as MAIN.
                                    if *channel == 0 {
                                        ("MAIN".to_string(), Some(ch_label))
                                    } else {
                                        (app.unwrap_or_else(|| "Empty".to_string()), Some(ch_label))
                                    }
                                }
                                _ => (node.label().to_string(), None),
                            };

                            NodeInfoDto::Source {
                                handle: handle.raw(),
                                stable_id: stable_id_for_source_id(&SourceIdDto::from(
                                    source_node.source_id().clone(),
                                )),
                                source_id: SourceIdDto::from(source_node.source_id().clone()),
                                port_count: node.output_port_count() as u8,
                                label,
                                sub_label,
                            }
                        } else {
                            // Fallback if downcast fails
                            NodeInfoDto::Source {
                                handle: handle.raw(),
                                stable_id: stable_id_for_source_id(&SourceIdDto::PrismChannel { channel: 0 }),
                                source_id: SourceIdDto::PrismChannel { channel: 0 },
                                port_count: node.output_port_count() as u8,
                                label: node.label().to_string(),
                                sub_label: None,
                            }
                        }
                    }
                    crate::audio::NodeType::Bus => {
                        // Downcast to BusNode to get bus_id and plugins
                        if let Some(bus_node) = node.as_any().downcast_ref::<BusNode>() {
                            let plugins = bus_node.plugins();

                            let needs_lookup = plugins.iter().any(|p| {
                                let name = p.name.trim();
                                let manufacturer = p.manufacturer.trim();

                                name.is_empty()
                                    || manufacturer.is_empty()
                                    || manufacturer.eq_ignore_ascii_case("unknown")
                            });

                            if needs_lookup && plugin_lookup.is_none() {
                                let mut map: HashMap<String, (String, String)> = HashMap::new();

                                for p in crate::audio_unit::get_effect_audio_units() {
                                    map.insert(
                                        p.id.clone(),
                                        (p.name.clone(), p.manufacturer.clone()),
                                    );
                                }
                                for p in crate::audio_unit::get_instrument_audio_units() {
                                    map.insert(
                                        p.id.clone(),
                                        (p.name.clone(), p.manufacturer.clone()),
                                    );
                                }
                                for p in crate::audio_unit::get_generator_audio_units() {
                                    map.insert(
                                        p.id.clone(),
                                        (p.name.clone(), p.manufacturer.clone()),
                                    );
                                }

                                plugin_lookup = Some(map);
                            }

                            let lookup = plugin_lookup.as_ref();
                            NodeInfoDto::Bus {
                                handle: handle.raw(),
                                bus_id: bus_node.bus_id().to_string(),
                                stable_id: stable_id_for_bus_id(bus_node.bus_id()),
                                label: node.label().to_string(),
                                port_count: node.input_port_count() as u8,
                                plugins: plugins
                                    .iter()
                                    .map(|p| {
                                        let mut name = p.name.clone();
                                        let mut manufacturer = p.manufacturer.clone();
                                        let missing = {
                                            let n = name.trim();
                                            let m = manufacturer.trim();

                                            n.is_empty()
                                                || m.is_empty()
                                                || m.eq_ignore_ascii_case("unknown")
                                        };

                                        if missing {
                                            if let Some(lookup) = lookup {
                                                if let Some((n, m)) = lookup.get(&p.plugin_id) {
                                                    if name.trim().is_empty() {
                                                        name = n.clone();
                                                    }
                                                    if manufacturer.trim().is_empty()
                                                        || manufacturer.trim().eq_ignore_ascii_case("unknown")
                                                    {
                                                        manufacturer = m.clone();
                                                    }
                                                }
                                            }
                                        }

                                        PluginInstanceDto {
                                            instance_id: p.instance_id.clone(),
                                            plugin_id: p.plugin_id.clone(),
                                            name,
                                            manufacturer,
                                            enabled: p.enabled,
                                            state: None,
                                        }
                                    })
                                    .collect(),
                            }
                        } else {
                            NodeInfoDto::Bus {
                                handle: handle.raw(),
                                bus_id: "unknown".to_string(),
                                stable_id: stable_id_for_bus_id("unknown"),
                                label: node.label().to_string(),
                                port_count: node.input_port_count() as u8,
                                plugins: Vec::new(),
                            }
                        }
                    }
                    crate::audio::NodeType::Sink => {
                        // Downcast to SinkNode to get sink_id
                        if let Some(sink_node) = node.as_any().downcast_ref::<SinkNode>() {
                            let sink_dto = OutputSinkDto::from(sink_node.sink_id().clone());
                            NodeInfoDto::Sink {
                                handle: handle.raw(),
                                stable_id: stable_id_for_sink(&sink_dto),
                                sink: sink_dto,
                                port_count: node.input_port_count() as u8,
                                label: node.label().to_string(),
                            }
                        } else {
                            let sink_dto = OutputSinkDto {
                                device_id: 0,
                                channel_offset: 0,
                                channel_count: node.input_port_count() as u8,
                            };
                            NodeInfoDto::Sink {
                                handle: handle.raw(),
                                stable_id: stable_id_for_sink(&sink_dto),
                                sink: sink_dto,
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
// Output Commands
// =============================================================================

/// Set output (sink/vout) gain (linear). Applied per-sink during summing.
#[tauri::command]
pub async fn set_output_gain(output_handle: u32, gain: f32) -> Result<(), String> {
    let processor = get_graph_processor();
    let handle = NodeHandle::from_raw(output_handle);

    let updated = processor.with_graph_mut(|graph| {
        let Some(node) = graph.get_node_mut(handle) else {
            return false;
        };
        let Some(sink) = node.as_any_mut().downcast_mut::<crate::audio::sink::SinkNode>() else {
            return false;
        };
        // RT-safe atomic store inside the SinkNode.
        sink.set_output_gain(gain);
        true
    });

    if updated {
        Ok(())
    } else {
        Err(format!(
            "Node {} is not an output (sink) node or was not found",
            output_handle
        ))
    }
}

/// Set output (sink/vout) gain for a specific channel/port (linear).
///
/// `channel` is the port index relative to the sink (0..channel_count).
#[tauri::command]
pub async fn set_output_channel_gain(
    output_handle: u32,
    channel: u32,
    gain: f32,
) -> Result<(), String> {
    let processor = get_graph_processor();
    let handle = NodeHandle::from_raw(output_handle);
    let ch = channel as usize;

    let updated = processor.with_graph_mut(|graph| {
        let Some(node) = graph.get_node_mut(handle) else {
            return Err("not_found".to_string());
        };
        let port_count = node.input_port_count();
        let Some(sink) = node
            .as_any_mut()
            .downcast_mut::<crate::audio::sink::SinkNode>()
        else {
            return Err("not_sink".to_string());
        };

        if ch >= port_count {
            return Err("bad_channel".to_string());
        }

        // RT-safe atomic store inside the SinkNode.
        sink.set_output_gain_for_port(ch, gain);
        Ok(())
    });

    match updated {
        Ok(()) => Ok(()),
        Err(tag) if tag == "not_found" => Err(format!("Node {} was not found", output_handle)),
        Err(tag) if tag == "not_sink" => Err(format!(
            "Node {} is not an output (sink) node or was not found",
            output_handle
        )),
        Err(tag) if tag == "bad_channel" => Err(format!(
            "Channel {} is out of range for sink node {}",
            channel, output_handle
        )),
        Err(e) => Err(e),
    }
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

    // Create the real AudioUnit instance in the manager
    let au_manager = crate::audio_unit::get_au_manager();
    let instance_id = au_manager.create_instance(plugin)?;

    // Add the plugin reference to the bus node
    let plugin_name = plugin.name.clone();
    let plugin_manufacturer = plugin.manufacturer.clone();
    let instance_id_clone = instance_id.clone();
    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                bus.add_plugin(
                    instance_id_clone.clone(),
                    plugin_id.clone(),
                    plugin_name,
                    plugin_manufacturer,
                );

                if let Some(pos) = position {
                    // Reorder if a position was specified
                    let mut ids: Vec<String> = bus.plugins().iter().map(|p| p.instance_id.clone()).collect();
                    if let Some(current_idx) = ids.iter().position(|id| id == &instance_id_clone) {
                        let id = ids.remove(current_idx);
                        ids.insert(pos.min(ids.len()), id);
                        bus.reorder_plugins(&ids);
                    }
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

    // If the plugin UI is open, close it first (must run on main thread).
    // Best-effort: if closing times out, we still proceed with removal.
    {
        let instance_id_clone = instance_id.clone();
        let (tx, rx) = std::sync::mpsc::channel::<()>();

        unsafe {
            use block2::RcBlock;
            use objc2::class;
            use objc2::msg_send;
            use objc2::runtime::AnyObject;

            let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

            let block = RcBlock::new(move || {
                crate::audio_unit_ui::close_audio_unit_ui(&instance_id_clone);
                let _ = tx.send(());
            });

            let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
        }

        if rx.recv_timeout(std::time::Duration::from_secs(2)).is_err() {
            eprintln!(
                "[api] remove_plugin_from_bus: timeout closing UI for instance {}",
                instance_id
            );
        }
    }

    let mut found_in_bus = false;
    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                if bus.remove_plugin(&instance_id).is_some() {
                    found_in_bus = true;
                }
            }
        }
    });

    // Also remove from the manager to release resources
    let au_manager = crate::audio_unit::get_au_manager();
    let removed_from_manager = au_manager.remove_instance(&instance_id);

    if found_in_bus || removed_from_manager {
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
pub async fn set_plugin_enabled(
    bus_handle: u32,
    instance_id: String,
    enabled: bool,
) -> Result<(), String> {
    let handle = NodeHandle::from_raw(bus_handle);
    let processor = get_graph_processor();

    let mut found_in_bus = false;
    processor.with_graph_mut(|graph| {
        if let Some(node) = graph.get_node_mut(handle) {
            if let Some(bus) = node.as_any_mut().downcast_mut::<BusNode>() {
                if bus.set_plugin_enabled(&instance_id, enabled) {
                    found_in_bus = true;
                }
            }
        }
    });

    // Best-effort: also set AU manager's enabled flag (lock-free atomic).
    // Even if the bus doesn't have the instance (stale UI), we keep behavior consistent.
    let au_manager = crate::audio_unit::get_au_manager();
    let _ = au_manager.set_enabled(&instance_id, enabled);

    if found_in_bus {
        Ok(())
    } else {
        Err(format!("Plugin instance not found in bus: {}", instance_id))
    }
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
    let instance_id_clone = instance_id.clone();
    let (tx, rx) = std::sync::mpsc::channel::<()>();

    unsafe {
        use block2::RcBlock;
        use objc2::class;
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let main_queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];

        let block = RcBlock::new(move || {
            crate::audio_unit_ui::close_audio_unit_ui(&instance_id_clone);
            let _ = tx.send(());
        });

        let _: () = msg_send![main_queue, addOperationWithBlock: &*block];
    }

    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Timeout waiting for UI to close".to_string())?;

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
pub async fn save_graph_state(ui_state: Option<UIStateDto>) -> Result<GraphStateDto, String> {
    use base64::Engine;

    let mut graph_dto = get_graph().await?;

    // Capture plugin parameter state (AU fullState) for all known instances.
    // This can be large, so we only populate it for persisted GraphState.
    let au_manager = crate::audio_unit::get_au_manager();
    let states = au_manager.collect_all_instance_states();

    for node in &mut graph_dto.nodes {
        if let NodeInfoDto::Bus { plugins, .. } = node {
            for p in plugins.iter_mut() {
                let state = states
                    .get(&p.instance_id)
                    .and_then(|s| s.as_ref())
                    .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
                p.state = state;
            }
        }
    }

    Ok(GraphStateDto {
        version: 3,
        nodes: graph_dto.nodes,
        edges: graph_dto.edges,
        ui_state,
    })
}

#[tauri::command]
pub async fn load_graph_state(state: GraphStateDto) -> Result<(), String> {
    let processor = get_graph_processor();

    state_log_summary(format!(
        "load_graph_state: begin version={} nodes={} edges={} ui_state={}",
        state.version,
        state.nodes.len(),
        state.edges.len(),
        if state.ui_state.is_some() { "yes" } else { "no" }
    ));

    // Reset AudioUnit instances (plugin chain state belongs to the graph state).
    crate::audio_unit::get_au_manager().remove_all_instances();

    // Lookup table for plugin info by ID (for recreating AU instances on restore).
    let mut plugin_lookup: HashMap<String, crate::audio_unit::AudioUnitInfo> = HashMap::new();
    for p in crate::audio_unit::get_effect_audio_units() {
        plugin_lookup.insert(p.id.clone(), p);
    }
    for p in crate::audio_unit::get_instrument_audio_units() {
        plugin_lookup.insert(p.id.clone(), p);
    }
    for p in crate::audio_unit::get_generator_audio_units() {
        plugin_lookup.insert(p.id.clone(), p);
    }

    // Clear existing graph and rebuild from state
    processor.with_graph_mut(|graph| {
        // Clear existing nodes and edges
        let handles: Vec<_> = graph.node_handles().collect();
        state_log_verbose(format!("load_graph_state: clearing existing nodes={}", handles.len()));
        for handle in handles {
            graph.remove_node(handle);
        }
    });

    // Recreate nodes
    let mut handle_mapping: std::collections::HashMap<u32, NodeHandle> = std::collections::HashMap::new();
    let mut stable_to_handle: std::collections::HashMap<String, NodeHandle> = std::collections::HashMap::new();

    let mut recreated_nodes: usize = 0;
    let mut deduped_nodes: usize = 0;

    for node_info in &state.nodes {
        // De-dup nodes by stable id to guard against already-corrupted state files.
        // If duplicates exist, we map all old handles to the first recreated node.
        let stable_id = match node_info {
            NodeInfoDto::Source { stable_id, .. }
            | NodeInfoDto::Bus { stable_id, .. }
            | NodeInfoDto::Sink { stable_id, .. } => {
                if stable_id.trim().is_empty() {
                    compute_stable_id_for_node(node_info)
                } else {
                    stable_id.clone()
                }
            }
        };

        let old_handle_u32 = match node_info {
            NodeInfoDto::Source { handle, .. }
            | NodeInfoDto::Bus { handle, .. }
            | NodeInfoDto::Sink { handle, .. } => *handle,
        };

        if let Some(existing) = stable_to_handle.get(&stable_id) {
            handle_mapping.insert(old_handle_u32, *existing);
            deduped_nodes += 1;
            continue;
        }

        let (old_handle, new_handle) = match node_info {
            NodeInfoDto::Source {
                handle,
                stable_id: _,
                source_id,
                port_count,
                label,
                sub_label: _,
            } => {
                let node: Box<dyn AudioNode> = match source_id {
                    SourceIdDto::PrismChannel { channel } => {
                        Box::new(SourceNode::new_prism(*channel, label.clone()))
                    }
                    SourceIdDto::InputDevice { device_id, channel } => {
                        let port_count = (*port_count).max(1) as usize;
                        Box::new(SourceNode::new_device_with_channels(
                            *device_id,
                            *channel,
                            label.clone(),
                            port_count,
                        ))
                    }
                };
                (*handle, processor.add_node(node))
            }
            NodeInfoDto::Bus { handle, stable_id: _, bus_id, label, port_count, plugins } => {
                use base64::Engine;

                let mut bus = BusNode::new(bus_id.clone(), label.clone(), *port_count as usize);
                let au_manager = crate::audio_unit::get_au_manager();

                // Recreate plugin instances in the AU manager and rebuild the chain.
                for plugin in plugins {
                    let Some(info) = plugin_lookup.get(&plugin.plugin_id) else {
                        eprintln!("[state] Missing plugin {} (skipping)", plugin.plugin_id);
                        continue;
                    };

                    let instance_id = match au_manager.create_instance(info) {
                        Ok(id) => id,
                        Err(e) => {
                            eprintln!("[state] Failed to create instance for {}: {}", plugin.plugin_id, e);
                            continue;
                        }
                    };

                    // Prefer saved metadata if present; otherwise use current plugin info.
                    let name = if plugin.name.trim().is_empty() {
                        info.name.clone()
                    } else {
                        plugin.name.clone()
                    };
                    let manufacturer = if plugin.manufacturer.trim().is_empty()
                        || plugin.manufacturer.trim().eq_ignore_ascii_case("unknown")
                    {
                        info.manufacturer.clone()
                    } else {
                        plugin.manufacturer.clone()
                    };

                    bus.add_plugin(
                        instance_id.clone(),
                        plugin.plugin_id.clone(),
                        name,
                        manufacturer,
                    );

                    // Enabled state (both bus and AU manager).
                    let _ = bus.set_plugin_enabled(&instance_id, plugin.enabled);
                    let _ = au_manager.set_enabled(&instance_id, plugin.enabled);

                    // Full state (plugin parameters).
                    if let Some(state_b64) = &plugin.state {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(state_b64) {
                            let _ = au_manager.set_instance_full_state(&instance_id, &bytes);
                        } else {
                            eprintln!("[state] Failed to decode plugin state for {}", plugin.plugin_id);
                        }
                    }
                }

                (*handle, processor.add_node(Box::new(bus)))
            }
            NodeInfoDto::Sink { handle, stable_id: _, sink, label, .. } => {
                let sink_id = crate::audio::sink::SinkId::from(sink.clone());
                let node = SinkNode::new(sink_id, label.clone());
                (*handle, processor.add_node(Box::new(node)))
            }
        };
        stable_to_handle.insert(stable_id, new_handle);
        handle_mapping.insert(old_handle, new_handle);
        recreated_nodes += 1;
    }

    state_log_summary(format!(
        "load_graph_state: recreated_nodes={} dedup_skipped_nodes={} mapped_handles={} ",
        recreated_nodes,
        deduped_nodes,
        handle_mapping.len()
    ));

    // Recreate edges with mapped handles
    let mut recreated_edges: usize = 0;
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
        recreated_edges += 1;
    }

    state_log_summary(format!("load_graph_state: recreated_edges={}", recreated_edges));

    Ok(())
}

#[tauri::command]
pub async fn persist_state(ui_state: Option<UIStateDto>) -> Result<(), String> {
    use std::fs;

    let call_id = PERSIST_CALL_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let uptime = state_uptime_ms();

    // Get app data directory
    let app_data = dirs::data_dir()
        .ok_or("Could not find app data directory")?
        .join("spectrum");

    // Create directory if it doesn't exist
    fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    let state_file = app_data.join("graph_state.json");

    // Save graph state.
    // Guard against clobbering a non-empty on-disk graph with an empty in-memory graph
    // (which can happen early during app startup / dev refresh).
    let mut state = save_graph_state(ui_state).await?;

    // Best-effort: read existing on-disk state so we can avoid destructive early writes.
    let existing_state: Option<GraphStateDto> = if state_file.exists() {
        fs::read_to_string(&state_file)
            .ok()
            .and_then(|s| serde_json::from_str::<GraphStateDto>(&s).ok())
    } else {
        None
    };

    // Guard #1: never clobber non-empty with empty.
    if state.nodes.is_empty() && state.edges.is_empty() {
        if let Some(existing) = &existing_state {
            if !existing.nodes.is_empty() || !existing.edges.is_empty() {
                state_log_summary(format!(
                    "persist_state#{} @{}ms: refusing to clobber non-empty graph with empty snapshot; updating ui_state only",
                    call_id, uptime
                ));
                state.nodes = existing.nodes.clone();
                state.edges = existing.edges.clone();
            }
        }
    }

    // Guard #2 (startup): refuse a snapshot that drops all edges if the existing saved graph had edges.
    // This matches the observed failure mode where graph_state.json becomes partial and overrides a valid old file.
    if uptime < 8_000 && state.edges.is_empty() {
        if let Some(existing) = &existing_state {
            if !existing.edges.is_empty() {
                state_log_summary(format!(
                    "persist_state#{} @{}ms: refusing early edge-drop (snapshot edges=0, existing edges={}); keeping existing graph",
                    call_id,
                    uptime,
                    existing.edges.len()
                ));
                state.nodes = existing.nodes.clone();
                state.edges = existing.edges.clone();
            }
        }
    }

    state_log_summary(format!(
        "persist_state#{} @{}ms: writing {} (nodes={} edges={} ui_state={})",
        call_id,
        uptime,
        state_file.display(),
        state.nodes.len(),
        state.edges.len(),
        if state.ui_state.is_some() { "yes" } else { "no" }
    ));

    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize state: {}", e))?;

    fs::write(&state_file, json)
        .map_err(|e| format!("Failed to write state file: {}", e))?;

    Ok(())
}

/// Persist state in the background (returns immediately).
/// Useful if the frontend ever re-enables periodic autosave without blocking the UI.
#[tauri::command]
pub async fn persist_state_background(ui_state: Option<UIStateDto>) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = persist_state(ui_state).await {
            state_log_summary(format!("persist_state_background: persist_state failed: {}", e));
        }
    });
    Ok(())
}

/// Update the in-memory UI state cache (no disk I/O).
/// The app will flush this once on process exit.
#[tauri::command]
pub async fn set_ui_state_cache(
    state: State<'_, UiStateCache>,
    ui_state: UIStateDto,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "UiStateCache mutex poisoned".to_string())?;
    *guard = Some(ui_state);
    Ok(())
}

#[tauri::command]
pub async fn restore_state() -> Result<Option<UIStateDto>, String> {
    use std::fs;

    let call_id = RESTORE_CALL_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let uptime = state_uptime_ms();

    // Get app data directory
    let app_data = dirs::data_dir()
        .ok_or("Could not find app data directory")?
        .join("spectrum");

    let state_file_new = app_data.join("graph_state.json");

    if !state_file_new.exists() {
        state_log_summary(format!(
            "restore_state#{} @{}ms: no graph_state.json found",
            call_id, uptime
        ));
        return Ok(None);
    }

    let mut state: GraphStateDto;

    let json = fs::read_to_string(&state_file_new)
        .map_err(|e| format!("Failed to read state file: {}", e))?;

    state = serde_json::from_str::<GraphStateDto>(&json)
        .map_err(|e| format!("Failed to parse state file: {}", e))?;

    state_log_summary(format!(
        "restore_state#{} @{}ms: parsed graph_state.json (version={} nodes={} edges={})",
        call_id,
        uptime,
        state.version,
        state.nodes.len(),
        state.edges.len()
    ));

    state_log_summary(format!(
        "restore_state#{} @{}ms: selected nodes={} edges={}",
        call_id,
        uptime,
        state.nodes.len(),
        state.edges.len()
    ));

    // Normalize node stable IDs (older state files may not have them).
    let mut filled_stable_ids: usize = 0;
    for node in &mut state.nodes {
        let needs_fill = match node {
            NodeInfoDto::Source { stable_id, .. }
            | NodeInfoDto::Bus { stable_id, .. }
            | NodeInfoDto::Sink { stable_id, .. } => stable_id.trim().is_empty(),
        };

        if needs_fill {
            let computed = compute_stable_id_for_node(node);
            match node {
                NodeInfoDto::Source { stable_id, .. }
                | NodeInfoDto::Bus { stable_id, .. }
                | NodeInfoDto::Sink { stable_id, .. } => {
                    *stable_id = computed;
                    filled_stable_ids += 1;
                }
            }
        }
    }
    if filled_stable_ids > 0 {
        state_log_summary(format!(
            "restore_state#{} @{}ms: filled missing stable_id count={}",
            call_id, uptime, filled_stable_ids
        ));
    }

    // Normalize UIState: if legacy handle-keyed positions exist, convert them to stable-keyed.
    if let Some(ui) = state.ui_state.as_mut() {
        state_log_verbose(format!(
            "restore_state#{} @{}ms: ui_state positions(stable)={} positions(by_handle)={} ",
            call_id,
            uptime,
            ui.node_positions.len(),
            ui.node_positions_by_handle.len()
        ));
        if ui.node_positions.is_empty() && !ui.node_positions_by_handle.is_empty() {
            let mut handle_to_stable: HashMap<u32, String> = HashMap::new();
            for node in &state.nodes {
                match node {
                    NodeInfoDto::Source { handle, stable_id, .. }
                    | NodeInfoDto::Bus { handle, stable_id, .. }
                    | NodeInfoDto::Sink { handle, stable_id, .. } => {
                        let sid = if stable_id.trim().is_empty() {
                            compute_stable_id_for_node(node)
                        } else {
                            stable_id.clone()
                        };
                        handle_to_stable.insert(*handle, sid);
                    }
                }
            }

            let mut converted: usize = 0;

            for (h, pos) in ui.node_positions_by_handle.iter() {
                if let Some(stable_id) = handle_to_stable.get(h) {
                    ui.node_positions
                        .insert(stable_id.clone(), pos.clone());
                    converted += 1;
                }
            }

            state_log_summary(format!(
                "restore_state#{} @{}ms: converted legacy node_positions_by_handle -> node_positions count={}",
                call_id, uptime, converted
            ));
        }

        // Clear legacy map so frontend doesn't accidentally use it.
        ui.node_positions_by_handle.clear();
    }

    // Load the state
    let ui_state = state.ui_state.clone();
    state_log_summary(format!(
        "restore_state#{} @{}ms: loading graph into runtime",
        call_id, uptime
    ));
    load_graph_state(state).await?;
    state_log_summary(format!(
        "restore_state#{} @{}ms: load_graph_state completed",
        call_id, uptime
    ));

    Ok(ui_state)
}

// =============================================================================
// System Commands
// =============================================================================

#[tauri::command]
pub async fn start_audio(device_id: u32) -> Result<(), String> {
    crate::capture::start_capture()?;

    // If device_id == 0 treat as "auto": prefer aggregate device, otherwise system default.
    let target_device = if device_id == 0 {
        crate::device::find_preferred_output_device().unwrap_or(device_id)
    } else {
        device_id
    };

    if let Err(e) = start_output_v2(target_device) {
        crate::capture::stop_capture();
        return Err(e);
    }

    Ok(())
}

/// Stop only the physical output runtime (keep capture running).
/// This is used for output switching without resetting capture/ringbuffers.
#[tauri::command]
pub async fn stop_output_runtime() -> Result<(), String> {
    crate::audio::output::stop_output_v2();
    Ok(())
}

#[tauri::command]
pub async fn stop_audio() -> Result<(), String> {
    crate::capture::stop_capture();

    // Ensure physical output runtime is stopped as well
    crate::audio::output::stop_output_v2();

    Ok(())
}

#[tauri::command]
pub async fn get_output_runtime() -> Result<Option<u32>, String> {
    Ok(crate::audio::output::get_active_output_device())
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
