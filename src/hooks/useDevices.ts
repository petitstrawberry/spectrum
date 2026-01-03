/**
 * useDevices - Device enumeration hook for Spectrum v2
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  getInputDevices,
  getOutputDevices,
  getPrismStatus,
  getOutputRuntime,
} from '../lib/api';
// NOTE: Avoid top-level import of Tauri invoke.
// Opening the Vite dev server in a normal browser can crash module init otherwise.
type Invoke = <T>(cmd: string, args?: Record<string, any>) => Promise<T>;
let _invokePromise: Promise<Invoke> | null = null;

const invoke: Invoke = (cmd, args) => {
  if (!_invokePromise) {
    _invokePromise = import('@tauri-apps/api/core')
      .then((m) => m.invoke as unknown as Invoke);
  }

  return _invokePromise.then((fn) => fn(cmd, args));
};

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
  transportType?: string;
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

  // Use ref to access latest activeOutputs without causing callback recreations
  const activeOutputsRef = useRef<number[]>([]);
  activeOutputsRef.current = activeOutputs;

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
          // Support both old format (vout_{device}_{offset}) and new format (vout_{device}_{offset}_{uid_hash})
          const m = rawId.match(/^vout_(\d+)_(\d+)(?:_([a-f0-9]+))?$/);
          if (!m) continue;
          const parentId = Number(m[1]);
          const offset = Number(m[2]);
          // m[3] would be the uid_hash if present (we don't need it here)
          const name = (d as any).name ?? (d as any).label ?? rawId;
          const channels = (d as any).channel_count ?? (d as any).channelCount ?? (d as any).output_channels ?? 2;
          const icon = (d as any).icon_hint ?? undefined;
          const transport = (d as any).transport_type ?? undefined;
          const v: VirtualOutputDevice = { id: rawId, parentDeviceId: parentId, name, channelOffset: offset, channels, iconHint: icon, transportType: transport };
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
        const parentOutput = parentEntry ? (outputs.find((o: any) => o.id === parentEntry.id) as any) : undefined;
        const iconHintSource = parentOutput ? parentOutput.icon_hint : (zero ? zero.iconHint : vs[0].iconHint);
        const transportSource = parentOutput ? parentOutput.transport_type : (zero ? zero.transportType : vs[0].transportType) || 'unknown';
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
          transportType: transportSource,
          iconName: iconHintSource,
          isAggregate,
          subDevices,
        });
      }

      setOutputDevices(phys);
      setVirtualOutputDevices(virtuals);

      // Query backend for the currently active physical output runtime (if any)
      try {
        const active = await getOutputRuntime();
        if (typeof active === 'number' && !Number.isNaN(active)) {
          setActiveOutputs([active]);
        } else {
          setActiveOutputs([]);
        }
      } catch (e) {
        // ignore; keep existing activeOutputs
      }

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
      // Skip if already active to avoid repeated starts
      if (activeOutputsRef.current.includes(deviceId)) {
        console.debug('useDevices.startOutput: skipping start, already active', deviceId);
        return;
      }
      await invoke('start_audio', { deviceId });
      setActiveOutputs(prev => [...prev.filter(id => id !== deviceId), deviceId]);
    } catch (e) {
      console.error('Failed to start output:', e);
    }
  }, []);

  const stopOutput = useCallback(async (deviceId: number): Promise<void> => {
    try {
      // Skip if not active
      if (!activeOutputsRef.current.includes(deviceId)) {
        console.debug('useDevices.stopOutput: skipping stop, not active', deviceId);
        return;
      }
      await invoke('stop_output_runtime');
      setActiveOutputs(prev => prev.filter(id => id !== deviceId));
    } catch (e) {
      console.error('Failed to stop output:', e);
    }
  }, []);

  // Memoize return value to prevent unnecessary re-renders
  return useMemo(() => ({
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
  }), [
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
  ]);
}
