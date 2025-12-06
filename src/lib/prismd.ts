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
