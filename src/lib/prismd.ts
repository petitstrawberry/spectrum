/**
 * Prism Daemon IPC Types and API
 */

import { invoke } from '@tauri-apps/api/core';

// --- Types ---

export interface ClientInfo {
  pid: number;
  client_id: number;
  channel_offset: number;
  process_name: string | null;
  responsible_pid: number | null;
  responsible_name: string | null;
}

// Individual client info within an app group
export interface ClientRouting {
  clientId: number;
  pid: number;
  processName: string;
  offset: number;
}

// App source grouped by responsible PID
export interface AppSource {
  id: string;
  name: string;
  category: 'game' | 'browser' | 'music' | 'system' | 'voice';
  pid: number;  // Responsible PID for group-level routing
  clients: ClientRouting[];  // All clients for this app
  active: boolean;
  color: string;  // Tailwind color class
}

export interface RoutingUpdate {
  pid: number;
  channel_offset: number;
}

export interface ClientRoutingUpdate {
  client_id: number;
  channel_offset: number;
}

export interface DriverStatus {
  connected: boolean;
  sample_rate: number;
  buffer_size: number;
}

export interface AudioDevice {
  id: string;
  name: string;
  channels: number;
  is_input: boolean;
  is_output: boolean;
  device_type: string;  // "prism", "virtual", "builtin", "external"
  input_channels: number;
  output_channels: number;
  transport_type: string;  // "builtin", "usb", "bluetooth", "hdmi", "displayport", "airplay", "thunderbolt", etc.
}

// --- Helpers ---

function detectCategory(name: string): AppSource['category'] {
  const lower = name.toLowerCase();

  if (/valorant|minecraft|steam|game|epic|battle\.net|origin|riot|apex|legends|fortnite/i.test(lower)) {
    return 'game';
  }
  if (/chrome|firefox|safari|edge|opera|brave|arc/i.test(lower)) {
    return 'browser';
  }
  if (/spotify|music|itunes|ableton|logic|fl studio|audacity|garageband|apple music/i.test(lower)) {
    return 'music';
  }
  if (/discord|slack|zoom|teams|facetime|skype|telegram|signal/i.test(lower)) {
    return 'voice';
  }
  return 'system';
}

function getCategoryColor(category: AppSource['category']): string {
  switch (category) {
    case 'game': return 'text-red-400';
    case 'browser': return 'text-blue-400';
    case 'music': return 'text-green-400';
    case 'voice': return 'text-indigo-400';
    case 'system': return 'text-slate-400';
  }
}

/**
 * Group clients by responsible PID (app-level grouping)
 */
export function groupClientsByApp(clients: ClientInfo[]): AppSource[] {
  const groups = new Map<number, ClientInfo[]>();

  for (const client of clients) {
    const pid = client.responsible_pid ?? client.pid;
    if (!groups.has(pid)) {
      groups.set(pid, []);
    }
    groups.get(pid)!.push(client);
  }

  return Array.from(groups.entries()).map(([responsiblePid, members]) => {
    const primary = members[0];
    const name = primary.responsible_name || primary.process_name || `PID ${responsiblePid}`;
    const category = detectCategory(name);

    // Collect all clients with their info
    const appClients = members.map(m => ({
      clientId: m.client_id,
      pid: m.pid,
      processName: m.process_name || `Client ${m.client_id}`,
      offset: m.channel_offset,
    }));

    // Get unique channel pairs used by this app
    const uniqueOffsets = [...new Set(appClients.map(c => c.offset))];

    return {
      id: `app-${responsiblePid}`,
      name,
      category,
      pid: responsiblePid,
      clients: appClients,
      active: true,
      color: getCategoryColor(category),
      // Store for display purposes
      channelOffsets: uniqueOffsets,
    };
  });
}

// --- API Functions ---

/**
 * Get list of active Prism clients
 */
export async function getPrismClients(): Promise<ClientInfo[]> {
  return invoke<ClientInfo[]>('get_prism_clients');
}

/**
 * Get clients grouped by app
 */
export async function getPrismApps(): Promise<AppSource[]> {
  const clients = await getPrismClients();
  return groupClientsByApp(clients);
}

/**
 * Set routing for a specific process by PID
 */
export async function setRouting(pid: number, offset: number): Promise<RoutingUpdate> {
  return invoke<RoutingUpdate>('set_routing', { pid, offset });
}

/**
 * Set routing for all clients of an app
 */
export async function setAppRouting(appName: string, offset: number): Promise<RoutingUpdate[]> {
  return invoke<RoutingUpdate[]>('set_app_routing', { appName, offset });
}

/**
 * Set routing for a specific client ID
 */
export async function setClientRouting(clientId: number, offset: number): Promise<ClientRoutingUpdate> {
  return invoke<ClientRoutingUpdate>('set_client_routing', { clientId, offset });
}

/**
 * Get driver status
 */
export async function getDriverStatus(): Promise<DriverStatus> {
  return invoke<DriverStatus>('get_driver_status');
}

/**
 * Get list of audio devices
 */
export async function getAudioDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>('get_audio_devices');
}

/**
 * Get audio levels for a device
 */
export async function getAudioLevels(deviceId: string): Promise<number[]> {
  return invoke<number[]>('get_audio_levels', { deviceId });
}

// --- Mixer/Router Types ---

export interface LevelData {
  left_rms: number;
  right_rms: number;
  left_peak: number;
  right_peak: number;
}

// --- Mixer/Router API Functions ---

/**
 * Get all input levels (32 stereo pairs from Prism)
 */
export async function getInputLevels(): Promise<LevelData[]> {
  return invoke<LevelData[]>('get_input_levels');
}

/**
 * Get output levels for a specific device
 */
export async function getOutputDeviceLevels(deviceId: string): Promise<LevelData[]> {
  return invoke<LevelData[]>('get_output_device_levels', { deviceId });
}

/**
 * Update a send connection (1ch unit)
 */
export async function updateMixerSend(
  sourceDevice: number,
  sourceChannel: number,
  targetDevice: string,
  targetChannel: number,
  level: number,
  muted: boolean
): Promise<void> {
  return invoke('update_mixer_send', {
    sourceDevice,
    sourceChannel,
    targetDevice,
    targetChannel,
    level,
    muted,
  });
}

/**
 * Remove a send connection (1ch unit)
 */
export async function removeMixerSend(
  sourceDevice: number,
  sourceChannel: number,
  targetDevice: string,
  targetChannel: number
): Promise<void> {
  return invoke('remove_mixer_send', {
    sourceDevice,
    sourceChannel,
    targetDevice,
    targetChannel,
  });
}

/**
 * Set source channel fader (0-100)
 */
export async function setSourceVolume(pairIndex: number, level: number): Promise<void> {
  return invoke('set_source_volume', { pairIndex, level });
}

/**
 * Set source channel mute
 */
export async function setSourceMute(pairIndex: number, muted: boolean): Promise<void> {
  return invoke('set_source_mute', { pairIndex, muted });
}

/**
 * Set output device master fader (0-100)
 */
export async function setOutputVolume(deviceId: string, level: number): Promise<void> {
  return invoke('set_output_volume', { deviceId, level });
}

/**
 * Check if Prism device is available
 */
export async function isPrismAvailable(): Promise<boolean> {
  return invoke<boolean>('is_prism_available');
}

/**
 * Start audio output to a specific device
 */
export async function startAudioOutput(deviceId: number): Promise<void> {
  return invoke('start_audio_output', { deviceId });
}

/**
 * Stop audio output to a specific device
 */
export async function stopAudioOutput(deviceId: number): Promise<void> {
  return invoke('stop_audio_output', { deviceId });
}

/**
 * Find output device by name
 */
export async function findOutputDevice(name: string): Promise<number | null> {
  return invoke<number | null>('find_output_device', { name });
}

/**
 * Start output to default audio device
 */
export async function startDefaultOutput(): Promise<void> {
  return invoke('start_default_output');
}

// --- Generic Input Device Capture Types ---

export interface InputDeviceInfo {
  device_id: number;
  name: string;
  channels: number;
  is_prism: boolean;
}

export interface ActiveCaptureInfo {
  device_id: number;
  name: string;
  channel_count: number;
  is_prism: boolean;
}

// --- Generic Input Device Capture API Functions ---

/**
 * Get list of available input devices
 */
export async function getInputDevices(): Promise<InputDeviceInfo[]> {
  return invoke<InputDeviceInfo[]>('get_input_devices');
}

/**
 * Start capture from a specific input device
 */
export async function startInputCapture(deviceId: number): Promise<boolean> {
  return invoke<boolean>('start_input_capture', { deviceId });
}

/**
 * Stop capture from a specific input device
 */
export async function stopInputCapture(deviceId: number): Promise<void> {
  return invoke('stop_input_capture', { deviceId });
}

/**
 * Stop all input captures
 */
export async function stopAllInputCaptures(): Promise<void> {
  return invoke('stop_all_input_captures');
}

/**
 * Get list of active input captures
 */
export async function getActiveInputCaptures(): Promise<ActiveCaptureInfo[]> {
  return invoke<ActiveCaptureInfo[]>('get_active_input_captures');
}

/**
 * Check if a specific input device is being captured
 */
export async function isInputDeviceCapturing(deviceId: number): Promise<boolean> {
  return invoke<boolean>('is_input_device_capturing', { deviceId });
}

/**
 * Get levels for a specific input device
 */
export async function getInputDeviceLevels(deviceId: number): Promise<LevelData[]> {
  return invoke<LevelData[]>('get_input_device_levels', { deviceId });
}

/**
 * Get current buffer size setting
 */
export async function getBufferSize(): Promise<number> {
  return invoke<number>('get_buffer_size');
}

/**
 * Set buffer size (requires restart to take effect on active captures)
 */
export async function setBufferSize(size: number): Promise<void> {
  return invoke('set_buffer_size', { size });
}

// --- App State Types ---

export interface OutputRoutingInfo {
  device_name: string;
  sources: [number, number][];  // [left_ch, right_ch]
  fader_gains: number[];
  send_gains: Record<number, number>[];
}

/** Saved AudioUnit plugin data */
export interface SavedPlugin {
  id: string;
  name: string;
  manufacturer: string;
  type: string;  // "effect" or "instrument"
  enabled: boolean;
}

/** Saved node data (serializable version of frontend NodeData) */
export interface SavedNode {
  id: string;
  library_id: string;
  node_type: string;  // "source", "target", or "bus"
  label: string;
  sub_label?: string;
  icon_name: string;  // Icon name as string
  color: string;
  x: number;
  y: number;
  volume: number;
  muted: boolean;
  channel_count: number;
  channel_offset?: number;
  source_type?: string;  // "prism-channel" or "device"
  device_id?: number;
  device_name?: string;
  channel_mode: string;  // "mono" or "stereo"
  bus_id?: string;  // Unique bus identifier (for bus nodes)
  plugins?: SavedPlugin[];  // AudioUnit plugin chain (for bus nodes)
}

/** Saved connection data */
export interface SavedConnection {
  id: string;
  from_node_id: string;
  from_channel: number;
  to_node_id: string;
  to_channel: number;
  send_level: number;
  muted: boolean;
  stereo_linked?: boolean;
}

export interface AppState {
  io_buffer_size: number;
  output_routings: Record<string, OutputRoutingInfo>;
  active_outputs: string[];
  master_gain: number;
  master_muted: boolean;
  patch_scroll_x: number;
  patch_scroll_y: number;
  patch_zoom: number;
  saved_nodes?: SavedNode[];
  saved_connections?: SavedConnection[];
}

/**
 * Get saved app state (routing, settings, etc.)
 */
export async function getAppState(): Promise<AppState> {
  return invoke<AppState>('get_app_state');
}

/**
 * Save app state (routing, settings, etc.)
 */
export async function saveAppState(state: AppState): Promise<void> {
  return invoke('save_app_state', { state });
}

/**
 * Restart the application
 */
export async function restartApp(): Promise<void> {
  return invoke('restart_app');
}

/**
 * Open Prism.app (companion app for channel assignment)
 */
export async function openPrismApp(): Promise<boolean> {
  return invoke<boolean>('open_prism_app');
}

// --- Bus Types ---

export interface BusInfo {
  id: string;
  label: string;
  channels: number;
  fader: number;
  muted: boolean;
}

// --- Bus API Functions ---

/**
 * Add a new bus
 */
export async function addBus(id: string, label: string, channels: number): Promise<void> {
  return invoke('add_bus', { id, label, channels });
}

/**
 * Remove a bus
 */
export async function removeBus(busId: string): Promise<void> {
  return invoke('remove_bus', { busId });
}

/**
 * Set bus fader level (0.0-1.0)
 */
export async function setBusFader(busId: string, level: number): Promise<void> {
  return invoke('set_bus_fader', { busId, level });
}

/**
 * Set bus mute state
 */
export async function setBusMute(busId: string, muted: boolean): Promise<void> {
  return invoke('set_bus_mute', { busId, muted });
}

/**
 * Get all buses
 */
export async function getBuses(): Promise<BusInfo[]> {
  return invoke<BusInfo[]>('get_buses');
}

/**
 * Add or update a bus send (Input -> Bus, Bus -> Bus, or Bus -> Output)
 * @param sourceType - "input" or "bus"
 * @param sourceId - device ID (for input) or bus ID (for bus)
 * @param sourceDevice - device ID number (0 for Prism, other for input devices)
 * @param sourceChannel - source channel index
 * @param targetType - "bus" or "output"
 * @param targetId - bus ID (for bus) or device ID string (for output)
 * @param targetChannel - target channel index
 * @param level - send level (0.0-1.0)
 * @param muted - mute state
 */
export async function updateBusSend(
  sourceType: 'input' | 'bus',
  sourceId: string,
  sourceDevice: number,
  sourceChannel: number,
  targetType: 'bus' | 'output',
  targetId: string,
  targetChannel: number,
  level: number,
  muted: boolean
): Promise<void> {
  return invoke('update_bus_send', {
    sourceType,
    sourceId,
    sourceDevice,
    sourceChannel,
    targetType,
    targetId,
    targetChannel,
    level,
    muted,
  });
}

/**
 * Remove a bus send
 */
export async function removeBusSend(
  sourceType: 'input' | 'bus',
  sourceId: string,
  sourceDevice: number,
  sourceChannel: number,
  targetType: 'bus' | 'output',
  targetId: string,
  targetChannel: number
): Promise<void> {
  return invoke('remove_bus_send', {
    sourceType,
    sourceId,
    sourceDevice,
    sourceChannel,
    targetType,
    targetId,
    targetChannel,
  });
}
