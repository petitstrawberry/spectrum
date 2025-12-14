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
  type SourceIdDto,
  type OutputSinkDto,
  type NodeInfoDto,
  type EdgeInfoDto,
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
  addBus: (label: string, portCount?: number, position?: { x: number; y: number }) => Promise<number>;
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

  // Helpers
  getNodeByHandle: (handle: number) => UINode | undefined;
  getEdgesForNode: (handle: number) => UIEdge[];
  getIncomingEdges: (handle: number) => UIEdge[];
  getOutgoingEdges: (handle: number) => UIEdge[];
}

export function useGraph(options: UseGraphOptions = {}): UseGraphReturn {
  const { autoRestore = true } = options;

  const [nodes, setNodes] = useState<Map<number, UINode>>(new Map());
  const [edges, setEdges] = useState<Map<number, UIEdge>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Position tracking (not synced to backend)
  const positionsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const nextPositionRef = useRef({ x: 100, y: 100 });

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

      const newNodes = new Map<number, UINode>();
      for (const info of graphDto.nodes) {
        const handle = 'handle' in info ? info.handle : 0;
        const existingPos = positionsRef.current.get(handle);
        const position = existingPos || getNextPosition();
        if (!existingPos) {
          positionsRef.current.set(handle, position);
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
          const restored = await restoreState();
          if (restored) {
            console.log('[useGraph] Restored state from disk');
          }
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to initialize');
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, [autoRestore, refresh]);

  // Node Operations
  const addSource = useCallback(async (
    sourceId: SourceIdDto,
    label?: string,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addSourceNode(sourceId, label);
    const pos = position || getNextPosition();
    positionsRef.current.set(handle, pos);
    await refresh();
    return handle;
  }, [getNextPosition, refresh]);

  const addBusNode_ = useCallback(async (
    label: string,
    portCount?: number,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addBusNode(label, portCount);
    const pos = position || getNextPosition();
    positionsRef.current.set(handle, pos);
    await refresh();
    return handle;
  }, [getNextPosition, refresh]);

  const addSinkNode_ = useCallback(async (
    sink: OutputSinkDto,
    label?: string,
    position?: { x: number; y: number }
  ): Promise<number> => {
    const handle = await addSinkNode(sink, label);
    const pos = position || getNextPosition();
    positionsRef.current.set(handle, pos);
    await refresh();
    return handle;
  }, [getNextPosition, refresh]);

  const deleteNode = useCallback(async (handle: number): Promise<void> => {
    await removeNode(handle);
    positionsRef.current.delete(handle);
    await refresh();
  }, [refresh]);

  const updateNodePosition = useCallback((handle: number, x: number, y: number) => {
    positionsRef.current.set(handle, { x, y });
    setNodes(prev => {
      const node = prev.get(handle);
      if (!node) return prev;
      const newNodes = new Map(prev);
      newNodes.set(handle, { ...node, x, y });
      return newNodes;
    });
  }, []);

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
    return edgeId;
  }, [refresh]);

  const disconnect = useCallback(async (edgeId: number): Promise<void> => {
    await removeEdge(edgeId);
    await refresh();
  }, [refresh]);

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
  }, []);

  const setMuted_ = useCallback(async (edgeId: number, muted: boolean): Promise<void> => {
    await setEdgeMuted(edgeId, muted);
    setEdges(prev => {
      const edge = prev.get(edgeId);
      if (!edge) return prev;
      const newEdges = new Map(prev);
      newEdges.set(edgeId, { ...edge, muted });
      return newEdges;
    });
  }, []);

  // Save
  const save = useCallback(async (): Promise<void> => {
    await persistState();
  }, []);

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
    getNodeByHandle,
    getEdgesForNode,
    getIncomingEdges,
    getOutgoingEdges,
  };
}
