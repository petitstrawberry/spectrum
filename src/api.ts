import { invoke } from '@tauri-apps/api/core';

// --- Types ---

export type NodeType = 'source' | 'target';

export interface AudioDevice {
  id: string;
  name: string;
  channels: number;
  is_input: boolean;
  is_output: boolean;
  device_type?: string;
  input_channels?: number;
  output_channels?: number;
  transport_type?: string;  // "builtin", "usb", "bluetooth", "hdmi", "displayport", "airplay", "thunderbolt", etc.
}

export interface PrismClient {
  pid: number;
  clientId: number;
  channelOffset: number;
  processName?: string;
  responsiblePid?: number;
  responsibleName?: string;
}

export interface NodeData {
  id: string;
  libraryId: string;
  type: NodeType;
  label: string;
  subLabel?: string;
  icon: string; // Icon name as string for serialization
  color: string;
  x: number;
  y: number;
  volume: number;
  muted: boolean;
  peaks: number[];
  channelCount: number;
}

export interface Connection {
  id: string;
  fromNodeId: string;
  fromChannel: number;
  toNodeId: string;
  toChannel: number;
  sendLevel: number;
  muted: boolean;
}

export interface DriverStatus {
  connected: boolean;
  sampleRate: number;
  bufferSize: number;
}

// --- API Functions ---

export async function getPrismClients(): Promise<PrismClient[]> {
  try {
    return await invoke<PrismClient[]>('get_prism_clients');
  } catch (error) {
    console.error('Failed to get Prism clients:', error);
    return [];
  }
}

export async function getAudioDevices(): Promise<AudioDevice[]> {
  try {
    return await invoke<AudioDevice[]>('get_audio_devices');
  } catch (error) {
    console.error('Failed to get audio devices:', error);
    return [];
  }
}

export async function getDriverStatus(): Promise<DriverStatus> {
  try {
    return await invoke<DriverStatus>('get_driver_status');
  } catch (error) {
    console.error('Failed to get driver status:', error);
    return {
      connected: false,
      sampleRate: 48000,
      bufferSize: 128,
    };
  }
}

export async function getAudioLevels(deviceId: string): Promise<number[]> {
  try {
    return await invoke<number[]>('get_audio_levels', { deviceId });
  } catch (error) {
    console.error('Failed to get audio levels:', error);
    return [];
  }
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

export async function addBus(id: string, label: string, channels: number): Promise<void> {
  try {
    await invoke('add_bus', { id, label, channels });
    console.log(`[API] Added bus: ${id} (${label})`);
  } catch (error) {
    console.error('Failed to add bus:', error);
    throw error;
  }
}

export async function removeBus(busId: string): Promise<void> {
  try {
    await invoke('remove_bus', { busId });
    console.log(`[API] Removed bus: ${busId}`);
  } catch (error) {
    console.error('Failed to remove bus:', error);
    throw error;
  }
}

export async function setBusFader(busId: string, level: number): Promise<void> {
  try {
    await invoke('set_bus_fader', { busId, level });
  } catch (error) {
    console.error('Failed to set bus fader:', error);
    throw error;
  }
}

export async function setBusMute(busId: string, muted: boolean): Promise<void> {
  try {
    await invoke('set_bus_mute', { busId, muted });
  } catch (error) {
    console.error('Failed to set bus mute:', error);
    throw error;
  }
}

export async function getBuses(): Promise<BusInfo[]> {
  try {
    return await invoke<BusInfo[]>('get_buses');
  } catch (error) {
    console.error('Failed to get buses:', error);
    return [];
  }
}

export interface BusLevelInfo {
  id: string;
  left_rms: number;
  right_rms: number;
  left_peak: number;
  right_peak: number;
}

export async function getBusLevels(): Promise<BusLevelInfo[]> {
  try {
    return await invoke<BusLevelInfo[]>('get_bus_levels');
  } catch (error) {
    console.error('Failed to get bus levels:', error);
    return [];
  }
}

export async function reserveBusId(): Promise<string | null> {
  try {
    return await invoke<string | null>('reserve_bus_id');
  } catch (error) {
    console.error('Failed to reserve bus id:', error);
    return null;
  }
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
  try {
    await invoke('update_bus_send', {
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
    console.log(`[API] Bus send: ${sourceType}:${sourceId}[${sourceChannel}] -> ${targetType}:${targetId}[${targetChannel}] level=${level}`);
  } catch (error) {
    console.error('Failed to update bus send:', error);
    throw error;
  }
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
  try {
    await invoke('remove_bus_send', {
      sourceType,
      sourceId,
      sourceDevice,
      sourceChannel,
      targetType,
      targetId,
      targetChannel,
    });
    console.log(`[API] Removed bus send: ${sourceType}:${sourceId}[${sourceChannel}] -> ${targetType}:${targetId}[${targetChannel}]`);
  } catch (error) {
    console.error('Failed to remove bus send:', error);
    throw error;
  }
}

// --- AudioUnit State API Functions ---

/**
 * Get the plugin state for saving (base64 encoded plist data)
 */
export async function getAudioUnitState(instanceId: string): Promise<string | null> {
  try {
    return await invoke<string | null>('get_audio_unit_state', { instanceId });
  } catch (error) {
    console.error('Failed to get AudioUnit state:', error);
    return null;
  }
}

/**
 * Set the plugin state for restoring (base64 encoded plist data)
 */
export async function setAudioUnitState(instanceId: string, state: string): Promise<boolean> {
  try {
    return await invoke<boolean>('set_audio_unit_state', { instanceId, state });
  } catch (error) {
    console.error('Failed to set AudioUnit state:', error);
    return false;
  }
}

/**
 * Clear all mixer sends (direct and bus sends)
 */
export async function clearAllMixerSends(): Promise<void> {
  try {
    await invoke('clear_all_mixer_sends');
    console.log('[API] Cleared all mixer sends');
  } catch (error) {
    console.error('Failed to clear all mixer sends:', error);
    throw error;
  }
}
