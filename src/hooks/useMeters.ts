/**
 * useMeters - Meter polling hook for Spectrum v2
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { getMeters } from '../lib/api';

// =============================================================================
// Helpers
// =============================================================================

/** Convert RMS/Peak to dB */
export function levelToDb(level: number): number {
  if (level <= 0.00001) return -60;
  return Math.max(-60, Math.min(6, 20 * Math.log10(level)));
}

/** Convert dB to meter percentage (0-100) */
export function dbToMeterPercent(db: number): number {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;

  const m = -db;
  if (m <= 3) return 93.3 + ((3 - m) / 3) * 6.7;
  if (m <= 6) return 86.6 + ((6 - m) / 3) * 6.7;
  if (m <= 9) return 79.9 + ((9 - m) / 3) * 6.7;
  if (m <= 12) return 73.5 + ((12 - m) / 3) * 6.4;
  if (m <= 15) return 66.8 + ((15 - m) / 3) * 6.7;
  if (m <= 18) return 60.1 + ((18 - m) / 3) * 6.7;
  if (m <= 21) return 53.4 + ((21 - m) / 3) * 6.7;
  if (m <= 24) return 46.6 + ((24 - m) / 3) * 6.8;
  if (m <= 30) return 37.7 + ((30 - m) / 6) * 8.9;
  if (m <= 35) return 30.2 + ((35 - m) / 5) * 7.5;
  if (m <= 40) return 23.1 + ((40 - m) / 5) * 7.1;
  if (m <= 45) return 15.7 + ((45 - m) / 5) * 7.4;
  if (m <= 50) return 8.2 + ((50 - m) / 5) * 7.5;
  return ((60 - m) / 10) * 8.2;
}

// =============================================================================
// Types
// =============================================================================

export interface NodeMeter {
  handle: number;
  inputPeaks: number[];
  inputRms: number[];
  outputPeaks: number[];
  outputRms: number[];
}

/** Alias for NodeMeter for backward compatibility */
export type MeterData = NodeMeter;

export interface EdgeMeter {
  edgeId: number;
  peak: number;
  rms: number;
}

export interface MeterState {
  nodes: Map<number, NodeMeter>;
  edges: Map<number, EdgeMeter>;
  timestamp: number;
}

// =============================================================================
// Hook
// =============================================================================

export interface UseMetersOptions {
  /** Polling interval in ms (default: 33 = ~30fps) */
  interval?: number;
  /** Whether to poll (default: true) */
  enabled?: boolean;
}

export interface UseMetersReturn {
  meters: MeterState;
  getNodeMeter: (handle: number) => NodeMeter | undefined;
  getEdgeMeter: (edgeId: number) => EdgeMeter | undefined;
  /** Get peak dB for a node (max of all outputs) */
  getNodePeakDb: (handle: number) => number;
  /** Get peak dB for an edge */
  getEdgePeakDb: (edgeId: number) => number;
}

export function useMeters(options: UseMetersOptions = {}): UseMetersReturn {
  const { interval = 33, enabled = true } = options;

  const [meters, setMeters] = useState<MeterState>({
    nodes: new Map(),
    edges: new Map(),
    timestamp: 0,
  });

  const isFetchingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let animationFrame: number;
    let lastFetchTime = 0;

    const poll = async (currentTime: number) => {
      // Throttle fetching
      if (currentTime - lastFetchTime >= interval && !isFetchingRef.current) {
        lastFetchTime = currentTime;
        isFetchingRef.current = true;

        try {
          const data = await getMeters();

          const nodeMap = new Map<number, NodeMeter>();
          for (const nm of data.nodes) {
            nodeMap.set(nm.handle, {
              handle: nm.handle,
              inputPeaks: nm.inputs.map(p => p.peak),
              inputRms: nm.inputs.map(p => p.rms),
              outputPeaks: nm.outputs.map(p => p.peak),
              outputRms: nm.outputs.map(p => p.rms),
            });
          }

          const edgeMap = new Map<number, EdgeMeter>();
          for (const em of data.edges) {
            edgeMap.set(em.edge_id, {
              edgeId: em.edge_id,
              peak: em.post_gain.peak,
              rms: em.post_gain.rms,
            });
          }

          setMeters({
            nodes: nodeMap,
            edges: edgeMap,
            timestamp: Date.now(),
          });
        } catch (e) {
          // Ignore fetch errors
        } finally {
          isFetchingRef.current = false;
        }
      }

      animationFrame = requestAnimationFrame(poll);
    };

    animationFrame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(animationFrame);
  }, [enabled, interval]);

  const getNodeMeter = useCallback((handle: number): NodeMeter | undefined => {
    return meters.nodes.get(handle);
  }, [meters.nodes]);

  const getEdgeMeter = useCallback((edgeId: number): EdgeMeter | undefined => {
    return meters.edges.get(edgeId);
  }, [meters.edges]);

  const getNodePeakDb = useCallback((handle: number): number => {
    const m = meters.nodes.get(handle);
    if (!m) return -60;
    const maxPeak = Math.max(...m.outputPeaks, 0);
    return levelToDb(maxPeak);
  }, [meters.nodes]);

  const getEdgePeakDb = useCallback((edgeId: number): number => {
    const m = meters.edges.get(edgeId);
    if (!m) return -60;
    return levelToDb(m.peak);
  }, [meters.edges]);

  return {
    meters,
    getNodeMeter,
    getEdgeMeter,
    getNodePeakDb,
    getEdgePeakDb,
  };
}
