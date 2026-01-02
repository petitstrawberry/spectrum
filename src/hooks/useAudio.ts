/**
 * useAudio - Audio system control hook for Spectrum v2
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  startAudio,
  stopAudio,
  getSystemStatus,
} from '../lib/api';

// =============================================================================
// Types
// =============================================================================

export interface SystemStatus {
  isRunning: boolean;
  sampleRate: number;
  bufferSize: number;
  cpuLoad: number;
}

// =============================================================================
// Hook
// =============================================================================

export interface UseAudioOptions {
  /** Polling interval in ms (default: 1000) */
  statusPollInterval?: number;
}

export interface UseAudioReturn {
  status: SystemStatus;
  isRunning: boolean;
  isLoading: boolean;
  error: string | null;

  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  toggle: () => Promise<boolean>;

  refresh: () => Promise<void>;
}

export function useAudio(options: UseAudioOptions = {}): UseAudioReturn {
  const { statusPollInterval = 1000 } = options;

  const [status, setStatus] = useState<SystemStatus>({
    isRunning: false,
    sampleRate: 48000,
    bufferSize: 512,
    cpuLoad: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isTransitioning = useRef(false);

  const refresh = useCallback(async () => {
    if (isTransitioning.current) return;

    try {
      const s = await getSystemStatus();
      setStatus({
        isRunning: s.audio_running,
        sampleRate: s.sample_rate,
        bufferSize: s.buffer_size,
        cpuLoad: s.cpu_load,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get system status');
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

    const interval = setInterval(refresh, statusPollInterval);
    return () => clearInterval(interval);
  }, [refresh, statusPollInterval]);

  const start = useCallback(async (): Promise<boolean> => {
    try {
      isTransitioning.current = true;
      await startAudio(0);
      setStatus(prev => ({ ...prev, isRunning: true }));
      isTransitioning.current = false;
      return true;
    } catch (e) {
      isTransitioning.current = false;
      setError(e instanceof Error ? e.message : 'Failed to start audio');
      return false;
    }
  }, []);

  const stop = useCallback(async (): Promise<boolean> => {
    try {
      isTransitioning.current = true;
      await stopAudio();
      setStatus(prev => ({ ...prev, isRunning: false }));
      isTransitioning.current = false;
      return true;
    } catch (e) {
      isTransitioning.current = false;
      setError(e instanceof Error ? e.message : 'Failed to stop audio');
      return false;
    }
  }, []);

  const toggle = useCallback(async (): Promise<boolean> => {
    if (status.isRunning) {
      return stop();
    } else {
      return start();
    }
  }, [status.isRunning, start, stop]);

  return {
    status,
    isRunning: status.isRunning,
    isLoading,
    error,
    start,
    stop,
    toggle,
    refresh,
  };
}
