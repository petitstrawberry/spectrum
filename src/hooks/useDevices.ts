/**
 * useDevices - Device enumeration hook for Spectrum v2
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getInputDevices,
  getOutputDevices,
  getPrismStatus,
} from '../lib/api';
import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Types
// =============================================================================

export interface InputDevice {
  id: string;
  deviceId: number;
  name: string;
  channelCount: number;
  isPrism: boolean;
  transportType: string;
}

export interface OutputDevice {
  id: string;
  deviceId: number;
  name: string;
  channelCount: number;
  iconName?: string;
  transportType: string;
  isAggregate: boolean;
  subDevices: SubDevice[];
}

export interface VirtualOutputDevice {
  id: string; // vout_{deviceId}_{channelOffset}
  parentDeviceId: number;
  name: string;
  channelOffset: number;
  channels: number;
  iconHint?: string;
}

export interface SubDevice {
  id: string;
  name: string;
  channelCount: number;
  iconName?: string;
}

export interface PrismApp {
  pid: number;
  name: string;
  channelOffset: number;
}

export interface PrismStatus {
  connected: boolean;
  channels: number;
  apps: PrismApp[];
}

// =============================================================================
// Hook
// =============================================================================

export interface UseDevicesOptions {
  /** Polling interval in ms (default: 2000) */
  pollInterval?: number;
}

export interface UseDevicesReturn {
  inputDevices: InputDevice[];
  // physical devices (includes aggregate devices)
  outputDevices: OutputDevice[];
  // virtual devices derived from aggregates (vout_{device}_{offset})
  virtualOutputDevices: VirtualOutputDevice[];
  prismStatus: PrismStatus;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;

  // Input capture controls
  startCapture: (deviceId: number) => Promise<boolean>;
  stopCapture: (deviceId: number) => Promise<void>;
  activeCaptures: number[];

  // Output controls
  startOutput: (deviceId: number) => Promise<void>;
  stopOutput: (deviceId: number) => Promise<void>;
  activeOutputs: number[];
}

export function useDevices(options: UseDevicesOptions = {}): UseDevicesReturn {
  const { pollInterval = 2000 } = options;

  const [inputDevices, setInputDevices] = useState<InputDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<OutputDevice[]>([]);
  const [virtualOutputDevices, setVirtualOutputDevices] = useState<VirtualOutputDevice[]>([]);
  const [prismStatus, setPrismStatus] = useState<PrismStatus>({
    connected: false,
    channels: 0,
    apps: [],
  });
  const [activeCaptures, setActiveCaptures] = useState<number[]>([]);
  const [activeOutputs, setActiveOutputs] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [inputs, outputs, prism] = await Promise.all([
        getInputDevices(),
        getOutputDevices(),
        getPrismStatus(),
      ]);

      setInputDevices(inputs.map(d => ({
        id: d.id,
        deviceId: d.device_id,
        name: d.name,
        channelCount: d.channel_count,
        isPrism: d.is_prism,
        transportType: d.transport_type,
      })));

      // DEBUG: log raw output DTOs to help diagnose naming issues
      try {
        // eslint-disable-next-line no-console
        console.debug('useDevices: raw outputs:', outputs);
      } catch (e) {}

      // Backend currently returns only virtual entries (id like "vout_{device}_{offset}").
      // Group virtual entries by parent device_id to synthesize physical device list.
      const virtuals: VirtualOutputDevice[] = [];
      const groups = new Map<number, VirtualOutputDevice[]>();

      for (const d of outputs) {
        const rawId = (d as any).id ?? '';
        if (typeof rawId === 'string' && rawId.startsWith('vout_')) {
          const m = rawId.match(/^vout_(\d+)_(\d+)$/);
          if (!m) continue;
          const parentId = Number(m[1]);
          const offset = Number(m[2]);
          const name = (d as any).name ?? (d as any).label ?? rawId;
          const channels = (d as any).channel_count ?? (d as any).channelCount ?? (d as any).output_channels ?? 2;
          const icon = (d as any).icon_hint ?? undefined;
          const v: VirtualOutputDevice = { id: rawId, parentDeviceId: parentId, name, channelOffset: offset, channels, iconHint: icon };
          virtuals.push(v);
          const arr = groups.get(parentId) ?? [];
          arr.push(v);
          groups.set(parentId, arr);
        }
      }

      const phys: OutputDevice[] = [];
      for (const [deviceId, vs] of groups.entries()) {
        // Prefer the vout with offset 0 for base name and channel count if present
        const zero = vs.find(x => x.channelOffset === 0);
        // Prefer aggregate (parent) name if backend provided it
        const parentEntry = vs.find(x => (outputs.find((o: any) => o.id === x.id) || {}).parent_name);
        let baseName = parentEntry ? ((outputs.find((o: any) => o.id === parentEntry.id) as any).parent_name) : (zero ? zero.name : vs[0].name);
        // If baseName includes " (Ch X-Y)", strip it
        baseName = baseName.replace(/\s*\(Ch\s*\d+-?\d*\)$/, '').trim();
        const totalChannels = vs.reduce((s, x) => s + x.channels, 0);
        const isAggregate = vs.length > 1 || vs.some(x => /(aggregate|aggregate_sub)/i.test((x as any).id));

        // Choose an iconHint from parentEntry, else zero, else first
        const iconHintSource = parentEntry ? (outputs.find((o: any) => o.id === parentEntry.id) as any).icon_hint : (zero ? zero.iconHint : vs[0].iconHint);
        const subDevices: SubDevice[] = vs.map(v => ({
          id: v.id,
          name: v.name,
          channelCount: v.channels,
          iconName: v.iconHint,
        }));

        phys.push({
          id: `device_${deviceId}`,
          deviceId,
          name: baseName || `Device ${deviceId}`,
          channelCount: totalChannels,
          transportType: 'Unknown',
          iconName: iconHintSource,
          isAggregate,
          subDevices,
        });
      }

      setOutputDevices(phys);
      setVirtualOutputDevices(virtuals);

      setPrismStatus({
        connected: prism.connected,
        channels: prism.channels,
        apps: prism.apps.map(a => ({
          pid: a.pid,
          name: a.name,
          channelOffset: a.channel_offset,
        })),
      });
      // DEBUG: Log prism apps so we can verify which app is assigned to which channel
      try {
        // eslint-disable-next-line no-console
        console.log('useDevices: prism.apps:', prism.apps);
      } catch (e) {
        // ignore
      }

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch devices');
    }
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await refresh();
      setIsLoading(false);
    };
    init();

    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  // Capture controls (using legacy commands for now)
  const startCapture = useCallback(async (deviceId: number): Promise<boolean> => {
    try {
      const result = await invoke<boolean>('start_input_capture', { deviceId });
      if (result) {
        setActiveCaptures(prev => [...prev.filter(id => id !== deviceId), deviceId]);
      }
      return result;
    } catch (e) {
      console.error('Failed to start capture:', e);
      return false;
    }
  }, []);

  const stopCapture = useCallback(async (deviceId: number): Promise<void> => {
    try {
      await invoke('stop_input_capture', { deviceId });
      setActiveCaptures(prev => prev.filter(id => id !== deviceId));
    } catch (e) {
      console.error('Failed to stop capture:', e);
    }
  }, []);

  // Output controls
  const startOutput = useCallback(async (deviceId: number): Promise<void> => {
    try {
      await invoke('start_audio');
      setActiveOutputs(prev => [...prev.filter(id => id !== deviceId), deviceId]);
    } catch (e) {
      console.error('Failed to start output:', e);
    }
  }, []);

  const stopOutput = useCallback(async (deviceId: number): Promise<void> => {
    try {
      await invoke('stop_audio');
      setActiveOutputs(prev => prev.filter(id => id !== deviceId));
    } catch (e) {
      console.error('Failed to stop output:', e);
    }
  }, []);

  return {
    inputDevices,
    outputDevices,
    virtualOutputDevices,
    prismStatus,
    isLoading,
    error,
    refresh,
    startCapture,
    stopCapture,
    activeCaptures,
    startOutput,
    stopOutput,
    activeOutputs,
  };
}
