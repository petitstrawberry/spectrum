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
 * Update a send connection
 */
export async function updateMixerSend(
  sourceOffset: number,
  targetDevice: string,
  targetPair: number,
  level: number,
  muted: boolean
): Promise<void> {
  return invoke('update_mixer_send', {
    sourceOffset,
    targetDevice,
    targetPair,
    level,
    muted,
  });
}

/**
 * Remove a send connection
 */
export async function removeMixerSend(
  sourceOffset: number,
  targetDevice: string,
  targetPair: number
): Promise<void> {
  return invoke('remove_mixer_send', {
    sourceOffset,
    targetDevice,
    targetPair,
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

export interface AppState {
  io_buffer_size: number;
  output_routings: Record<string, OutputRoutingInfo>;
  active_outputs: string[];
  master_gain: number;
  master_muted: boolean;
  patch_scroll_x: number;
  patch_scroll_y: number;
  patch_zoom: number;
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
