// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Settings,
  Search,
  Maximize2,
  Grid,
  Workflow,
  Music,
  MessageSquare,
  Gamepad2,
  Headphones,
  Radio,
  Globe,
  Speaker,
  LogOut,
  Link as LinkIcon,
  Plus,
  Trash2,
  Monitor,
  Video,
  RefreshCw,
  Volume2,
  Mic,
  ExternalLink,
  Cast,
} from 'lucide-react';
// Legacy `prismd` usage removed in favor of v2 hooks (useDevices, useAudio, etc.).

import LeftSidebar from './LeftSidebar';
import CanvasView from './CanvasView';
import RightPanel from './RightPanel';
import MixerPanel from './MixerPanel';
import { getIconForApp, getIconForDevice } from '../hooks/useIcons';
import { useChannelColors } from '../hooks/useChannelColors';
import { getColorForDevice } from '../hooks/useColors';
import { getPrismChannelDisplay, getInputDeviceDisplay, getSinkDeviceDisplay, getVirtualOutputDisplay, getBusDisplay } from '../hooks/useNodeDisplay';
import { renderToStaticMarkup } from 'react-dom/server';
import { addSourceNode, addSinkNode, removeNode, setOutputGain, setOutputChannelGain } from '../lib/api';
import { openPrismApp } from '../lib/prismd';

// --- Types ---

type NodeType = 'source' | 'target' | 'bus';
type SourceType = 'prism-channel' | 'device';
type ChannelMode = 'mono' | 'stereo';

interface AudioUnitPlugin {
  id: string;
  pluginId: string;
  name: string;
  manufacturer: string;
  type: string;
  enabled: boolean;
  state?: string;
}

interface NodeData {
  id: string;
  libraryId: string;
  type: NodeType;
  label: string;
  subLabel?: string;
  displayTitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor?: string;
  color: string;
  x: number;
  y: number;
  volume: number;
  muted: boolean;
  channelCount: number;
  channelOffset?: number;
  sourceType?: SourceType;
  deviceId?: number;
  deviceName?: string;
  channelMode: ChannelMode;
  available?: boolean;
  busId?: string;
  plugins?: AudioUnitPlugin[];
}

interface Connection {
  id: string;
  fromNodeId: string;
  fromChannel: number;
  toNodeId: string;
  toChannel: number;
  sendLevel: number;
  muted: boolean;
  stereoLinked?: boolean;
}

// The visual layout component (previously V1ExactLayout)
import type { UseDevicesReturn } from '../hooks/useDevices';

interface SpectrumLayoutProps {
  devices: UseDevicesReturn;
  // v2 graph and meters (optional for progressive migration)
  graph?: any;
  meters?: any;
}

export default function SpectrumLayout(props: SpectrumLayoutProps) {
  const { devices, graph, meters } = props;
  const hasGraph = !!graph && typeof (graph as any).addSource === 'function' && typeof (graph as any).nodes?.values === 'function';
  // For visual parity we keep local state where needed
  const [showSettings, setShowSettings] = useState(false);
  const [showPluginBrowser, setShowPluginBrowser] = useState(false);
  // debug overlay state removed
  const [fallbackPrismApps, setFallbackPrismApps] = useState<any[] | null>(null);
  // Minimal placeholders for the big UI to render without wiring
  const isRefreshing = devices?.isLoading ?? false;
  const [driverStatus, setDriverStatus] = useState<any | null>(null);
  const prismDevice = devices?.inputDevices?.find((d: any) => d.isPrism) ?? null;
  // Default to 'prism' tab per v1 behaviour
  const [inputSourceMode, setInputSourceMode] = useState<'prism' | 'devices'>('prism');
  const selectedInputDevice = prismDevice;
  // Build 32 stereo channel pairs (64 channels) like v1
  // Prefer backend prismStatus.apps (from get_prism_status). If empty, fall back to getPrismApps() results.
  let _prismApps: any[] = [];
  try {
    const fromStatus = devices?.prismStatus?.apps;
    _prismApps = (Array.isArray(fromStatus) && fromStatus.length > 0)
      ? fromStatus
      : (fallbackPrismApps ?? []);
  } catch (err) {
    // If we hit a TDZ/circular-init style ReferenceError, do not crash the whole UI.
    console.error('[SpectrumLayout] prism apps init failed', err);
    _prismApps = fallbackPrismApps ?? [];
  }

  const channelSources: any[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const offset = i * 2;
      // backend `prismStatus.apps` uses `channelOffset` (stereo-pair index)
      // fallback `getPrismApps()` returns AppSource with `channelOffsets` array; normalize both shapes
      const assigned = _prismApps.filter((a: any) => {
        // If a.channelOffset is a single number, it's the stereo-pair index (from get_prism_status)
        if (typeof a.channelOffset === 'number') return (a.channelOffset ?? 0) === i;
        // If a.channelOffsets is an array (from getPrismApps()), treat entries as absolute channel indices
        // and convert to stereo-pair index by Math.floor(channelIndex / 2).
        if (Array.isArray(a.channelOffsets)) return a.channelOffsets.some((co: number) => Math.floor(co / 2) === i);
        return false;
      });
      // Deduplicate apps by name and aggregate client counts. Do not assign a placeholder icon
      // here so the LeftSidebar can pick a category icon via `getIconForApp`.
      const appMap = new Map<string, { name: string; color?: string; pid?: number; clientCount: number }>();
      for (const a of assigned) {
        const name = a.name || 'Unknown';
        const existing = appMap.get(name);
        const clients = a.clients ? a.clients.length : (a.clientCount ?? 1);
        if (existing) {
          existing.clientCount += clients;
        } else {
          appMap.set(name, { name, color: a.color || 'text-cyan-400', pid: a.pid, clientCount: clients });
        }
      }
      const apps = Array.from(appMap.values()).map(a => ({ name: a.name, icon: undefined, color: a.color, pid: a.pid, clientCount: a.clientCount }));
      channelSources.push({
        id: `ch_${offset}`,
        channelOffset: offset,
        channelLabel: `${offset + 1}-${offset + 2}`,
        apps,
        hasApps: apps.length > 0,
        isMain: offset === 0,
      });
    }
  } catch (err) {
    console.error('[SpectrumLayout] channelSources init failed', err);
  }
  const rawOtherInputDevices: any[] = (devices?.inputDevices || []).filter((d: any) => !d.isPrism);
  const otherInputDevices: any[] = rawOtherInputDevices.map((d: any) => ({
    deviceId: Number(d.deviceId ?? d.device_id ?? d.id ?? NaN),
    name: d.name ?? d.deviceName ?? d.displayName ?? 'Device',
    channelCount: d.channelCount ?? d.channels ?? d.channels_count ?? d.channelsCount ?? 2,
  }));
  const channelColors = useChannelColors(channelSources || []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(300);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(300);
  const [mixerHeight, setMixerHeight] = useState(350);
  const [masterWidth, setMasterWidth] = useState(300);

  // v1 parity: Canvas pan/zoom
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  const canvasTransformRef = useRef(canvasTransform);
  useEffect(() => { canvasTransformRef.current = canvasTransform; }, [canvasTransform]);

  const commitCanvasTransform = useCallback((t?: { x: number; y: number; scale: number }) => {
    if (!hasGraph) return;
    const g = graph as any;
    if (!g || typeof g.updateCanvasTransform !== 'function') return;
    g.updateCanvasTransform(t ?? canvasTransformRef.current);
  }, [hasGraph, graph]);

  const wheelCommitTimerRef = useRef<number | null>(null);
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitTimerRef.current != null) {
      window.clearTimeout(wheelCommitTimerRef.current);
    }
    wheelCommitTimerRef.current = window.setTimeout(() => {
      wheelCommitTimerRef.current = null;
      commitCanvasTransform();
    }, 150);
  }, [commitCanvasTransform]);

  // Restore initial canvas transform from persisted UI state (v2 graph).
  const appliedInitialCanvasTransformRef = useRef(false);
  useEffect(() => {
    if (!hasGraph) return;
    if (appliedInitialCanvasTransformRef.current) return;
    const t = (graph as any)?.initialCanvasTransform;
    if (!t) return;
    const x = Number(t.x);
    const y = Number(t.y);
    const scale = Number(t.scale);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;
    const next = { x, y, scale };
    canvasTransformRef.current = next;
    setCanvasTransform(next);
    appliedInitialCanvasTransformRef.current = true;
  }, [
    hasGraph,
    graph,
    (graph as any)?.initialCanvasTransform?.x,
    (graph as any)?.initialCanvasTransform?.y,
    (graph as any)?.initialCanvasTransform?.scale,
  ]);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);

  const handleCanvasWheel = useCallback((e: any) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Pinch gesture (ctrlKey is set on trackpad pinch)
    if (e.ctrlKey) {
      const zoomIntensity = 0.01;
      const zoomFactor = 1 - e.deltaY * zoomIntensity;
      setCanvasTransform((prev: any) => {
        const nextScale = Math.min(Math.max(prev.scale * zoomFactor, 0.25), 3);
        const scaleChange = nextScale / prev.scale;
        const nextX = mouseX - (mouseX - prev.x) * scaleChange;
        const nextY = mouseY - (mouseY - prev.y) * scaleChange;
        const next = { x: nextX, y: nextY, scale: nextScale };
        canvasTransformRef.current = next;
        return next;
      });
      scheduleWheelCommit();
      return;
    }

    // Two-finger scroll for panning
    setCanvasTransform((prev: any) => {
      const next = {
        ...prev,
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      };
      canvasTransformRef.current = next;
      return next;
    });
    scheduleWheelCommit();
  }, [scheduleWheelCommit]);

  const handleCanvasPanStart = useCallback((e: any) => {
    // Only start pan if clicking on empty canvas (not on nodes/cables)
    if ((e.target as HTMLElement)?.closest?.('.canvas-node')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      canvasX: canvasTransformRef.current.x,
      canvasY: canvasTransformRef.current.y,
    };

    const handlePanMove = (ev: MouseEvent) => {
      if (!panStart.current) return;
      const dx = ev.clientX - panStart.current.x;
      const dy = ev.clientY - panStart.current.y;
      setCanvasTransform((prev: any) => {
        const next = {
          ...prev,
          x: panStart.current!.canvasX + dx,
          y: panStart.current!.canvasY + dy,
        };
        canvasTransformRef.current = next;
        return next;
      });
    };

    const handlePanEnd = () => {
      setIsPanning(false);
      panStart.current = null;
      document.removeEventListener('mousemove', handlePanMove);
      document.removeEventListener('mouseup', handlePanEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Persist pan once at the end of the gesture.
      commitCanvasTransform();
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handlePanMove);
    document.addEventListener('mouseup', handlePanEnd);
  }, [commitCanvasTransform]);

  const handleResizeStart = useCallback((
    e: any,
    direction: 'left' | 'right' | 'top' | 'master',
    currentValue: number,
    setter: (value: number) => void,
    minValue: number,
    maxValue: number,
    getBounds?: () => { min: number; max: number }
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const startPos = direction === 'top' ? e.clientY : e.clientX;
    const startValue = currentValue;

    const handleMove = (ev: MouseEvent) => {
      const currentPos = direction === 'top' ? ev.clientY : ev.clientX;
      let delta = currentPos - startPos;
      if (direction === 'right' || direction === 'top' || direction === 'master') {
        delta = -delta;
      }
      const bounds = typeof getBounds === 'function' ? getBounds() : { min: minValue, max: maxValue };
      const safeMin = Number.isFinite(bounds.min) ? bounds.min : minValue;
      const safeMax = Number.isFinite(bounds.max) ? bounds.max : maxValue;
      const next = Math.min(safeMax, Math.max(safeMin, startValue + delta));
      setter(next);
    };

    const handleEnd = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = direction === 'top' ? 'ns-resize' : 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
  }, []);
  const connections: Connection[] = [];
  const nodes: NodeData[] = [];
  const nodesById = new Map<string, NodeData>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);
  const [focusedOutputId, setFocusedOutputId] = useState<string | null>(null);
  const [masterGainsByOutputId, setMasterGainsByOutputId] = useState<Record<string, number[]>>({});
  const [focusedOutputChannelById, setFocusedOutputChannelById] = useState<Record<string, number>>({});
  const [channelModeByNodeId, setChannelModeByNodeId] = useState<Record<string, 'stereo' | 'mono'>>({});
  const masterLastSendMsRef = useRef<Record<string, number>>({});
  // Nodes placed on the canvas (local UI state for visual feedback)
  const [placedNodes, setPlacedNodes] = useState<NodeData[]>([]);
  const selectedBus: any = null;
  const focusedTarget: any = null;
  const focusedTargetPorts = 2;
  const isStereoMode = true;
  const mixerSources: any[] = [];
  const busMixerSources: any[] = [];
  const activeTargets: any[] = [];
  const availableOutputDevices: any[] = [];
  const outputTargets: any[] = [];
  const libraryDrag: any = null;

  const focusedOutputPortCount = useMemo(() => {
    if (!focusedOutputId) return 0;

    // Prefer graph nodes (v2), but do not reference nodesFromGraph here
    // because it's declared later in this function and would trigger TDZ.
    try {
      const g = graph as any;
      if (g && g.nodes && typeof g.nodes.values === 'function') {
        for (const n of g.nodes.values()) {
          const handle = n?.handle ?? (n?.id ?? 0);
          if (`node_${handle}` !== focusedOutputId) continue;
          const pc = Number(
            n?.portCount ??
              n?.port_count ??
              n?.channelCount ??
              n?.channel_count ??
              n?.sink?.channel_count ??
              n?.sink?.channelCount ??
              0
          );
          return Number.isFinite(pc) && pc > 0 ? pc : 0;
        }
      }
    } catch {
      // ignore
    }

    // Fallback to locally placed nodes
    const n = placedNodes.find((x: any) => x && x.id === focusedOutputId);
    const pc = Number(n?.channelCount ?? n?.portCount ?? n?.port_count ?? 0);
    return Number.isFinite(pc) && pc > 0 ? pc : 0;
  }, [focusedOutputId, graph, placedNodes]);

  const activeMasterGains = useMemo<number[]>(() => {
    if (!focusedOutputId) return [];
    const g = masterGainsByOutputId[focusedOutputId];
    return Array.isArray(g) ? g : [];
  }, [focusedOutputId, masterGainsByOutputId]);

  const masterChannelMode = useMemo<'stereo' | 'mono'>(() => {
    if (!focusedOutputId) return 'stereo';
    return channelModeByNodeId[focusedOutputId] ?? 'stereo';
  }, [focusedOutputId, channelModeByNodeId]);

  const focusedOutputChannel = useMemo(() => {
    if (!focusedOutputId) return 0;
    const ch = Number(focusedOutputChannelById[focusedOutputId] ?? 0);
    return Number.isFinite(ch) && ch >= 0 ? ch : 0;
  }, [focusedOutputId, focusedOutputChannelById]);

  const activeMasterGain = useMemo(() => {
    if (!focusedOutputId) return 1.0;
    const sel = Math.max(0, focusedOutputChannel | 0);
    const base = masterChannelMode === 'stereo' ? Math.floor(sel / 2) * 2 : sel;
    const v = Number(activeMasterGains[base]);
    return Number.isFinite(v) ? v : 1.0;
  }, [focusedOutputId, focusedOutputChannel, masterChannelMode, activeMasterGains]);

  const setFocusedOutputChannel = useCallback((ch: number) => {
    if (!focusedOutputId) return;
    const n = Number(ch);
    if (!Number.isFinite(n) || n < 0) return;
    setFocusedOutputChannelById((prev) => ({ ...prev, [focusedOutputId]: n }));
  }, [focusedOutputId]);

  const toggleMasterChannelMode = useCallback(() => {
    if (!focusedOutputId) return;
    setChannelModeByNodeId((prev) => {
      const cur = prev[focusedOutputId] ?? 'stereo';
      const next = cur === 'stereo' ? 'mono' : 'stereo';
      return { ...prev, [focusedOutputId]: next };
    });
  }, [focusedOutputId]);

  const setActiveMasterGain = useCallback((gain: number, opts?: { commit?: boolean }) => {
    if (!focusedOutputId) return;
    if (!focusedOutputId.startsWith('node_')) return;
    const outputHandle = Number(focusedOutputId.slice(5));
    if (Number.isNaN(outputHandle)) return;
    const g = Math.max(0, Math.min(4, Number(gain)));

    const pc = Math.max(0, focusedOutputPortCount | 0);
    const sel = Math.max(0, focusedOutputChannel | 0);
    const base = masterChannelMode === 'stereo' ? Math.floor(sel / 2) * 2 : sel;

    setMasterGainsByOutputId((prev) => {
      const cur = Array.isArray(prev[focusedOutputId]) ? [...(prev[focusedOutputId] as number[])] : [];
      const needLen = masterChannelMode === 'stereo' ? base + 2 : base + 1;
      const targetLen = Math.max(pc, needLen, cur.length);
      const next = targetLen > 0
        ? Array.from({ length: targetLen }, (_, i) => {
            const v = Number(cur[i]);
            return Number.isFinite(v) ? v : 1.0;
          })
        : cur;
      if (masterChannelMode === 'stereo') {
        if (base < next.length) next[base] = g;
        if (base + 1 < next.length) next[base + 1] = g;
      } else {
        if (base < next.length) next[base] = g;
      }
      return { ...prev, [focusedOutputId]: next };
    });

    const shouldCommit = opts?.commit ?? false;
    const now = performance.now();
    const key = `${focusedOutputId}:${masterChannelMode}:${Math.floor(base / 2)}`;
    const last = masterLastSendMsRef.current[key] || 0;
    if (!shouldCommit && now - last < 33) return;
    masterLastSendMsRef.current[key] = now;

    if (masterChannelMode === 'stereo') {
      void Promise.all([
        setOutputChannelGain(outputHandle, base, g),
        setOutputChannelGain(outputHandle, base + 1, g),
      ]).catch((err) => {
        console.warn('[master] setOutputChannelGain failed', err);
      });
    } else {
      void setOutputChannelGain(outputHandle, base, g).catch((err) => {
        console.warn('[master] setOutputChannelGain failed', err);
      });
    }
  }, [focusedOutputId, focusedOutputPortCount, focusedOutputChannel, masterChannelMode]);

  const setActiveMasterChannelGain = useCallback((channel: number, gain: number, opts?: { commit?: boolean }) => {
    if (!focusedOutputId) return;
    if (!focusedOutputId.startsWith('node_')) return;
    const outputHandle = Number(focusedOutputId.slice(5));
    if (Number.isNaN(outputHandle)) return;
    const ch = Number(channel);
    if (!Number.isFinite(ch) || ch < 0) return;
    const g = Math.max(0, Math.min(4, Number(gain)));

    setMasterGainsByOutputId((prev) => {
      const cur = Array.isArray(prev[focusedOutputId]) ? [...(prev[focusedOutputId] as number[])] : [];
      const pc = Math.max(0, focusedOutputPortCount | 0);
      const targetLen = Math.max(pc, ch + 1, cur.length);
      const next = targetLen > 0
        ? Array.from({ length: targetLen }, (_, i) => {
            const v = Number(cur[i]);
            return Number.isFinite(v) ? v : 1.0;
          })
        : cur;
      if (ch < next.length) next[ch] = g;
      return { ...prev, [focusedOutputId]: next };
    });

    const shouldCommit = opts?.commit ?? false;
    const now = performance.now();
    const key = `${focusedOutputId}:ch${ch}`;
    const last = masterLastSendMsRef.current[key] || 0;
    if (!shouldCommit && now - last < 33) return;
    masterLastSendMsRef.current[key] = now;

    void setOutputChannelGain(outputHandle, ch, g).catch((err) => {
      console.warn('[master] setOutputChannelGain failed', err);
    });
  }, [focusedOutputId, focusedOutputPortCount]);

  const getDefaultChannelMode = (node: any): 'stereo' | 'mono' => {
    const n = Number(node?.channelCount ?? node?.portCount ?? node?.port_count ?? 2);
    if (!Number.isFinite(n) || n <= 1) return 'mono';
    return n >= 2 && n % 2 === 0 ? 'stereo' : 'mono';
  };

  // v1 parity: default focused output is first target node if none selected yet
  useEffect(() => {
    if (focusedOutputId) return;
    let firstTargetId: string | null = null;

    const activeNums = Array.isArray(devices?.activeOutputs)
      ? (devices!.activeOutputs as any[])
          .map((v: any) => Number(v))
          .filter((n: any) => !Number.isNaN(n))
      : [];

    // Prefer v2 graph sink nodes (avoid referencing nodesFromGraph before initialization).
    try {
      const g = graph as any;
      if (g && g.nodes && typeof g.nodes.values === 'function') {
        for (const n of g.nodes.values()) {
          const t = n?.type;
          if (t !== 'sink' && t !== 'target') continue;
          if (n?.available === false) continue;

          // If runtime has an active output device, do not auto-focus a sink
          // that would be system-disabled (greyed) in the patch view.
          if (activeNums.length > 0) {
            const did = Number(
              n?.deviceId ??
                n?.device_id ??
                n?.sinkDeviceId ??
                n?.sink_device_id ??
                n?.sink?.device_id ??
                n?.sink?.deviceId ??
                NaN
            );
            if (!Number.isNaN(did) && !activeNums.includes(did)) continue;
          }

          const handle = n.handle ?? n.id ?? 0;
          firstTargetId = `node_${handle}`;
          break;
        }
      }
    } catch {
      // ignore
    }

    // Fallback to locally placed target nodes.
    if (!firstTargetId) {
      const firstPlacedTarget = placedNodes.find((n: any) => {
        if (!n || n.type !== 'target') return false;
        if (n.available === false) return false;
        if (activeNums.length === 0) return true;
        const did = Number(n.deviceId);
        if (!Number.isNaN(did) && activeNums.includes(did)) return true;
        const m = typeof n.libraryId === 'string' ? n.libraryId.match(/^vout_(\d+)_(\d+)$/) : null;
        if (m) {
          const parentId = Number(m[1]);
          if (!Number.isNaN(parentId) && activeNums.includes(parentId)) return true;
        }
        return false;
      });
      if (firstPlacedTarget?.id) firstTargetId = firstPlacedTarget.id;
    }

    if (firstTargetId) {
      setFocusedOutputId(firstTargetId);
    }
  }, [focusedOutputId, graph, placedNodes, devices?.activeOutputs]);

  const connectionsFromGraph: Connection[] = useMemo(() => {
    const g = graph as any;
    if (!g || !g.edges) return [];
    try {
      const arr = Array.from(g.edges.values());
      return arr.map((e: any) => ({
        id: `edge_${e.id}`,
        fromNodeId: `node_${e.sourceHandle}`,
        fromChannel: e.sourcePort,
        toNodeId: `node_${e.targetHandle}`,
        toChannel: e.targetPort,
        sendLevel: e.gain,
        muted: e.muted,
      }));
    } catch {
      return [];
    }
  }, [graph]);

  // If a v2 graph is provided, derive canvas nodes from it (progressive migration)
  const nodesFromGraph: NodeData[] | null = (() => {
    const g = graph as any;
    if (!g || !g.nodes) return null;
    try {
      const arr = Array.from(g.nodes.values());
      return arr.map((n: any) => {
        const handle = n.handle ?? (n.id ?? 0);
        const id = `node_${handle}`;
        const type: NodeType = n.type === 'sink' ? 'target' : (n.type === 'bus' ? 'bus' : 'source');

        // Base fields (defaults from useGraph)
        let label = n.label || `Node ${handle}`;
        let subLabel = n.subLabel || undefined;
        let displayTitle: string | undefined;
        let icon = n.icon || Music;
        let color = n.color || 'text-cyan-400';
        let iconColor = n.iconColor || color;

        // Normalize fields across UINode variants from useGraph
        // - sink nodes use `sinkDeviceId` + `channelOffset`
        // - some DTO-ish shapes may use snake_case
        let channelOffset = (type === 'target')
          ? (n.channelOffset ?? n.channel_offset ?? n.sink?.channel_offset ?? undefined)
          : (n.channelOffset ?? n.channel ?? undefined);

        const normalizedDeviceId = (type === 'target')
          ? (n.deviceId ?? n.device_id ?? n.sinkDeviceId ?? n.sink_device_id ?? n.sink?.device_id ?? undefined)
          : (n.deviceId ?? n.device_id ?? undefined);

        // Use library-style ids where possible so CanvasView and other UI helpers
        // can recognize node kinds (e.g. vout_... for output targets).
        const libraryId = (() => {
          if (type === 'target') {
            const did = Number(normalizedDeviceId);
            const off = Number(channelOffset);
            if (!Number.isNaN(did) && !Number.isNaN(off)) return `vout_${did}_${off}`;
          }
          return id;
        })();

        const srcType = n.sourceType === 'device' ? 'device' : 'prism';

        if (type === 'source' && (srcType === 'prism' || srcType === 'prism-channel') && typeof channelOffset === 'number') {
          // Match channelSources robustly
          const ch = channelSources.find((c: any) => {
            const cOff = c.channelOffset;
            if (cOff === channelOffset) return true;
            if (cOff === channelOffset * 2) return true;
            if (Math.floor(cOff / 2) === channelOffset) return true;
            return false;
          });
          if (ch) {
            // 共通関数を使用してPrismチャンネルの表示情報を取得
            const chColor = channelColors?.[ch.channelOffset ?? 0];
            const display = getPrismChannelDisplay(ch, chColor);

            // Prefer absolute channel offset from Prism status when available.
            if (typeof ch.channelOffset === 'number') {
              channelOffset = ch.channelOffset;
            }

            // Label/subLabel come from backend (label=app/MAIN/Empty, sub_label="Ch X-Y").
            label = n.label || label;
            subLabel = (n.subLabel ?? n.sub_label ?? subLabel) as any;
            displayTitle = label;
            icon = display.icon;
            iconColor = display.iconColor;
          }
        } else if (type === 'source' && srcType === 'device') {
          // 入力デバイスの表示情報
          const display = getInputDeviceDisplay({
            deviceId: n.deviceId ?? 0,
            name: n.label || 'Device',
            channelCount: n.portCount || 2,
          });
          label = display.label;
          subLabel = display.subLabel;
          displayTitle = display.label;
          icon = display.icon;
          iconColor = display.iconColor;
        } else if (type === 'target') {
          // Target(sink) display:
          // - If it's a virtual output (vout_*), prefer the same display logic as RightPanel.
          // - Otherwise fall back to generic sink display.
          if (typeof libraryId === 'string' && libraryId.startsWith('vout_')) {
            const vEntry = (devices?.virtualOutputDevices || []).find((v: any) => v.id === libraryId);
            if (vEntry) {
              const display = getVirtualOutputDisplay(
                vEntry.name,
                vEntry.channels || vEntry.channelCount || 2,
                vEntry.iconHint
              );
              label = display.label;
              subLabel = display.subLabel;
              displayTitle = display.label;
              icon = display.icon;
              iconColor = display.iconColor;
            } else {
              const display = getSinkDeviceDisplay(n.label || 'Output', n.portCount || 2);
              label = display.label;
              subLabel = display.subLabel;
              displayTitle = display.label;
              icon = display.icon;
              iconColor = display.iconColor;
            }
          } else {
            const display = getSinkDeviceDisplay(n.label || 'Output', n.portCount || 2);
            label = display.label;
            subLabel = display.subLabel;
            displayTitle = display.label;
            icon = display.icon;
            iconColor = display.iconColor;
          }
        } else if (type === 'bus') {
          // Busの表示情報
          const display = getBusDisplay(n.busId || 'bus_1', n.portCount || 2, n.plugins?.length || 0);
          label = n.label || display.label;
          subLabel = display.subLabel;
          displayTitle = (n.label || display.label);
          icon = display.icon;
          iconColor = display.iconColor;
          color = display.iconColor;
        }

        // Fallback if not set by a display helper.
        if (!displayTitle) displayTitle = (subLabel && String(subLabel).trim() !== '') ? String(subLabel) : label;

        return {
          id,
          libraryId,
          type,
          label,
          subLabel,
          displayTitle,
          icon,
          iconColor,
          color,
          x: typeof n.x === 'number' ? n.x : 100,
          y: typeof n.y === 'number' ? n.y : 100,
          volume: 1,
          muted: false,
          channelCount: n.portCount || 2,
          channelOffset,
          sourceType: srcType === 'device' ? 'device' : 'prism-channel',
          deviceId: normalizedDeviceId,
          deviceName: undefined,
          channelMode: 'stereo',
          available: true,
          busId: n.busId ?? undefined,
          plugins: n.plugins ?? undefined,
        } as NodeData;
      });
    } catch (e) {
      return null;
    }
  })();

  // Merge v2 graph nodes with legacy locally-placed nodes, but avoid duplicates.
  // During the migration period both sources can contain the same `node_<handle>` entries.
  const mergedNodes: NodeData[] = (() => {
    const primary = nodesFromGraph || [];
    const ids = new Set<string>();
    const out: NodeData[] = [];

    for (const n of primary) {
      if (!n || !n.id) continue;
      if (ids.has(n.id)) continue;
      ids.add(n.id);
      out.push(n);
    }

    // v2 mode: audio graph is the single source of truth.
    // Do not merge `placedNodes` to avoid conflicting local state.
    if (!hasGraph) {
      for (const n of placedNodes) {
        if (!n || !n.id) continue;
        if (ids.has(n.id)) continue;
        ids.add(n.id);
        out.push(n);
      }
    }

    return out;
  })();

  // If an output node becomes system-disabled (greyed out), force-clear focus/selection
  // so its cables are not highlighted anymore.
  useEffect(() => {
    const allNodes = mergedNodes;
    const activeNums = Array.isArray(devices?.activeOutputs)
      ? (devices!.activeOutputs as any[])
          .map((v: any) => Number(v))
          .filter((n: any) => !Number.isNaN(n))
      : [];

    const isTargetDisabled = (node: any): boolean => {
      if (!node || node.type !== 'target') return false;
      if (node.available === false) return true;
      if (activeNums.length === 0) return false;
      const m = typeof node.libraryId === 'string' ? node.libraryId.match(/^vout_(\d+)_(\d+)$/) : null;
      if (m) {
        const parentId = Number(m[1]);
        if (!Number.isNaN(parentId) && !activeNums.includes(parentId)) return true;
      }
      return false;
    };

    // Clear focus first (this is what drives cable highlight).
    if (focusedOutputId) {
      const focused = allNodes.find((n: any) => n && n.id === focusedOutputId);
      if (isTargetDisabled(focused)) {
        setFocusedOutputId(null);
        if (selectedNodeId === focusedOutputId) setSelectedNodeId(null);
        return;
      }
    }

    // Also clear selection if it points at a disabled target.
    if (selectedNodeId) {
      const sel = allNodes.find((n: any) => n && n.id === selectedNodeId);
      if (isTargetDisabled(sel)) setSelectedNodeId(null);
    }
  }, [devices?.activeOutputs, nodesFromGraph, placedNodes, focusedOutputId, selectedNodeId]);

  // Extract bus nodes for RightPanel
  const busNodes = useMemo(() => {
    return mergedNodes
      .filter((n: any) => n.type === 'bus')
      .map((n: any) => ({
        id: n.id,
        label: n.label,
        busId: n.busId,
        channelCount: n.channelCount || 2,
        plugins: n.plugins,
      }));
  }, [nodesFromGraph, placedNodes]);

  // Get selected bus data for MixerPanel
  const selectedBusData = useMemo(() => {
    if (!selectedBusId) return null;
    const g = graph as any;
    if (!g || !g.nodes) return null;
    try {
      for (const n of g.nodes.values()) {
        if (n.type !== 'bus') continue;
        const nodeId = `node_${n.handle}`;
        if (nodeId !== selectedBusId) continue;
        return {
          id: nodeId,
          handle: n.handle,
          label: n.label || `Bus ${n.handle}`,
          busId: n.busId,
          channelCount: n.portCount || 2,
          plugins: n.plugins?.map((p: any) => ({
            id: p.instance_id || p.instanceId || p.id,
            pluginId: p.plugin_id || p.pluginId,
            name: p.name,
            manufacturer: p.manufacturer || '',
            enabled: p.enabled !== false,
          })) || [],
        };
      }
    } catch {
      // ignore
    }
    return null;
  }, [selectedBusId, (graph as any)?.nodes]);

  // Selected node for a general-purpose detail view (bus/source/target)
  const selectedNodeData = useMemo(() => {
    if (!selectedNodeId) return null;
    return mergedNodes.find((n: any) => n && n.id === selectedNodeId) || null;
  }, [selectedNodeId, nodesFromGraph, placedNodes]);

  const mixerChannelMode = useMemo<'stereo' | 'mono'>(() => {
    const targetId = (selectedNodeData && (selectedNodeData.type === 'target' || selectedNodeData.type === 'bus'))
      ? selectedNodeData.id
      : null;
    if (!targetId) return 'stereo';
    return channelModeByNodeId[targetId] ?? getDefaultChannelMode(selectedNodeData);
  }, [selectedNodeData, channelModeByNodeId]);

  const toggleMixerChannelMode = useCallback(() => {
    const targetId = (selectedNodeData && (selectedNodeData.type === 'target' || selectedNodeData.type === 'bus'))
      ? selectedNodeData.id
      : null;
    if (!targetId) return;
    setChannelModeByNodeId((prev) => {
      const cur = prev[targetId] ?? getDefaultChannelMode(selectedNodeData);
      const next = cur === 'stereo' ? 'mono' : 'stereo';
      return { ...prev, [targetId]: next };
    });
  }, [selectedNodeData]);

  const mixerTargetId = (selectedNodeData && (selectedNodeData.type === 'target' || selectedNodeData.type === 'bus'))
    ? selectedNodeData.id
    : null;

  const mixerTargetPortCount = useMemo(() => {
    if (!mixerTargetId) return 0;
    const n: any = selectedNodeData;
    const pc = Math.max(0, Number(n?.channelCount ?? n?.portCount ?? n?.port_count ?? 0) | 0);
    // Buses are generally stereo unless otherwise specified.
    if (pc > 0) return pc;
    if (n?.type === 'bus') return 2;
    return 0;
  }, [mixerTargetId, selectedNodeData]);

  const mixerSelectedChannel = useMemo(() => {
    if (!mixerTargetId) return 0;
    const ch = Number(focusedOutputChannelById[mixerTargetId] ?? 0);
    return Number.isFinite(ch) ? Math.max(0, ch | 0) : 0;
  }, [mixerTargetId, focusedOutputChannelById]);

  const setMixerSelectedChannel = useCallback((ch: number) => {
    if (!mixerTargetId) return;
    const n = Math.max(0, Number(ch) | 0);
    setFocusedOutputChannelById((prev) => ({ ...prev, [mixerTargetId]: n }));
  }, [mixerTargetId]);

  // Some graph providers mutate the connections array in-place; derive a fingerprint so memoized
  // computations (like mixerStrips) still update on rewires without needing unrelated toggles.
  const connectionsFingerprint = (connectionsFromGraph || [])
    .map((c: any) => {
      if (!c) return '';
      return [
        String(c.id ?? ''),
        String(c.fromNodeId ?? ''),
        String(c.fromChannel ?? ''),
        String(c.toNodeId ?? ''),
        String(c.toChannel ?? ''),
        String(c.sendLevel ?? ''),
        String(c.muted ?? ''),
      ].join(':');
    })
    .join('|');

  // Mixer strips: input-side edges connected into the selected output/bus.
  // UI-only for now (no controls wired).
  const mixerStrips = useMemo(() => {
    const targetId = mixerTargetId;
    if (!targetId) return [];

    const sel = Math.max(0, mixerSelectedChannel | 0);
    const base = mixerChannelMode === 'stereo' ? Math.floor(sel / 2) * 2 : sel;

    const nodesById = new Map<string, any>(mergedNodes.map((n: any) => [n.id, n]));

    const incoming0 = (connectionsFromGraph || []).filter((c: any) => c && c.toNodeId === targetId);
    const incoming = incoming0.filter((c: any) => {
      const toCh = Number(c?.toChannel);
      if (mixerChannelMode === 'mono') return toCh === base;
      return toCh === base || toCh === base + 1;
    });
    if (incoming.length === 0) return [];

    const sorted = [...incoming].sort((a: any, b: any) => {
      const an = String(a.fromNodeId || '').localeCompare(String(b.fromNodeId || ''));
      if (an !== 0) return an;
      const ac = Number(a.fromChannel) - Number(b.fromChannel);
      if (ac !== 0) return ac;
      return Number(a.toChannel) - Number(b.toChannel);
    });

    // In MONO: operate per-channel.
    if (mixerChannelMode === 'mono') {
      const out: any[] = [];
      for (const c of sorted) {
        if (!c) continue;
        const sourceNode = nodesById.get(c.fromNodeId);
        if (!sourceNode) continue;
        out.push({
          id: String(c.id),
          connectionIds: [c.id],
          sourceNode,
          targetId,
          fromChannels: [c.fromChannel],
          toChannels: [c.toChannel],
          sendLevel: c.sendLevel,
          muted: !!c.muted,
          stereoLinked: false,
          // laneEdgeIds omitted in mono
        });
      }
      return out;
    }

    // In ST: treat inputs as pairs (even/odd) for display; allow either lane to be connected.
    const groups = new Map<string, any[]>();
    for (const c of sorted) {
      if (!c) continue;
      const fromCh = Number(c.fromChannel);
      const pairBase = Math.floor((Number.isFinite(fromCh) ? fromCh : 0) / 2) * 2;
      const key = `${String(c.fromNodeId)}:pair${pairBase}`;
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }

    const out: any[] = [];
    for (const [key, arr] of groups.entries()) {
      if (!arr || arr.length === 0) continue;
      const first = arr[0];
      const sourceNode = nodesById.get(first.fromNodeId);
      if (!sourceNode) continue;

      const fromCh0 = Number(first.fromChannel);
      const pairBase = Math.floor((Number.isFinite(fromCh0) ? fromCh0 : 0) / 2) * 2;

      // Lane mapping is destination-based (L/R of the currently displayed target pair),
      // so 1ch sources fanning out to stereo still meter on both sides.
      const laneL = arr.filter((c: any) => {
        const toCh = Number(c?.toChannel);
        return Number.isFinite(toCh) && (toCh % 2 === 0);
      });
      const laneR = arr.filter((c: any) => {
        const toCh = Number(c?.toChannel);
        return Number.isFinite(toCh) && (toCh % 2 === 1);
      });

      const laneLIds = laneL.map((c: any) => c.id).filter((id: any) => id != null);
      const laneRIds = laneR.map((c: any) => c.id).filter((id: any) => id != null);
      const connectionIds = [...laneLIds, ...laneRIds];

      if (connectionIds.length === 0) continue;

      out.push({
        id: `pair:${String(first.fromNodeId)}:${pairBase}:${String(targetId)}`,
        connectionIds,
        laneEdgeIds: [laneLIds, laneRIds],
        sourceNode,
        targetId,
        fromChannels: [pairBase, pairBase + 1],
        toChannels: [laneL[0]?.toChannel ?? null, laneR[0]?.toChannel ?? null],
        sendLevel: first.sendLevel,
        muted: [...laneL, ...laneR].every((c: any) => !!c?.muted),
        stereoLinked: true,
      });
    }

    // Stable ordering by source then pair base
    out.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    return out;
  }, [mixerTargetId, mixerSelectedChannel, connectionsFingerprint, nodesFromGraph, placedNodes, mixerChannelMode]);


  // Refresh graph when plugins change
  const handlePluginsChange = useCallback(() => {
    const g = (props as any).graph;
    if (g && typeof g.refresh === 'function') {
      g.refresh();
    }
  }, [props]);

  // Delete bus handler
  const handleDeleteBus = useCallback(async (busId: string) => {
    if (!busId?.startsWith('node_')) return;
    const handle = Number(busId.slice(5));
    if (Number.isNaN(handle)) return;
    try {
      const g = (props as any).graph;
      if (g && typeof g.deleteNode === 'function') {
        await g.deleteNode(handle);
        if (selectedBusId === busId) setSelectedBusId(null);
      }
    } catch (e) {
      console.error('deleteNode failed', e);
    }
  }, [props, selectedBusId]);

  const log = useCallback((event: string, payload?: any) => {
    try {
      if (payload !== undefined) console.log(`[SpectrumLayout] ${event}`, payload);
      else console.log(`[SpectrumLayout] ${event}`);
    } catch {
      // ignore
    }
  }, []);

  const mixerOutputTargets = useMemo(() => {
    const allNodes = mergedNodes;
    const activeNums = Array.isArray(devices?.activeOutputs)
      ? (devices!.activeOutputs as any[])
          .map((v: any) => Number(v))
          .filter((n: any) => !Number.isNaN(n))
      : [];

    const targets = allNodes
      .filter((n: any) => n && n.type === 'target')
      .map((n: any) => {
        let label = n.label || 'Output';
        let subLabel = n.subLabel || '';
        let icon: any = n.icon || Monitor;
        let iconColor: any = n.iconColor || n.color || 'text-slate-500';

        let parentDeviceId: number | null = null;
        if (typeof n.deviceId === 'number' && !Number.isNaN(n.deviceId)) parentDeviceId = n.deviceId;
        if (parentDeviceId == null && typeof n.libraryId === 'string') {
          const m = n.libraryId.match(/^vout_(\d+)_(\d+)$/);
          if (m) parentDeviceId = Number(m[1]);
        }

        // Prefer virtual output metadata for display, if present.
        if (typeof n.libraryId === 'string' && n.libraryId.startsWith('vout_')) {
          const vEntry = (devices?.virtualOutputDevices || []).find((v: any) => v.id === n.libraryId);
          if (vEntry) {
            const display = getVirtualOutputDisplay(vEntry.name, vEntry.channels || vEntry.channelCount || 2, vEntry.iconHint);
            label = display.label;
            subLabel = display.subLabel;
            icon = display.icon;
            iconColor = display.iconColor;
          }
        }

        // System-disabled (greyed) logic: if runtime is active on some device(s),
        // outputs for other devices are disabled.
        let disabled = false;
        if (n?.available === false) disabled = true;
        if (!disabled && activeNums.length > 0 && parentDeviceId != null) {
          if (!activeNums.includes(parentDeviceId)) disabled = true;
        }

        return {
          id: n.id,
          label,
          subLabel,
          icon,
          iconColor,
          disabled,
        };
      });

    // Stable-ish ordering
    targets.sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)));
    return targets;
  }, [nodesFromGraph, placedNodes, devices?.virtualOutputDevices, devices?.activeOutputs]);

  const handleFocusOutputId = useCallback(async (outputNodeId: string | null) => {
    if (!outputNodeId) {
      setFocusedOutputId(null);
      log('focusOutput', { outputNodeId: null });
      return;
    }

    // Do not allow focusing a system-disabled (greyed) output node.
    const n = mergedNodes.find((x: any) => x && x.id === outputNodeId);
    const activeNums = Array.isArray(devices?.activeOutputs)
      ? (devices!.activeOutputs as any[])
          .map((v: any) => Number(v))
          .filter((nn: any) => !Number.isNaN(nn))
      : [];
    let isSystemDisabled = false;
    if (n?.available === false) isSystemDisabled = true;
    if (!isSystemDisabled && activeNums.length > 0 && typeof n?.libraryId === 'string') {
      const m = n.libraryId.match(/^vout_(\d+)_(\d+)$/);
      if (m) {
        const parentId = Number(m[1]);
        if (!Number.isNaN(parentId) && !activeNums.includes(parentId)) isSystemDisabled = true;
      }
    }
    if (isSystemDisabled) {
      setFocusedOutputId(null);
      if (selectedNodeId === outputNodeId) setSelectedNodeId(null);
      log('focusOutputIgnored(systemDisabled)', { outputNodeId });
      return;
    }

    if (!outputNodeId.startsWith('node_')) {
      setFocusedOutputId(null);
      if (selectedNodeId === outputNodeId) setSelectedNodeId(null);
      log('focusOutputIgnored(nonNodeId)', { outputNodeId });
      return;
    }

    const outputHandle = Number(outputNodeId.slice(5));
    if (Number.isNaN(outputHandle)) {
      setFocusedOutputId(null);
      if (selectedNodeId === outputNodeId) setSelectedNodeId(null);
      log('focusOutputIgnored(badHandle)', { outputNodeId });
      return;
    }

    let deviceId: number | null = null;
    if (typeof n?.deviceId === 'number' && !Number.isNaN(n.deviceId)) {
      deviceId = n.deviceId;
    } else if (typeof n?.libraryId === 'string') {
      const m = n.libraryId.match(/^vout_(\d+)_(\d+)$/);
      if (m) deviceId = Number(m[1]);
    }

    setFocusedOutputId(outputNodeId);
    // v1-like: selecting an output also makes it the active mixer target.
    setSelectedNodeId(outputNodeId);
    setSelectedBusId(null);
    log('focusOutput', { outputNodeId, deviceId, outputHandle });

    // Apply per-output stored master gain (UI state) to backend master gain.
    const pc = Math.max(0, Number(n?.channelCount ?? n?.portCount ?? n?.port_count ?? 0) | 0);
    const stored = masterGainsByOutputId[outputNodeId];
    const gains = pc > 0
      ? Array.from({ length: pc }, (_, i) => {
          const v = Array.isArray(stored) ? Number(stored[i]) : NaN;
          return Math.max(0, Math.min(4, Number.isFinite(v) ? v : 1.0));
        })
      : (Array.isArray(stored) ? stored.map((v: any) => Math.max(0, Math.min(4, Number(v) || 1.0))) : []);

    // Persist normalized shape in UI state.
    if (pc > 0) {
      setMasterGainsByOutputId((prev) => ({ ...prev, [outputNodeId]: gains }));
      setFocusedOutputChannelById((prev) => ({ ...prev, [outputNodeId]: Number(prev[outputNodeId] ?? 0) }));
    }

    if (gains.length > 0) {
      const allSame = gains.every((x) => x === gains[0]);
      if (allSame) {
        void setOutputGain(outputHandle, gains[0]).catch((err) => {
          console.warn('[master] setOutputGain failed on focus change', err);
        });
      } else {
        void Promise.all(gains.map((g0, ch) => setOutputChannelGain(outputHandle, ch, g0))).catch((err) => {
          console.warn('[master] setOutputChannelGain failed on focus change', err);
        });
      }
    }

    if (deviceId != null && devices?.startOutput) {
      log('startOutput', { deviceId, from: 'focusOutput' });
      try {
        await devices.startOutput(deviceId);
      } catch (e) {
        console.error('[SpectrumLayout] startOutput failed', e);
      }
    }
  }, [devices, log, nodesFromGraph, placedNodes, selectedNodeId, masterGainsByOutputId]);

  // Compute whether a library item is used (i.e., already placed on the canvas)
  const isLibraryItemUsed = useCallback((id: string) => {
    // If there's an optimistic/local placed node with this library id, it's used
    if (placedNodes.some(p => p.libraryId === id)) return true;

    // Also check nodes coming from the v2 graph so RightPanel can grey items
    if (!nodesFromGraph) return false;

    if (id.startsWith('ch_')) {
      const offset = Number(id.slice(3));
      return nodesFromGraph.some(n => n.type === 'source' && (n.sourceType === 'prism-channel' || n.sourceType === 'prism') && (n.channelOffset === offset || n.deviceId === undefined && n.channel === offset));
    }

    if (id.startsWith('dev_')) {
      const deviceId = Number(id.slice(4));
      return nodesFromGraph.some(n => n.type === 'source' && n.deviceId === deviceId);
    }

    if (id.startsWith('vout_')) {
      const m = id.match(/^vout_(\d+)_(\d+)$/);
      if (!m) return false;
      const parentDeviceId = Number(m[1]);
      const offset = Number(m[2]);
      return nodesFromGraph.some(n => n.type === 'target' && n.deviceId === parentDeviceId && n.channelOffset === offset);
    }

    return false;
  }, [placedNodes, nodesFromGraph]);

  // Handle drag from library items in LeftSidebar
  const handleLibraryMouseDown = useCallback((e: React.MouseEvent, type: 'lib_source' | 'lib_target', id: string) => {
    // Support lib_source (sources/inputs) and lib_target (sinks/outputs)
    if (type !== 'lib_source' && type !== 'lib_target') return;
    const startX = e.clientX;
    const startY = e.clientY;

    // Create ghost element (show v1-like label while dragging)
    const ghost = document.createElement('div');
    ghost.className = 'pointer-events-none fixed z-50 bg-slate-800/80 border border-slate-700 text-xs text-slate-200 rounded p-2';
    ghost.style.left = `${startX}px`;
    ghost.style.top = `${startY}px`;

    // Build v1-style display text + icon (render icon to SVG string)
    let ghostLabel = id;
    let ghostSub = '';
    let GhostIcon: any = null;
    if (id.startsWith('ch_')) {
      const offset = Number(id.slice(3));
      ghostLabel = `Ch ${offset + 1}-${offset + 2}`;
      const ch = channelSources.find((c: any) => c.id === id);
      if (ch) {
        ghostSub = ch.isMain ? 'MAIN' : (ch.apps && ch.apps.length > 0 ? ch.apps[0].name : 'Empty');
        GhostIcon = ch.isMain ? Volume2 : ((ch.apps && ch.apps[0] && ch.apps[0].icon) || getIconForApp(ch.apps[0]?.name) || Music);
      } else {
        GhostIcon = Music;
      }
    } else if (id.startsWith('dev_')) {
      const deviceId = Number(id.slice(4));
      const dev = otherInputDevices.find((d: any) => Number(d.deviceId ?? d.device_id) === deviceId) || null;
      ghostLabel = dev ? dev.name : `Device ${deviceId}`;
      ghostSub = dev ? `${dev.channelCount ?? dev.channels ?? ''}ch` : '';
      GhostIcon = Mic;
    } else if (id.startsWith('vout_')) {
      // virtual output entry like "vout_<device>_<offset>"
      const m = id.match(/^vout_(\d+)_(\d+)$/);
      if (m) {
        const vEntry = (devices?.virtualOutputDevices || []).find((v: any) => v.id === id);
        const name = vEntry ? vEntry.name : `Out ${m[2]}`;
        const channels = vEntry ? (vEntry.channels || vEntry.channelCount || 0) : 0;
        ghostLabel = name;
        ghostSub = channels ? `${channels}ch` : 'Virtual';
        GhostIcon = Monitor;
      }
    }

    const iconSvg = GhostIcon ? renderToStaticMarkup(React.createElement(GhostIcon, { className: 'w-4 h-4', style: { verticalAlign: 'middle' } })) : '';
    // If we have an app name for a Prism channel, prefer showing the app name larger than the "Ch X-Y" label.
    let titleHtml = `<div class="font-bold text-sm">${ghostLabel}</div>`;
    let subtitleHtml = ghostSub ? `<div class="text-[10px] text-slate-400 mt-1">${ghostSub}</div>` : '';
    if (id.startsWith('ch_') && ghostSub && ghostSub !== 'Empty') {
      // show app name as title, channel as muted subtitle
      titleHtml = `<div class="font-bold text-sm">${ghostSub}</div>`;
      subtitleHtml = `<div class="text-[10px] text-slate-400 mt-1">${ghostLabel}</div>`;
    }

    ghost.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;vertical-align:middle">
        <div style="width:20px;height:20px;display:flex;align-items:center;justify-content:center">${iconSvg}</div>
        <div>
          ${titleHtml}
          ${subtitleHtml}
        </div>
      </div>
    `;
    document.body.appendChild(ghost);

    const onMove = (ev: MouseEvent) => {
      ghost.style.left = `${ev.clientX + 8}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
    };

    const finish = async (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', finish);
      try {
        // Determine drop target: if over canvas, create node
        if (canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
              // Compute canvas-local coordinates and account for pan/zoom (canvasTransform)
              // screen -> canvas content: subtract container origin, then reverse translate and scale
              const scale = (canvasTransform && canvasTransform.scale) ? canvasTransform.scale : 1;
              const tx = (canvasTransform && canvasTransform.x) ? canvasTransform.x : 0;
              const ty = (canvasTransform && canvasTransform.y) ? canvasTransform.y : 0;
              const canvasX = (ev.clientX - rect.left - tx) / scale;
              const canvasY = (ev.clientY - rect.top - ty) / scale;

            // Build sourceId for v2 API based on library id format
            let sourceId: any = null;
            let label = id;
            if (id.startsWith('ch_')) {
              // id format: ch_<offset> where offset is the first channel of the stereo pair (0-based)
              const offset = Number(id.slice(3));
              sourceId = { type: 'prism_channel', channel: offset };
              // v1 displays stereo pairs as "1-2", "3-4" etc. and node label as "Ch 1-2"
              const displayLabel = `${offset + 1}-${offset + 2}`;
              label = `Ch ${displayLabel}`;
            } else if (id.startsWith('dev_')) {
              const deviceId = Number(id.slice(4));
              sourceId = { type: 'input_device', device_id: deviceId, channel: 0 };
              // Use the device name like v1 instead of generic "Device N"
              const dev = otherInputDevices.find((d: any) => Number(d.deviceId) === deviceId) || null;
              label = dev ? dev.name : `Device ${deviceId}`;
            }

            if (sourceId) {
              console.debug('drop detected', { id, canvasX, canvasY, sourceId, label });
              // derive a human-friendly subLabel and icon/channelCount to match LeftSidebar
              let subLabel = '';
              let nodeIcon: any = Music;
              let nodeChannels = 2;
              if (id.startsWith('ch_')) {
                const ch = channelSources.find((c: any) => c.id === id);
                if (ch) {
                  subLabel = ch.isMain ? 'MAIN' : (ch.apps && ch.apps.length > 0 ? ch.apps[0].name : 'Empty');
                  // LeftSidebar picks the first app icon or falls back to getIconForApp/name or Music
                  const FirstIcon = (ch.apps && ch.apps[0] && ch.apps[0].icon) || getIconForApp(ch.apps[0]?.name) || Music;
                  nodeIcon = ch.isMain ? Volume2 : FirstIcon;
                  // Prefer the channel color calculated by useChannelColors
                  const chColor = channelColors && (channelColors[ch.channelOffset ?? ch.channelOffset] || channelColors[ch.channelOffset ?? 0]);
                  // If chColor exists it's a rgb(...) string, otherwise fall back to CSS class
                  nodeChannels = 2;
                  // assign later when building node object
                  // store as colorValue
                  var colorValue = chColor || 'text-cyan-400';
                } else {
                  nodeIcon = Music;
                  var colorValue = 'text-cyan-400';
                }
                nodeChannels = 2;
                      } else if (id.startsWith('dev_')) {
                          const deviceId = Number(id.slice(4));
                          const dev = otherInputDevices.find((d: any) => Number(d.deviceId) === deviceId) || null;
                          subLabel = dev ? `${dev.channelCount ?? ''}ch` : '';
                          nodeIcon = Mic;
                          nodeChannels = dev ? (dev.channelCount ?? 2) : 2;
                          var colorValue = 'text-amber-200';
                        }

              try {
                // If this is a physical input device (not Prism), ensure input capture is started
                if (id.startsWith('dev_')) {
                  const deviceId = Number(id.slice(4));
                  try {
                    if (devices?.startCapture && !((devices?.activeCaptures || []).includes(deviceId))) {
                      const started = await devices.startCapture(deviceId);
                      console.debug('startCapture result', deviceId, started);
                      if (!started) console.warn('startCapture failed for device', deviceId);
                    }
                  } catch (e) {
                    console.error('startCapture error', e);
                  }
                }

                // v2 mode: audio graph is authoritative. Do not add local placed nodes.
                if (hasGraph) {
                  try {
                    const handle = await (props as any).graph.addSource(sourceId, label, { x: canvasX, y: canvasY });
                    console.debug('added node via graph.addSource', handle);
                  } catch (e) {
                    console.error('graph.addSource failed', e);
                  }
                } else {
                  const handle = await addSourceNode(sourceId, label);
                  // Add a simple visual node to placedNodes for v1/local fallback
                  setPlacedNodes(prev => [...prev, {
                    id: `node_${handle}`,
                    libraryId: id,
                    type: 'source',
                    label,
                    subLabel,
                    icon: nodeIcon,
                    // use computed colorValue when available
                    color: typeof colorValue !== 'undefined' ? colorValue : 'text-cyan-400',
                    deviceName: id.startsWith('dev_') ? (otherInputDevices.find((d:any)=>d.deviceId === Number(id.slice(4)))?.name) : undefined,
                    x: canvasX,
                    y: canvasY,
                    volume: 1,
                    muted: false,
                    channelCount: nodeChannels,
                    channelMode: 'stereo'
                  }]);
                }
              } catch (err) {
                console.error('addSourceNode/graph.addSource failed, falling back to local node', err);
                if (!hasGraph) {
                  // Fallback (legacy): still show a local visual node so UI feedback is visible
                  setPlacedNodes(prev => [...prev, {
                    id: `node_local_${Date.now()}`,
                    libraryId: id,
                    type: 'source',
                    label,
                    subLabel,
                    icon: nodeIcon,
                    color: typeof colorValue !== 'undefined' ? colorValue : 'text-cyan-400',
                    deviceName: id.startsWith('dev_') ? (otherInputDevices.find((d:any)=>d.deviceId === Number(id.slice(4)))?.name) : undefined,
                    x: canvasX,
                    y: canvasY,
                    volume: 1,
                    muted: false,
                    channelCount: nodeChannels,
                    channelMode: 'stereo',
                  }]);
                }
              }
            }
            // handle virtual output sinks (id like 'vout_<device>_<offset>')
            if (!sourceId && typeof id === 'string' && id.startsWith('vout_')) {
              const m = id.match(/^vout_(\d+)_(\d+)$/);
              if (m && canvasRef.current) {
                const parentDeviceId = Number(m[1]);
                const offset = Number(m[2]);
                // Lookup virtual output metadata from devices hook
                const vEntry = (devices?.virtualOutputDevices || []).find((v: any) => v.id === id);
                const nodeChannelsLocal = vEntry ? (vEntry.channels || vEntry.channelCount || 2) : (typeof nodeChannels === 'number' ? nodeChannels : 2);
                // Use the same display logic as RightPanel for icon + color.
                const display = vEntry
                  ? getVirtualOutputDisplay(vEntry.name, nodeChannelsLocal, vEntry.iconHint)
                  : null;
                const nodeIconLocal = (display?.icon as any) || Monitor;
                const colorValueLocal = (display?.iconColor as any) || (typeof colorValue !== 'undefined' ? colorValue : 'text-pink-400');
                const sink = { device_id: parentDeviceId, channel_offset: offset, channel_count: nodeChannelsLocal };
                const labelText = vEntry ? vEntry.name : `Out ${offset + 1}-${offset + nodeChannelsLocal}`;
                try {
                  if (hasGraph && typeof (props as any).graph.addSink === 'function') {
                    const handle = await (props as any).graph.addSink(sink, labelText, { x: canvasX, y: canvasY });
                    console.debug('added sink via graph.addSink', handle);
                  } else {
                    const handle = await addSinkNode(sink, labelText);
                    setPlacedNodes(prev => [...prev, {
                      id: `node_${handle}`,
                      libraryId: id,
                      type: 'target',
                      label: labelText,
                      subLabel: `${nodeChannelsLocal}ch Output`,
                      icon: nodeIconLocal,
                      color: colorValueLocal,
                      iconColor: colorValueLocal,
                      x: canvasX,
                      y: canvasY,
                      volume: 1,
                      muted: false,
                      channelCount: nodeChannelsLocal,
                      channelMode: 'stereo',
                    }]);
                  }
                } catch (err) {
                  console.error('addSinkNode/graph.addSink failed, falling back to local sink node', err);
                  if (!hasGraph) {
                    setPlacedNodes(prev => [...prev, {
                      id: `node_local_${Date.now()}`,
                      libraryId: id,
                      type: 'target',
                      label: labelText,
                      subLabel: `${nodeChannelsLocal}ch Output`,
                      icon: nodeIconLocal,
                      color: colorValueLocal,
                      iconColor: colorValueLocal,
                      x: canvasX,
                      y: canvasY,
                      volume: 1,
                      muted: false,
                      channelCount: nodeChannelsLocal,
                      channelMode: 'stereo',
                    }]);
                  }
                }
              }
            }
          }
        }
      } finally {
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', finish);
  }, [canvasRef, channelSources, otherInputDevices, devices, devices?.activeCaptures]);

  // No-op handlers to satisfy JSX bindings
  const handleRefresh = async () => { if (devices?.refresh) await devices.refresh(); };
  const deleteConnection = () => {};
  const startWire = () => {};
  const endWire = () => {};
  const handleNodeMouseDown = () => {};
  const deleteNode = () => {};
  const toggleChannelMode = () => {};
  // Use the real openPrismApp from ../lib/prismd (imported above)
  // openPrismApp is imported; call it directly where needed
  const reserveBusIdStub = async () => 'bus_1';
  // Add Bus handler (backend auto-generates label)
  const handleAddBus = useCallback(async () => {
    const g = (props as any).graph;
    if (!g || typeof g.addBus !== 'function') {
      console.error('[SpectrumLayout] graph.addBus not available');
      return;
    }
    try {
      const handle = await g.addBus(); // stereo bus, auto-generated label
      console.debug('[SpectrumLayout] addBus ok', { handle });
    } catch (e) {
      console.error('[SpectrumLayout] addBus failed', e);
    }
  }, [props]);
  const getActiveInputCaptures = async () => [];
  // Mirror driver status from devices hook
  useEffect(() => {
    const s = devices?.prismStatus;
    if (s) {
      setDriverStatus({ connected: !!s.connected, sample_rate: (s.channels || 0) * 0 + 48000, buffer_size: 0 });
    } else {
      setDriverStatus({ connected: false, sample_rate: 0, buffer_size: 0 });
    }
  }, [devices?.prismStatus]);

  // Note: Audio engine initialization moved to backend (.setup() in lib.rs)
  // Frontend now only handles device switching via RightPanel
  // Fallback: if devices hook has no prism apps yet, keep local fallback empty.
  useEffect(() => {
    if (devices?.prismStatus?.apps && devices.prismStatus.apps.length > 0) {
      setFallbackPrismApps([]);
    }
  }, [devices?.prismStatus?.apps]);
  const setNodes = (fn: any) => {};
  const setPluginBrowserTargetBusId = (id: string | null) => {};
  const setAvailablePlugins = (p: any[]) => {};
  const setEditingDbNodeId = (id: any) => {};
  const setEditingDbValue = (v: string) => {};
  const editingDbNodeId: any = null;
  const editingDbValue = '';
  const toggleMuteByConnId = () => {};
  const updateSendLevelByConnId = () => {};
  const faderToDb = (v: number) => v;
  const dbToFader = (v: number) => v;
  const dbToMeterPosition = (v: number) => v;
  const setMasterCanvasRef = () => {};
  const setMasterNumberRef = () => {};
  const setMixerCanvasRef = () => {};
  const updateMasterVolume = () => {};
  const setOutputVolume = () => {};
  const setEditingMasterDb = (v: boolean) => {};
  const setEditingMasterDbValue = (v: string) => {};
  const editingMasterDb = false;
  const editingMasterDbValue = '';
  const setContextMenu = () => {};
  const contextMenu: any = null;

  // CopyPrismButton removed

  return (
    <div
      className="flex flex-col h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden select-none"
    >
      {/* HEADER */}
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Workflow className="w-6 h-6 text-cyan-400" />
            <div>
              <div className="font-black text-lg tracking-tighter bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text text-transparent leading-none">Spectrum</div>
              <div className="flex items-center gap-2">
                <div className="text-[8px] text-slate-500 font-mono tracking-wider uppercase">Audio Mixer & Router</div>
              </div>
            </div>
          </div>
        </div>
        <button onClick={() => setShowSettings(true)} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors">
          <Settings className="w-5 h-5" />
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* debug overlay removed */}
        <LeftSidebar
          width={leftSidebarWidth}
          isRefreshing={isRefreshing}
          inputSourceMode={inputSourceMode}
          handleRefresh={handleRefresh}
          driverStatus={driverStatus}
          onChangeInputSourceMode={(m) => setInputSourceMode(m)}
          channelSources={channelSources}
          prismDevice={prismDevice}
          otherInputDevices={otherInputDevices}
          activeCaptures={devices?.activeCaptures || []}
          startCapture={devices?.startCapture}
          stopCapture={devices?.stopCapture}
          isLibraryItemUsed={isLibraryItemUsed}
          handleLibraryMouseDown={handleLibraryMouseDown}
          onOpenPrismApp={() => {
            openPrismApp()
              .catch(console.error)
              .finally(() => {
                if (devices?.refresh) devices.refresh().catch(console.error);
              });
          }}
        />
        <div
          className="w-1 bg-transparent hover:bg-cyan-500/50 cursor-ew-resize z-20 shrink-0 transition-colors"
          onMouseDown={(e) => handleResizeStart(
            e,
            'left',
            leftSidebarWidth,
            setLeftSidebarWidth,
            180,
            520,
            () => {
              const viewportWidth = window.innerWidth || 0;
              const minCenterWidth = 420;
              const computedMax = Math.min(520, viewportWidth - rightSidebarWidth - minCenterWidth);
              return { min: 180, max: Math.max(180, computedMax) };
            }
          )}
        />
        <div className="flex-1 relative flex flex-col">
          <CanvasView
            canvasRef={canvasRef}
            isPanning={isPanning}
            canvasTransform={canvasTransform}
            onCanvasWheel={handleCanvasWheel}
            onCanvasPanStart={handleCanvasPanStart}
          nodes={mergedNodes}
          connections={connectionsFromGraph}
          systemActiveOutputs={devices?.activeOutputs || []}
          selectedNodeId={selectedNodeId}
          selectedBusId={selectedBusId}
          focusedOutputId={focusedOutputId}
          onSelectNodeId={setSelectedNodeId}
          onSelectBusId={setSelectedBusId}
          onFocusOutputId={handleFocusOutputId}
          onConnect={async (fromNodeId: string, fromPortIdx: number, toNodeId: string, toPortIdx: number) => {
            const g = (props as any).graph;
            if (!g || typeof g.connect !== 'function') return;
            if (!fromNodeId?.startsWith('node_') || !toNodeId?.startsWith('node_')) return;
            const source = Number(fromNodeId.slice(5));
            const target = Number(toNodeId.slice(5));
            if (Number.isNaN(source) || Number.isNaN(target)) return;
            log('connect', { source, fromPortIdx, target, toPortIdx, gain: 1.0 });
            const edgeId = await g.connect(source, fromPortIdx, target, toPortIdx, 1.0);
            log('connected', { edgeId });
          }}
          onDisconnect={async (connectionId: string) => {
            const g = (props as any).graph;
            if (!g || typeof g.disconnect !== 'function') return;
            if (typeof connectionId !== 'string') return;
            if (!connectionId.startsWith('edge_')) return;
            const edgeId = Number(connectionId.slice(5));
            if (Number.isNaN(edgeId)) return;
            log('disconnect', { edgeId });
            await g.disconnect(edgeId);
            log('disconnected', { edgeId });
          }}
          onMoveNode={(id: string, x: number, y: number) => {
            // If rendering v2 nodes, update graph positions via provided graph prop
            if (id && id.startsWith('node_') && (props as any).graph) {
              const g = (props as any).graph;
              const handle = Number(id.slice(5));
              if (!Number.isNaN(handle) && g && typeof g.updateNodePosition === 'function') {
                g.updateNodePosition(handle, x, y);
                return;
              }
            }
            setPlacedNodes(prev => prev.map(n => n.id === id ? { ...n, x, y } : n));
          }}
          onDeleteNode={async (id: string) => {
            // find node to determine if it's a device-backed node
            const node = mergedNodes.find(n => n.id === id);
            // stop capture if this node represents a physical input device
            if (node && node.libraryId && node.libraryId.startsWith('dev_')) {
              const deviceId = Number(node.libraryId.slice(4));
              try {
                if (devices?.stopCapture) await devices.stopCapture(deviceId);
              } catch (e) {
                console.error('stopCapture failed', e);
              }
            }
            // remove locally
            setPlacedNodes(prev => prev.filter(n => n.id !== id));
            // if it's a backend node (id like `node_<handle>`), call graph.deleteNode if available
            if (id && id.startsWith('node_')) {
              const handle = Number(id.slice(5));
              if (!Number.isNaN(handle)) {
                try {
                  const g = (props as any).graph;
                  if (g && typeof g.deleteNode === 'function') {
                    await g.deleteNode(handle);
                  } else {
                    await removeNode(handle);
                  }
                } catch (e) {
                  console.error('removeNode failed', e);
                }
              }
            }
          }}
          />
        </div>
        <div
          className="w-1 bg-transparent hover:bg-pink-500/50 cursor-ew-resize z-20 shrink-0 transition-colors"
          onMouseDown={(e) => handleResizeStart(
            e,
            'right',
            rightSidebarWidth,
            setRightSidebarWidth,
            200,
            520,
            () => {
              const viewportWidth = window.innerWidth || 0;
              const minCenterWidth = 420;
              const computedMax = Math.min(520, viewportWidth - leftSidebarWidth - minCenterWidth);
              return { min: 200, max: Math.max(200, computedMax) };
            }
          )}
        />
        <RightPanel
          width={rightSidebarWidth}
          devices={devices}
          buses={busNodes}
          selectedBusId={selectedBusId}
          isLibraryItemUsed={isLibraryItemUsed}
          handleLibraryMouseDown={handleLibraryMouseDown}
          onAddBus={handleAddBus}
          onSelectBus={setSelectedBusId}
          onDeleteBus={handleDeleteBus}
        />
      </div>

      <div
        className="h-1 bg-transparent hover:bg-purple-500/50 cursor-ns-resize z-40 shrink-0 transition-colors"
        onMouseDown={(e) => handleResizeStart(
          e,
          'top',
          mixerHeight,
          setMixerHeight,
          350,
          520,
          () => {
            const viewportHeight = window.innerHeight || 0;
            const headerHeight = 56; // h-14
            const minCanvasHeight = 240;
            const computedMax = Math.min(520, viewportHeight - headerHeight - minCanvasHeight);
            return { min: 350, max: Math.max(350, computedMax) };
          }
        )}
      />

      <MixerPanel
        mixerHeight={mixerHeight}
        masterWidth={masterWidth}
        channelSources={channelSources}
        selectedBus={selectedBusData}
        selectedNode={selectedNodeData}
        mixerStrips={mixerStrips}
        mixerChannelMode={mixerChannelMode}
        onToggleMixerChannelMode={toggleMixerChannelMode}
        mixerTargetPortCount={mixerTargetPortCount}
        mixerSelectedChannel={mixerSelectedChannel}
        onMixerSelectedChannel={setMixerSelectedChannel}
        outputTargets={mixerOutputTargets}
        focusedOutputId={focusedOutputId}
        onFocusOutputId={handleFocusOutputId}
        focusedOutputChannel={focusedOutputChannel}
        onFocusOutputChannel={setFocusedOutputChannel}
        focusedOutputPortCount={focusedOutputPortCount}
        masterChannelMode={masterChannelMode}
        onToggleMasterChannelMode={toggleMasterChannelMode}
        masterGain={activeMasterGain}
        masterGains={activeMasterGains}
        onMasterGainChange={setActiveMasterGain}
        onMasterChannelGainChange={setActiveMasterChannelGain}
        onPluginsChange={handlePluginsChange}
        onMasterResizeStart={(e) => handleResizeStart(
          e,
          'master',
          masterWidth,
          setMasterWidth,
          240,
          520,
          () => {
            const viewportWidth = window.innerWidth || 0;
            const minMixerStripArea = 360;
            const computedMax = Math.min(520, viewportWidth - minMixerStripArea);
            return { min: 240, max: Math.max(240, computedMax) };
          }
        )}
      />
    </div>
  );
}
