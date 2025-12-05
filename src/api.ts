import { invoke } from '@tauri-apps/api/core';

// --- Types ---

export type NodeType = 'source' | 'target';

export interface AudioDevice {
  id: string;
  name: string;
  channels: number;
  isInput: boolean;
  isOutput: boolean;
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
