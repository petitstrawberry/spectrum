/**
 * Spectrum v2 API Client
 *
 * Pure Sends-on-Fader architecture API
 */

import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Type Definitions
// =============================================================================

// --- Device Types ---

export interface InputDeviceDto {
  id: string;
  device_id: number;
  name: string;
  channel_count: number;
  is_prism: boolean;
  transport_type: string;
}

export interface OutputDeviceDto {
  id: string;
  device_id: number;
  parent_name?: string;
  name: string;
  channel_count: number;
  icon_hint?: string;
  transport_type: string;
  is_aggregate: boolean;
  sub_devices: SubDeviceDto[];
}

export interface SubDeviceDto {
  id: string;
  name: string;
  channel_count: number;
  icon_hint?: string;
}

export interface PrismAppDto {
  pid: number;
  name: string;
  channel_offset: number;
}

export interface PrismStatusDto {
  connected: boolean;
  channels: number;
  apps: PrismAppDto[];
}

// --- Graph Types ---

export type SourceIdDto =
  | { type: 'prism_channel'; channel: number }
  | { type: 'input_device'; device_id: number; channel: number };

export interface OutputSinkDto {
  device_id: number;
  channel_offset: number;
  channel_count: number;
}

export interface PluginInstanceDto {
  instance_id: string;
  plugin_id: string;
  name: string;
  enabled: boolean;
}

export type NodeInfoDto =
  | { type: 'source'; handle: number; source_id: SourceIdDto; port_count: number; label: string }
  | { type: 'bus'; handle: number; bus_id: string; label: string; port_count: number; plugins: PluginInstanceDto[] }
  | { type: 'sink'; handle: number; sink: OutputSinkDto; port_count: number; label: string };

export interface EdgeInfoDto {
  id: number;
  source: number;
  source_port: number;
  target: number;
  target_port: number;
  gain: number;
  muted: boolean;
}

export interface GraphDto {
  nodes: NodeInfoDto[];
  edges: EdgeInfoDto[];
}

// --- Plugin Types ---

export interface PluginInfoDto {
  plugin_id: string;
  name: string;
  manufacturer: string;
  category: string;
}

// --- Meter Types ---

export interface PortMeterDto {
  peak: number;
  rms: number;
}

export interface NodeMeterDto {
  handle: number;
  inputs: PortMeterDto[];
  outputs: PortMeterDto[];
}

export interface EdgeMeterDto {
  edge_id: number;
  post_gain: PortMeterDto;
}

export interface GraphMetersDto {
  nodes: NodeMeterDto[];
  edges: EdgeMeterDto[];
}

// --- State Types ---

export interface GraphStateDto {
  version: number;
  nodes: NodeInfoDto[];
  edges: EdgeInfoDto[];
  ui_state?: any;
}

// --- System Types ---

export interface SystemStatusDto {
  audio_running: boolean;
  sample_rate: number;
  buffer_size: number;
  cpu_load: number;
}

// --- Edge Gain Update ---

export interface EdgeGainUpdate {
  id: number;
  gain: number;
}

// =============================================================================
// Device Commands
// =============================================================================

export async function getInputDevices(): Promise<InputDeviceDto[]> {
  return invoke<InputDeviceDto[]>('get_input_devices');
}

export async function getOutputDevices(): Promise<OutputDeviceDto[]> {
  return invoke<OutputDeviceDto[]>('get_output_devices');
}

export async function getPrismStatus(): Promise<PrismStatusDto> {
  return invoke<PrismStatusDto>('get_prism_status');
}

// =============================================================================
// Graph Commands
// =============================================================================

export async function addSourceNode(
  sourceId: SourceIdDto,
  label?: string
): Promise<number> {
  return invoke<number>('add_source_node', { sourceId, label });
}

export async function addBusNode(
  label: string,
  portCount?: number
): Promise<number> {
  return invoke<number>('add_bus_node', { label, portCount });
}

export async function addSinkNode(
  sink: OutputSinkDto,
  label?: string
): Promise<number> {
  return invoke<number>('add_sink_node', { sink, label });
}

export async function removeNode(handle: number): Promise<void> {
  return invoke('remove_node', { handle });
}

export async function addEdge(
  source: number,
  sourcePort: number,
  target: number,
  targetPort: number,
  gain?: number,
  muted?: boolean
): Promise<number> {
  return invoke<number>('add_edge', {
    source,
    sourcePort,
    target,
    targetPort,
    gain,
    muted,
  });
}

export async function removeEdge(id: number): Promise<void> {
  return invoke('remove_edge', { id });
}

export async function getGraph(): Promise<GraphDto> {
  return invoke<GraphDto>('get_graph');
}

// =============================================================================
// Edge Commands (Hot Path)
// =============================================================================

export async function setEdgeGain(id: number, gain: number): Promise<void> {
  return invoke('set_edge_gain', { id, gain });
}

export async function setEdgeMuted(id: number, muted: boolean): Promise<void> {
  return invoke('set_edge_muted', { id, muted });
}

export async function setEdgeGainsBatch(updates: EdgeGainUpdate[]): Promise<void> {
  return invoke('set_edge_gains_batch', { updates });
}

// =============================================================================
// Plugin Commands
// =============================================================================

export async function getAvailablePlugins(): Promise<PluginInfoDto[]> {
  return invoke<PluginInfoDto[]>('get_available_plugins');
}

export async function addPluginToBus(
  busHandle: number,
  pluginId: string,
  position?: number
): Promise<string> {
  return invoke<string>('add_plugin_to_bus', { busHandle, pluginId, position });
}

export async function removePluginFromBus(
  busHandle: number,
  instanceId: string
): Promise<void> {
  return invoke('remove_plugin_from_bus', { busHandle, instanceId });
}

export async function reorderPlugins(
  busHandle: number,
  instanceIds: string[]
): Promise<void> {
  return invoke('reorder_plugins', { busHandle, instanceIds });
}

export async function openPluginUI(instanceId: string): Promise<void> {
  return invoke('open_plugin_ui', { instanceId });
}

export async function closePluginUI(instanceId: string): Promise<void> {
  return invoke('close_plugin_ui', { instanceId });
}

// =============================================================================
// Meter Commands
// =============================================================================

export async function getMeters(): Promise<GraphMetersDto> {
  return invoke<GraphMetersDto>('get_meters');
}

export async function getNodeMeters(handles: number[]): Promise<NodeMeterDto[]> {
  return invoke<NodeMeterDto[]>('get_node_meters', { handles });
}

export async function getEdgeMeters(ids: number[]): Promise<EdgeMeterDto[]> {
  return invoke<EdgeMeterDto[]>('get_edge_meters', { ids });
}

// =============================================================================
// State Commands
// =============================================================================

export async function saveGraphState(): Promise<GraphStateDto> {
  return invoke<GraphStateDto>('save_graph_state');
}

export async function loadGraphState(state: GraphStateDto): Promise<void> {
  return invoke('load_graph_state', { state });
}

export async function persistState(): Promise<void> {
  return invoke('persist_state');
}

export async function restoreState(): Promise<boolean> {
  return invoke<boolean>('restore_state');
}

// =============================================================================
// System Commands
// =============================================================================

export async function startAudio(deviceId: number): Promise<void> {
  return invoke('start_audio', { deviceId });
}

export async function stopAudio(): Promise<void> {
  return invoke('stop_audio');
}

export async function getSystemStatus(): Promise<SystemStatusDto> {
  return invoke<SystemStatusDto>('get_system_status');
}


export async function setBufferSize(size: number): Promise<void> {
  return invoke('set_buffer_size', { size });
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert dB to linear gain */
export function dbToGain(db: number): number {
  if (db <= -100) return 0;
  return Math.pow(10, db / 20);
}

/** Convert linear gain to dB */
export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

/** Convert RMS to dB */
export function rmsToDb(rms: number): number {
  if (rms <= 0.00001) return -60;
  return Math.max(-60, Math.min(6, 20 * Math.log10(rms)));
}

/** Convert dB to meter percentage (0-100) */
export function dbToMeterPercent(db: number): number {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;
  // Simple linear mapping for now
  return ((db + 60) / 60) * 100;
}
