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
import { addSourceNode, addSinkNode, removeNode } from '../lib/api';

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
  const _prismAppsFromStatus = devices?.prismStatus?.apps || [];
  const _prismApps: any[] = (_prismAppsFromStatus && _prismAppsFromStatus.length > 0)
    ? _prismAppsFromStatus
    : (fallbackPrismApps || []);
  const channelSources: any[] = [];
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
  const rawOtherInputDevices: any[] = (devices?.inputDevices || []).filter((d: any) => !d.isPrism);
  const otherInputDevices: any[] = rawOtherInputDevices.map((d: any) => ({
    deviceId: Number(d.deviceId ?? d.device_id ?? d.id ?? NaN),
    name: d.name ?? d.deviceName ?? d.displayName ?? 'Device',
    channelCount: d.channelCount ?? d.channels ?? d.channels_count ?? d.channelsCount ?? 2,
  }));
  const channelColors = useChannelColors(channelSources || []);
  const leftSidebarWidth = 300;
  const rightSidebarWidth = 300;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const isPanning = false;
  const canvasTransform = { x: 0, y: 0, scale: 1 };
  const connections: Connection[] = [];
  const nodes: NodeData[] = [];
  const nodesById = new Map<string, NodeData>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);
  const mixerHeight = 260;
  const masterWidth = 300;
  const [focusedOutputId, setFocusedOutputId] = useState<string | null>(null);
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

  // Nodes placed on the canvas (local UI state for visual feedback)
  const [placedNodes, setPlacedNodes] = useState<NodeData[]>([]);

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

    if (firstTargetId) setFocusedOutputId(firstTargetId);
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
        let icon = n.icon || Music;
        let color = n.color || 'text-cyan-400';
        let iconColor = n.iconColor || color;

        // Normalize fields across UINode variants from useGraph
        // - sink nodes use `sinkDeviceId` + `channelOffset`
        // - some DTO-ish shapes may use snake_case
        const channelOffset = (type === 'target')
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
            label = display.label;
            subLabel = display.subLabel;
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
          icon = display.icon;
          iconColor = display.iconColor;
        } else if (type === 'target') {
          // Sinkの表示情報
          const display = getSinkDeviceDisplay(n.label || 'Output', n.portCount || 2);
          label = display.label;
          subLabel = display.subLabel;
          icon = display.icon;
          iconColor = display.iconColor;
        } else if (type === 'bus') {
          // Busの表示情報
          const display = getBusDisplay(n.busId || 'bus_1', n.portCount || 2, n.plugins?.length || 0);
          label = n.label || display.label;
          subLabel = display.subLabel;
          icon = display.icon;
          iconColor = display.iconColor;
          color = display.iconColor;
        }

        return {
          id,
          libraryId,
          type,
          label,
          subLabel,
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

  // If an output node becomes system-disabled (greyed out), force-clear focus/selection
  // so its cables are not highlighted anymore.
  useEffect(() => {
    const allNodes = [...(nodesFromGraph || []), ...placedNodes];
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
    const allNodes = [...(nodesFromGraph || []), ...placedNodes];
    return allNodes
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
            id: p.instance_id || p.id,
            pluginId: p.plugin_id || p.pluginId,
            name: p.name,
            manufacturer: p.manufacturer || 'Unknown',
            enabled: p.enabled !== false,
          })) || [],
        };
      }
    } catch {
      // ignore
    }
    return null;
  }, [selectedBusId, graph]);

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

                // If a v2 graph is provided, use it so the graph state (and positions) are updated and reflected
                if ((props as any).graph && typeof (props as any).graph.addSource === 'function') {
                  // Optimistic UI: add a pending local node so the user sees immediate feedback
                  const pendingId = `node_pending_${Date.now()}`;
                  setPlacedNodes(prev => [...prev, {
                    id: pendingId,
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
                    channelMode: 'stereo'
                  }]);

                  try {
                    const handle = await (props as any).graph.addSource(sourceId, label, { x: canvasX, y: canvasY });
                    // graph.addSource will refresh graph state; remove pending placeholder
                    setPlacedNodes(prev => prev.filter(n => n.id !== pendingId));
                    console.debug('added node via graph.addSource', handle);
                  } catch (e) {
                    // On failure, leave pending node as fallback local visual
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
                // Fallback: still show a local visual node so UI feedback is visible
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
            // handle virtual output sinks (id like 'vout_<device>_<offset>')
            if (!sourceId && typeof id === 'string' && id.startsWith('vout_')) {
              const m = id.match(/^vout_(\d+)_(\d+)$/);
              if (m && canvasRef.current) {
                const parentDeviceId = Number(m[1]);
                const offset = Number(m[2]);
                // Lookup virtual output metadata from devices hook
                const vEntry = (devices?.virtualOutputDevices || []).find((v: any) => v.id === id);
                const nodeChannelsLocal = vEntry ? (vEntry.channels || vEntry.channelCount || 2) : (typeof nodeChannels === 'number' ? nodeChannels : 2);
                // Prefer device-specific icon + name to match RightPanel
                const nodeIconLocal = getIconForDevice(vEntry?.iconHint, vEntry?.name) || Monitor;
                const colorValueLocal = vEntry ? getColorForDevice(vEntry?.name, vEntry?.iconHint) : (typeof colorValue !== 'undefined' ? colorValue : 'text-pink-400');
                const sink = { device_id: parentDeviceId, channel_offset: offset, channel_count: nodeChannelsLocal };
                const labelText = vEntry ? vEntry.name : `Out ${offset + 1}-${offset + nodeChannelsLocal}`;
                try {
                  if ((props as any).graph && typeof (props as any).graph.addSink === 'function') {
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
                  setPlacedNodes(prev => [...prev, {
                    id: `node_local_${Date.now()}`,
                    libraryId: id,
                    type: 'target',
                    label: labelText,
                    subLabel: `${nodeChannelsLocal}ch Output`,
                    icon: nodeIconLocal,
                    color: colorValueLocal,
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
      } finally {
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', finish);
  }, [canvasRef, channelSources, otherInputDevices, devices, devices?.activeCaptures]);

  // No-op handlers to satisfy JSX bindings
  const handleRefresh = async () => { if (devices?.refresh) await devices.refresh(); };
  const handleResizeStart: any = () => {};
  const handleCanvasWheel = () => {};
  const handleCanvasPanStart = () => {};
  const deleteConnection = () => {};
  const startWire = () => {};
  const endWire = () => {};
  const handleNodeMouseDown = () => {};
  const deleteNode = () => {};
  const toggleChannelMode = () => {};
  // Use the real openPrismApp from ../lib/prismd (imported above)
  // openPrismApp is imported; call it directly where needed
  const reserveBusIdStub = async () => 'bus_1';
  // Add Bus handler
  const handleAddBus = useCallback(async () => {
    const g = (props as any).graph;
    if (!g || typeof g.addBus !== 'function') {
      console.error('[SpectrumLayout] graph.addBus not available');
      return;
    }
    // Count existing buses to name the new one
    const busCount = (nodesFromGraph || []).filter((n: any) => n.type === 'bus').length;
    const label = `Bus ${busCount + 1}`;
    try {
      const handle = await g.addBus(label, 2); // stereo bus
      console.debug('[SpectrumLayout] addBus ok', { handle, label });
    } catch (e) {
      console.error('[SpectrumLayout] addBus failed', e);
    }
  }, [props, nodesFromGraph]);
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
      onClick={() => setSelectedNodeId(null)}
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
          onOpenPrismApp={() => { if (devices?.refresh) devices.refresh().catch(console.error); }}
        />
        <div className="w-1 bg-transparent hover:bg-cyan-500/50 cursor-ew-resize z-20 shrink-0 transition-colors" />
        <div className="flex-1 relative flex flex-col">
          <CanvasView
            canvasRef={canvasRef}
            isPanning={isPanning}
            canvasTransform={canvasTransform}
          nodes={[...(nodesFromGraph || []), ...placedNodes]}
          connections={connectionsFromGraph}
          systemActiveOutputs={devices?.activeOutputs || []}
          selectedNodeId={selectedNodeId}
          selectedBusId={selectedBusId}
          focusedOutputId={focusedOutputId}
          onSelectNodeId={setSelectedNodeId}
          onSelectBusId={setSelectedBusId}
          onFocusOutputId={async (outputNodeId: string | null) => {
            if (!outputNodeId) {
              setFocusedOutputId(null);
              log('focusOutput', { outputNodeId: null });
              return;
            }

            // Do not allow focusing a system-disabled (greyed) output node.
            const allNodes = [...(nodesFromGraph || []), ...placedNodes];
            const n = allNodes.find((x: any) => x && x.id === outputNodeId);
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

            setFocusedOutputId(outputNodeId);
            log('focusOutput', { outputNodeId });
            let deviceId: number | null = null;
            if (typeof n?.deviceId === 'number' && !Number.isNaN(n.deviceId)) {
              deviceId = n.deviceId;
            } else if (typeof n?.libraryId === 'string') {
              const m = n.libraryId.match(/^vout_(\d+)_(\d+)$/);
              if (m) deviceId = Number(m[1]);
            }

            if (deviceId != null && devices?.startOutput) {
              log('startOutput', { deviceId, from: 'focusOutput' });
              try {
                await devices.startOutput(deviceId);
              } catch (e) {
                console.error('[SpectrumLayout] startOutput failed', e);
              }
            }
          }}
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
            const node = (nodesFromGraph || placedNodes).find(n => n.id === id);
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
        <div className="w-1 bg-transparent hover:bg-pink-500/50 cursor-ew-resize z-20 shrink-0 transition-colors" />
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

      <div className="h-1 bg-transparent hover:bg-purple-500/50 cursor-ns-resize z-40 shrink-0 transition-colors" />

      <MixerPanel mixerHeight={mixerHeight} masterWidth={masterWidth} channelSources={channelSources} selectedBus={selectedBusData} onPluginsChange={handlePluginsChange} />
    </div>
  );
}
