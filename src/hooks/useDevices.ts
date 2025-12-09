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
  transportType: string;
  isAggregate: boolean;
  subDevices: SubDevice[];
}

export interface SubDevice {
  id: string;
  name: string;
  channelCount: number;
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
  outputDevices: OutputDevice[];
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
}

export function useDevices(options: UseDevicesOptions = {}): UseDevicesReturn {
  const { pollInterval = 2000 } = options;

  const [inputDevices, setInputDevices] = useState<InputDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<OutputDevice[]>([]);
  const [prismStatus, setPrismStatus] = useState<PrismStatus>({
    connected: false,
    channels: 0,
    apps: [],
  });
  const [activeCaptures, setActiveCaptures] = useState<number[]>([]);
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

      setOutputDevices(outputs.map(d => ({
        id: d.id,
        deviceId: d.device_id,
        name: d.name,
        channelCount: d.channel_count,
        transportType: d.transport_type,
        isAggregate: d.is_aggregate,
        subDevices: d.sub_devices.map(s => ({
          id: s.id,
          name: s.name,
          channelCount: s.channel_count,
        })),
      })));

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
      await invoke('start_audio_output', { deviceId });
    } catch (e) {
      console.error('Failed to start output:', e);
    }
  }, []);

  const stopOutput = useCallback(async (deviceId: number): Promise<void> => {
    try {
      await invoke('stop_audio_output', { deviceId });
    } catch (e) {
      console.error('Failed to stop output:', e);
    }
  }, []);

  return {
    inputDevices,
    outputDevices,
    prismStatus,
    isLoading,
    error,
    refresh,
    startCapture,
    stopCapture,
    activeCaptures,
    startOutput,
    stopOutput,
  };
}
