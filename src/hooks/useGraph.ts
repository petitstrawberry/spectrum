/**
 * useGraph - Graph state management hook for Spectrum v2
 *
 * Pure Sends-on-Fader architecture
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  addSourceNode,
  addBusNode,
  addSinkNode,
  removeNode,
  addEdge,
  removeEdge,
  getGraph,
  setEdgeGain,
  setEdgeMuted,
  persistState,
  restoreState,
  setUiStateCache,
  type SourceIdDto,
  type OutputSinkDto,
  type NodeInfoDto,
  type EdgeInfoDto,
  type UIStateDto,
} from '../lib/api';
import type { UINode, UIEdge } from '../types/graph';
import {
  Volume2,
  Mic,
  Headphones,
  Speaker,
  Radio,
  Monitor,
  Music,
  Workflow,
  Cast,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// =============================================================================
// Helper Functions
// =============================================================================

/** Convert dB to linear gain */
export function dbToGain(db: number): number {
  if (db <= -100) return 0;
  return Math.pow(10, db / 20);
}

/** Convert linear gain to dB */
export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

/** Logic Pro X style fader scale: fader (0-100) to dB */
export function faderToDb(faderValue: number): number {
  if (faderValue <= 0) return -Infinity;
  if (faderValue >= 100) return 6;

  if (faderValue >= 86.9) return 3 + ((faderValue - 86.9) / 13.1) * 3;
  if (faderValue >= 74.3) return 0 + ((faderValue - 74.3) / 12.6) * 3;
  if (faderValue >= 61.2) return -3 + ((faderValue - 61.2) / 13.1) * 3;
  if (faderValue >= 48.5) return -6 + ((faderValue - 48.5) / 12.7) * 3;
  if (faderValue >= 39.9) return -10 + ((faderValue - 39.9) / 8.6) * 4;
  if (faderValue >= 29.1) return -15 + ((faderValue - 29.1) / 10.8) * 5;
  if (faderValue >= 20.9) return -20 + ((faderValue - 20.9) / 8.2) * 5;
  if (faderValue >= 12.3) return -30 + ((faderValue - 12.3) / 8.6) * 10;
  if (faderValue >= 8.2) return -40 + ((faderValue - 8.2) / 4.1) * 10;
  return -40 - (60 * (1 - faderValue / 8.2));
}

/** Logic Pro X style fader scale: dB to fader (0-100) */
export function dbToFader(db: number): number {
  if (!isFinite(db) || db <= -100) return 0;
  if (db >= 6) return 100;

  if (db >= 3) return 86.9 + ((db - 3) / 3) * 13.1;
  if (db >= 0) return 74.3 + (db / 3) * 12.6;
  if (db >= -3) return 61.2 + ((db + 3) / 3) * 13.1;
  if (db >= -6) return 48.5 + ((db + 6) / 3) * 12.7;
  if (db >= -10) return 39.9 + ((db + 10) / 4) * 8.6;
  if (db >= -15) return 29.1 + ((db + 15) / 5) * 10.8;
  if (db >= -20) return 20.9 + ((db + 20) / 5) * 8.2;
  if (db >= -30) return 12.3 + ((db + 30) / 10) * 8.6;
  if (db >= -40) return 8.2 + ((db + 40) / 10) * 4.1;
  return Math.max(0, 8.2 * (1 + (db + 40) / 60));
}

// =============================================================================
// Icon/Color Helpers
// =============================================================================

const BUS_COLORS = [
  'text-purple-400', 'text-violet-400', 'text-indigo-400', 'text-blue-400',
  'text-teal-400', 'text-emerald-400', 'text-lime-400', 'text-yellow-400',
];

function getIconForSourceType(sourceType: 'prism' | 'device'): LucideIcon {
  return sourceType === 'prism' ? Volume2 : Mic;
}

function getColorForSourceType(sourceType: 'prism' | 'device'): string {
  return sourceType === 'prism' ? 'text-cyan-400' : 'text-amber-400';
}

function getIconForSink(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (lower.includes('headphone') || lower.includes('airpods')) return Headphones;
  if (lower.includes('speaker') || lower.includes('built-in')) return Speaker;
  if (lower.includes('monitor') || lower.includes('display')) return Monitor;
  if (lower.includes('blackhole') || lower.includes('virtual')) return Radio;
  if (lower.includes('airplay')) return Cast;
  if (lower.includes('obs') || lower.includes('stream')) return Video;
  return Volume2;
}

function getColorForSink(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('prism')) return 'text-cyan-400';
  if (lower.includes('virtual') || lower.includes('blackhole')) return 'text-pink-400';
  if (lower.includes('built-in')) return 'text-green-400';
  return 'text-amber-400';
}

// =============================================================================
// Node Conversion
// =============================================================================

function nodeInfoToUINode(info: NodeInfoDto, position: { x: number; y: number }): UINode {
  switch (info.type) {
    case 'source': {
      const src: any = info.source_id as any;
      // Normalize variant names (accept prism/prism_channel/prism-channel and device/input_device variants)
      const rawType = (src && src.type) ? String(src.type).toLowerCase() : '';
      const isPrism = rawType.includes('prism');
      const isDevice = !isPrism && (rawType.includes('device') || rawType.includes('input'));

      // Extract channel/channel_offset from multiple possible field names
      const channelRaw = (src && (src.channel ?? src.channel_offset ?? src.channelOffset ?? src.stereo_pair ?? src.stereoPair ?? src.index));
      const channel = typeof channelRaw === 'number' ? channelRaw : undefined;
      // Derive stereo-pair index from raw channel info when possible. Backend may supply
      // either an absolute channel offset (0..N) or a stereo-pair index (0..31).
      let stereoPairIndex: number | undefined = undefined;
      if (typeof channelRaw === 'number') {
        // If field name explicitly suggests stereo pair, prefer it
        if (typeof (src && (src.stereo_pair ?? src.stereoPair)) === 'number') {
          stereoPairIndex = src.stereo_pair ?? src.stereoPair;
        } else if (typeof (src && (src.channel_offset ?? src.channelOffset)) === 'number' && String(src.channel_offset ?? src.channelOffset).indexOf('.') === -1) {
          // channel_offset might be absolute; still compute pair index
          stereoPairIndex = Math.floor(channelRaw / 2);
        } else {
          // Fallback: compute pair index from absolute channel
          stereoPairIndex = Math.floor(channelRaw / 2);
        }
      }

      // Extract device id only for explicit device-type sources
      const deviceId = isDevice ? (src.device_id ?? src.deviceId ?? src.device ?? undefined) : undefined;

      const sourceType: 'prism' | 'device' = isPrism ? 'prism' : (isDevice ? 'device' : 'prism');

      // MAIN detection: prefer explicit flag, then stereo-pair/index == 0, then absolute channel === 0, then label match
      const isMain = isPrism && (
        src.is_main === true ||
        stereoPairIndex === 0 ||
        channel === 0 ||
        (!!info.label && String(info.label).toLowerCase().includes('main'))
      );

      // MAIN detection already includes stereoPairIndex/channel==0; use `isMain` directly
      const icon = isMain ? Music : getIconForSourceType(sourceType);
      const color = isMain ? 'text-cyan-400' : getColorForSourceType(sourceType);

      // Build sensible subLabel: MAIN for main, otherwise Prism Ch <n> or Device <id>
      const dtoSubLabelRaw = (info as any).sub_label ?? (info as any).subLabel;

      let subLabel: string;
      if (typeof dtoSubLabelRaw === 'string' && dtoSubLabelRaw.trim() !== '') {
        subLabel = dtoSubLabelRaw;
      } else if (isMain) {
        subLabel = 'MAIN';
      } else if (sourceType === 'prism') {
        subLabel = typeof channel === 'number' ? 'Empty' : (info.label || 'Prism');
      } else {
        subLabel = deviceId !== undefined ? `Device ${deviceId}` : (info.label || 'Device');
      }

      console.log('nodeInfoToUINode - source', { info, sourceType, deviceId, channel, stereoPairIndex, isMain, subLabel, color });

      return {
        handle: info.handle,
        type: 'source',
        label: info.label,
        subLabel,
        icon,
        iconColor: color, // デフォルトはcolorと同じ、後でchannelColorsで上書き可能
        color,
        x: position.x,
        y: position.y,
        portCount: info.port_count,
        sourceType,
        deviceId,
        channel,
      };
    }
    case 'bus': {
      const busNum = parseInt(info.bus_id.replace('bus_', ''), 10) || 1;
      const colorIndex = (busNum - 1) % BUS_COLORS.length;

      return {
        handle: info.handle,
        type: 'bus',
        label: info.label,
        subLabel: `${info.port_count}ch`,
        icon: Workflow,
        iconColor: BUS_COLORS[colorIndex],
        color: BUS_COLORS[colorIndex],
        x: position.x,
        y: position.y,
        portCount: info.port_count,
        busId: info.bus_id,
        plugins: info.plugins.map(p => ({
          instanceId: p.instance_id,
          pluginId: p.plugin_id,
          name: p.name,
          manufacturer: p.manufacturer,
          enabled: p.enabled,
        })),
      };
    }
    case 'sink': {
      const sinkColor = getColorForSink(info.label);
      return {
        handle: info.handle,
        type: 'sink',
        label: info.label,
        subLabel: `${info.port_count}ch`,
        icon: getIconForSink(info.label),
        iconColor: sinkColor,
        color: sinkColor,
        x: position.x,
        y: position.y,
        portCount: info.port_count,
        sinkDeviceId: info.sink.device_id,
        channelOffset: info.sink.channel_offset,
      };
    }
  }
}

function edgeInfoToUIEdge(info: EdgeInfoDto): UIEdge {
  return {
    id: info.id,
    sourceHandle: info.source,
    sourcePort: info.source_port,
    targetHandle: info.target,
    targetPort: info.target_port,
    gain: info.gain,
    muted: info.muted,
  };
}

function stableIdForSourceId(sourceId: SourceIdDto): string {
  const t = (sourceId as any)?.type;
  if (t === 'prism_channel') return `source:prism:${(sourceId as any).channel}`;
  if (t === 'input_device') return `source:device:${(sourceId as any).device_id}:${(sourceId as any).channel}`;
  // Fallback to backend variant names if they slip through
  if (t === 'prism') return `source:prism:${(sourceId as any).channel}`;
  if (t === 'device') return `source:device:${(sourceId as any).device_id}:${(sourceId as any).channel}`;
  return 'source:unknown';
}

function stableIdForSink(sink: OutputSinkDto): string {
  return `sink:${sink.device_id}:${sink.channel_offset}:${sink.channel_count}`;
}

function stableIdForNodeInfo(info: NodeInfoDto): string {
  const sid = (info as any).stable_id;
  if (typeof sid === 'string' && sid.trim() !== '') return sid;
  switch (info.type) {
    case 'source':
      return stableIdForSourceId((info as any).source_id);
    case 'bus':
      return `bus:${(info as any).bus_id}`;
    case 'sink':
      return stableIdForSink((info as any).sink);
  }
}

// =============================================================================
// useGraph Hook
// =============================================================================

export interface UseGraphOptions {
  autoRestore?: boolean;
}

export interface UseGraphReturn {
  // State
  nodes: Map<number, UINode>;
  edges: Map<number, UIEdge>;
  isLoading: boolean;
  error: string | null;

  // Node Operations
  addSource: (sourceId: SourceIdDto, label?: string, position?: { x: number; y: number }) => Promise<number>;
  addBus: (label?: string, portCount?: number, position?: { x: number; y: number }) => Promise<number>;
  addSink: (sink: OutputSinkDto, label?: string, position?: { x: number; y: number }) => Promise<number>;
  deleteNode: (handle: number) => Promise<void>;
  updateNodePosition: (handle: number, x: number, y: number) => void;

  // Edge Operations
  connect: (source: number, sourcePort: number, target: number, targetPort: number, gain?: number) => Promise<number>;
  disconnect: (edgeId: number) => Promise<void>;
  setGain: (edgeId: number, gain: number) => Promise<void>;
  setMuted: (edgeId: number, muted: boolean) => Promise<void>;

  // State
  refresh: () => Promise<void>;
  save: () => Promise<void>;

  // UI state helpers (canvas pan/zoom)
  initialCanvasTransform?: { x: number; y: number; scale: number } | null;
  updateCanvasTransform?: (t: { x: number; y: number; scale: number }) => void;

  // Helpers
  getNodeByHandle: (handle: number) => UINode | undefined;
  getEdgesForNode: (handle: number) => UIEdge[];
  getIncomingEdges: (handle: number) => UIEdge[];
  getOutgoingEdges: (handle: number) => UIEdge[];
}

export function useGraph(options: UseGraphOptions = {}): UseGraphReturn {
  const { autoRestore = true } = options;

  const isTauri = typeof window !== 'undefined'
    && ((window as any).__TAURI_INTERNALS__ != null || (window as any).__TAURI__ != null);

  // Some runtimes don't expose expected globals immediately; once any backend invoke succeeds
  // we can treat the environment as "Tauri available" for persistence/cache operations.
  const tauriAvailableRef = useRef(false);

  // Coalesce UI-state cache updates to avoid spamming invoke during gestures.
  // Ensures "latest wins" while allowing at most one in-flight invoke at a time.
  const uiStateCacheInFlightRef = useRef<Promise<void> | null>(null);
  const uiStateCachePendingRef = useRef<UIStateDto | null>(null);
  const uiStateCacheLastSentKeyRef = useRef<string | null>(null);

  const [nodes, setNodes] = useState<Map<number, UINode>>(new Map());
  const [edges, setEdges] = useState<Map<number, UIEdge>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initializedRef = useRef(false);
  const dirtyRef = useRef(false);
  const persistInFlightRef = useRef<Promise<void> | null>(null);
  const uiCacheTimerRef = useRef<number | null>(null);

  // Canvas pan/zoom state lives in SpectrumLayout, but we persist it here.
  const [initialCanvasTransform, setInitialCanvasTransform] = useState<{ x: number; y: number; scale: number } | null>(null);
  const canvasTransformRef = useRef<{ x: number; y: number; scale: number }>({ x: 0, y: 0, scale: 1 });

  // Position tracking (stable across sessions)
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Bridge for newly-created nodes / early events before stable_id is known
  const pendingPositionsByHandleRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const handleToStableIdRef = useRef<Map<number, string>>(new Map());
  const nextPositionRef = useRef({ x: 100, y: 100 });

  const buildUiState = useCallback((): UIStateDto => {
    const node_positions: Record<string, { x: number; y: number }> = {};
    for (const [stableId, pos] of positionsRef.current.entries()) {
      node_positions[stableId] = { x: pos.x, y: pos.y };
    }
    return {
      node_positions,
      canvas_transform: {
        x: canvasTransformRef.current.x,
        y: canvasTransformRef.current.y,
        scale: canvasTransformRef.current.scale,
      },
    };
  }, []);

  const pumpUiStateCache = useCallback((reason: string) => {
    if (!(isTauri || tauriAvailableRef.current)) return;
    if (uiStateCacheInFlightRef.current) return;

    const run = async () => {
      try {
        while (true) {
          const next = uiStateCachePendingRef.current;
          if (!next) break;
          uiStateCachePendingRef.current = null;

          const key = JSON.stringify(next);
          if (uiStateCacheLastSentKeyRef.current === key) {
            continue;
          }

          await setUiStateCache(next);
          uiStateCacheLastSentKeyRef.current = key;
          tauriAvailableRef.current = true;
        }
      } catch (e) {
        // Best-effort; keep pending state so a later call may retry.
        console.warn('[useGraph] setUiStateCache failed', { reason, e });
      } finally {
        uiStateCacheInFlightRef.current = null;
        // Handle race: a pending update may have been queued right as we were finishing.
        if (uiStateCachePendingRef.current) {
          pumpUiStateCache(reason);
        }
      }
    };

    uiStateCacheInFlightRef.current = run();
  }, [isTauri]);

  const queueUiStateCacheUpdate = useCallback((reason: string) => {
    if (!(isTauri || tauriAvailableRef.current)) return;
    uiStateCachePendingRef.current = buildUiState();
    pumpUiStateCache(reason);
  }, [buildUiState, isTauri, pumpUiStateCache]);

  const markDirty = useCallback((reason: string) => {
    dirtyRef.current = true;
    try {
      console.log('[useGraph] marked dirty', { reason });
    } catch {
      // ignore
    }

    // Keep backend UI-state cache fresh (no disk write). This enables saving only on "app exit" while still restoring latest UI.
    if (!(isTauri || tauriAvailableRef.current)) return;
    if (uiCacheTimerRef.current != null) {
      window.clearTimeout(uiCacheTimerRef.current);
      uiCacheTimerRef.current = null;
    }
    uiCacheTimerRef.current = window.setTimeout(() => {
      uiCacheTimerRef.current = null;
      queueUiStateCacheUpdate(reason);
    }, 1000);
  }, [isTauri, queueUiStateCacheUpdate]);

  const flushPersist = useCallback(async (opts?: { force?: boolean; reason?: string }): Promise<void> => {
    if (!(isTauri || tauriAvailableRef.current)) return;
    if (!initializedRef.current) return;
    if (isLoading) return;

    const force = opts?.force ?? false;
    const reason = opts?.reason ?? 'flush';

    if (!force && !dirtyRef.current) return;
    if (persistInFlightRef.current) return persistInFlightRef.current;

    // Clear dirty optimistically; if persist fails we set it back.
    dirtyRef.current = false;
    const p = persistState(buildUiState())
      .catch((e) => {
        dirtyRef.current = true;
        console.error('[useGraph] persist failed', { reason, e });
        throw e;
      })
      .finally(() => {
        persistInFlightRef.current = null;
      });

    persistInFlightRef.current = p;
    return p;
  }, [buildUiState, isLoading, isTauri]);

  // Auto-assign position for new nodes
  const getNextPosition = useCallback(() => {
    const pos = { ...nextPositionRef.current };
    nextPositionRef.current.x += 200;
    if (nextPositionRef.current.x > 800) {
      nextPositionRef.current.x = 100;
      nextPositionRef.current.y += 150;
    }
    return pos;
  }, []);

  // Refresh graph from backend
  const refresh = useCallback(async () => {
    try {
      const graphDto = await getGraph();
      tauriAvailableRef.current = true;

      const newNodes = new Map<number, UINode>();
      for (const info of graphDto.nodes) {
        const handle = 'handle' in info ? info.handle : 0;
        const stableId = stableIdForNodeInfo(info);
        handleToStableIdRef.current.set(handle, stableId);

        const stablePos = positionsRef.current.get(stableId);
        const pendingPos = pendingPositionsByHandleRef.current.get(handle);
        const position = stablePos || pendingPos || getNextPosition();

        if (!stablePos) {
          positionsRef.current.set(stableId, position);
        }
        if (pendingPos) {
          pendingPositionsByHandleRef.current.delete(handle);
        }
        newNodes.set(handle, nodeInfoToUINode(info, position));
      }

      const newEdges = new Map<number, UIEdge>();
      for (const info of graphDto.edges) {
        newEdges.set(info.id, edgeInfoToUIEdge(info));
      }

      setNodes(newNodes);
      setEdges(newEdges);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh graph');
    }
  }, [getNextPosition]);

  // Initialize
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      try {
        if (autoRestore) {
          // Best-effort: in web mode this will throw; we just skip restore.
          let uiState: UIStateDto | null = null;
          try {
            uiState = await restoreState();
            tauriAvailableRef.current = true;
          } catch {
            uiState = null;
          }
            if (uiState?.node_positions) {
              for (const [stableId, v] of Object.entries(uiState.node_positions)) {
                if (!stableId) continue;
                const x = Number((v as any)?.x);
                const y = Number((v as any)?.y);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                  positionsRef.current.set(stableId, { x, y });
                }
              }
              console.log('[useGraph] Restored UI state from disk');
            }

            // Restore canvas pan/zoom if present.
            const t = (uiState as any)?.canvas_transform ?? (uiState as any)?.canvasTransform;
            if (t) {
              const x = Number((t as any).x);
              const y = Number((t as any).y);
              const scale = Number((t as any).scale);
              if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(scale)) {
                canvasTransformRef.current = { x, y, scale };
                setInitialCanvasTransform({ x, y, scale });
                console.log('[useGraph] Restored canvas transform from disk', { x, y, scale });
              }
            }
        }
        await refresh();

        // Prime backend cache after refresh so exit-save has something even without further edits.
        if (isTauri || tauriAvailableRef.current) {
          queueUiStateCacheUpdate('initPrime');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to initialize');
      } finally {
        setIsLoading(false);
        initializedRef.current = true;
      }
    };
    init();
  }, [autoRestore, refresh, queueUiStateCacheUpdate]);

  const updateCanvasTransform = useCallback((t: { x: number; y: number; scale: number }) => {
    const x = Number((t as any)?.x);
    const y = Number((t as any)?.y);
    const scale = Number((t as any)?.scale);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;

    canvasTransformRef.current = { x, y, scale };

    // Pan/zoom changes are committed at gesture end (wheel idle / mouseup).
    // Push to backend cache immediately (no debounce) so we don't miss the last gesture.
    dirtyRef.current = true;

    if (!(isTauri || tauriAvailableRef.current)) return;

    // For pan/zoom we bypass the coalescing pump and directly invoke once.
    // This avoids any edge-case where a single end-of-gesture update could get dropped.
    const next = buildUiState();
    const key = JSON.stringify(next);
    if (uiStateCacheLastSentKeyRef.current === key) return;
    uiStateCacheLastSentKeyRef.current = key;
    void setUiStateCache(next)
      .then(() => {
        tauriAvailableRef.current = true;
      })
      .catch((e) => {
        // Best-effort; allow future retries.
        uiStateCacheLastSentKeyRef.current = null;
        console.warn('[useGraph] setUiStateCache failed', { reason: 'canvasTransform', e });
      });
  }, [buildUiState, isTauri]);

  // Node Operations
  const addSource = useCallback(async (
    sourceId: SourceIdDto,
    label?: string,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addSourceNode(sourceId, label);
    const pos = position || getNextPosition();
    pendingPositionsByHandleRef.current.set(handle, pos);
    // If we can compute a stable id immediately, prefer it.
    positionsRef.current.set(stableIdForSourceId(sourceId), pos);
    await refresh();
    markDirty('addSource');
    return handle;
  }, [getNextPosition, refresh, markDirty]);

  const addBusNode_ = useCallback(async (
    label?: string,
    portCount?: number,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addBusNode(label, portCount);
    const pos = position || getNextPosition();
    pendingPositionsByHandleRef.current.set(handle, pos);
    await refresh();
    markDirty('addBus');
    return handle;
  }, [getNextPosition, refresh, markDirty]);

  const addSinkNode_ = useCallback(async (
    sink: OutputSinkDto,
    label?: string,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addSinkNode(sink, label);
    const pos = position || getNextPosition();
    pendingPositionsByHandleRef.current.set(handle, pos);
    positionsRef.current.set(stableIdForSink(sink), pos);
    await refresh();
    markDirty('addSink');
    return handle;
  }, [getNextPosition, refresh, markDirty]);

  const deleteNode = useCallback(async (handle: number): Promise<void> => {
    await removeNode(handle);
    const stableId = handleToStableIdRef.current.get(handle);
    if (stableId) {
      positionsRef.current.delete(stableId);
    }
    pendingPositionsByHandleRef.current.delete(handle);
    handleToStableIdRef.current.delete(handle);
    await refresh();
    markDirty('deleteNode');
  }, [refresh, markDirty]);

  const updateNodePosition = useCallback((handle: number, x: number, y: number) => {
    const stableId = handleToStableIdRef.current.get(handle);
    if (stableId) {
      positionsRef.current.set(stableId, { x, y });
    } else {
      pendingPositionsByHandleRef.current.set(handle, { x, y });
    }
    setNodes(prev => {
      const node = prev.get(handle);
      if (!node) return prev;
      const newNodes = new Map(prev);
      newNodes.set(handle, { ...node, x, y });
      return newNodes;
    });
    markDirty('moveNode');
  }, [markDirty]);

  // Edge Operations
  const connect = useCallback(async (
    source: number,
    sourcePort: number,
    target: number,
    targetPort: number,
    gain: number = 1.0
  ): Promise<number> => {
    const edgeId = await addEdge(source, sourcePort, target, targetPort, gain, false);
    await refresh();
    markDirty('connect');
    return edgeId;
  }, [refresh, markDirty]);

  const disconnect = useCallback(async (edgeId: number): Promise<void> => {
    await removeEdge(edgeId);
    await refresh();
    markDirty('disconnect');
  }, [refresh, markDirty]);

  const setGain_ = useCallback(async (edgeId: number, gain: number): Promise<void> => {
    await setEdgeGain(edgeId, gain);
    // Update local state immediately for responsiveness
    setEdges(prev => {
      const edge = prev.get(edgeId);
      if (!edge) return prev;
      const newEdges = new Map(prev);
      newEdges.set(edgeId, { ...edge, gain });
      return newEdges;
    });
    markDirty('setGain');
  }, [markDirty]);

  const setMuted_ = useCallback(async (edgeId: number, muted: boolean): Promise<void> => {
    await setEdgeMuted(edgeId, muted);
    setEdges(prev => {
      const edge = prev.get(edgeId);
      if (!edge) return prev;
      const newEdges = new Map(prev);
      newEdges.set(edgeId, { ...edge, muted });
      return newEdges;
    });
    markDirty('setMuted');
  }, [markDirty]);

  // Save
  const save = useCallback(async (): Promise<void> => {
    await flushPersist({ force: true, reason: 'manualSave' });
  }, [flushPersist]);

  // Helpers
  const getNodeByHandle = useCallback((handle: number): UINode | undefined => {
    return nodes.get(handle);
  }, [nodes]);

  const getEdgesForNode = useCallback((handle: number): UIEdge[] => {
    return Array.from(edges.values()).filter(
      e => e.sourceHandle === handle || e.targetHandle === handle
    );
  }, [edges]);

  const getIncomingEdges = useCallback((handle: number): UIEdge[] => {
    return Array.from(edges.values()).filter(e => e.targetHandle === handle);
  }, [edges]);

  const getOutgoingEdges = useCallback((handle: number): UIEdge[] => {
    return Array.from(edges.values()).filter(e => e.sourceHandle === handle);
  }, [edges]);

  return {
    nodes,
    edges,
    isLoading,
    error,
    addSource,
    addBus: addBusNode_,
    addSink: addSinkNode_,
    deleteNode,
    updateNodePosition,
    connect,
    disconnect,
    setGain: setGain_,
    setMuted: setMuted_,
    refresh,
    save,
    initialCanvasTransform,
    updateCanvasTransform,
    getNodeByHandle,
    getEdgesForNode,
    getIncomingEdges,
    getOutgoingEdges,
  };
}
