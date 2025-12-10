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
import {
  getPrismApps,
  getDriverStatus,
  getAudioDevices,
  getBusLevels,
  updateMixerSend,
  removeMixerSend,
  setOutputVolume,
  getBufferSize,
  setBufferSize,
  getAppState,
  saveAppState,
  restartApp,
  getInputDevices,
  startInputCapture,
  stopInputCapture,
  getActiveInputCaptures,
  getGraphMeters,
  reserveBusId,
  openPrismApp,
  startAudioOutput,
  stopAudioOutput,
  // Bus API
  addBus,
  removeBus as removeBusApi,
  updateBusSend,
  removeBusSend,
  // AudioUnit API
  getEffectAudioUnits,
  listAudioUnitInstances,
  createAudioUnitInstance,
  removeAudioUnitInstance,
  openAudioUnitUI,
  isAudioUnitUIOpen,
  getAudioUnitState,
  setAudioUnitState,
  setBusPlugins,
  // setRouting, // TODO: Re-enable when channel routing is implemented
  type AppSource,
  type DriverStatus,
  type AudioDevice,
  type AppState,
  type InputDeviceInfo,
  type ActiveCaptureInfo,
  type AudioUnitPluginInfo,
  type GraphMetersData,
} from '../lib/prismd';

import LeftSidebar from './LeftSidebar';
import CanvasView from './CanvasView';
import RightPanel from './RightPanel';
import MixerPanel from './MixerPanel';
import { getIconForApp } from '../hooks/useIcons';
import { useChannelColors } from '../hooks/useChannelColors';
import { renderToStaticMarkup } from 'react-dom/server';
import { addSourceNode } from '../lib/api';

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
}

export default function SpectrumLayout({ devices }: SpectrumLayoutProps) {
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
  const otherInputDevices: any[] = (devices?.inputDevices || []).filter((d: any) => !d.isPrism);
  const channelColors = useChannelColors(channelSources || []);
  const leftSidebarWidth = 300;
  const rightSidebarWidth = 300;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const isPanning = false;
  const canvasTransform = { x: 0, y: 0, scale: 1 };
  const connections: Connection[] = [];
  const nodes: NodeData[] = [];
  const nodesById = new Map<string, NodeData>();
  const selectedNodeId: string | null = null;
  const selectedBusId: string | null = null;
  const mixerHeight = 260;
  const masterWidth = 300;
  const focusedOutputId: string | null = null;
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

  // Handle drag from library items in LeftSidebar
  const handleLibraryMouseDown = useCallback((e: React.MouseEvent, type: 'lib_source' | 'lib_target', id: string) => {
    // Only support lib_source for now
    if (type !== 'lib_source') return;
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
              const dev = otherInputDevices.find((d: any) => Number(d.device_id) === deviceId) || null;
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
                const dev = otherInputDevices.find((d: any) => Number(d.deviceId ?? d.device_id) === deviceId) || null;
                subLabel = dev ? `${dev.channelCount ?? dev.channels ?? ''}ch` : '';
                nodeIcon = Mic;
                nodeChannels = dev ? (dev.channelCount ?? dev.channels ?? 2) : 2;
                var colorValue = 'text-amber-200';
              }

              try {
                const handle = await addSourceNode(sourceId, label);
                // Add a simple visual node to placedNodes
                setPlacedNodes(prev => [...prev, {
                  id: `node_${handle}`,
                  libraryId: id,
                  type: 'source',
                  label,
                  subLabel,
                  icon: nodeIcon,
                  // use computed colorValue when available
                  color: typeof colorValue !== 'undefined' ? colorValue : 'text-cyan-400',
                  x: canvasX,
                  y: canvasY,
                  volume: 1,
                  muted: false,
                  channelCount: nodeChannels,
                  channelMode: 'stereo'
                }]);
              } catch (err) {
                console.error('addSourceNode failed, falling back to local node', err);
                // Fallback: still show a local visual node so UI feedback is visible
                setPlacedNodes(prev => [...prev, {
                  id: `node_local_${Date.now()}`,
                  libraryId: id,
                  type: 'source',
                  label,
                  subLabel,
                  icon: nodeIcon,
                  color: typeof colorValue !== 'undefined' ? colorValue : 'text-cyan-400',
                  x: canvasX,
                  y: canvasY,
                  volume: 1,
                  muted: false,
                  channelCount: nodeChannels,
                  channelMode: 'stereo'
                }]);
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
  }, [canvasRef, channelSources, otherInputDevices]);

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
  const addBusStub = async () => {};
  const getActiveInputCaptures = async () => [];
  // Fetch driver status periodically (to mirror v1 behavior)
  useEffect(() => {
    let running = true;
    const poll = async () => {
      try {
        const s = await getDriverStatus();
        if (!running) return;
        setDriverStatus(s);
      } catch (e) {
        console.debug('getDriverStatus failed', e);
        setDriverStatus({ connected: false, sample_rate: 0, buffer_size: 0 });
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { running = false; clearInterval(id); };
  }, []);

  // If backend prismStatus.apps is empty, poll grouped apps periodically as a fallback
  useEffect(() => {
    let mounted = true;
    let id: NodeJS.Timeout | number | null = null;
    const poll = async () => {
      // If status provides apps, clear fallback and skip polling work
      if (devices?.prismStatus?.apps && devices.prismStatus.apps.length > 0) {
        if (mounted) setFallbackPrismApps([]);
        return;
      }
      try {
        const apps = await getPrismApps();
        if (!mounted) return;
        setFallbackPrismApps(apps || []);
      } catch (e) {
        // ignore transient errors
      }
    };
    // initial fetch
    poll();
    // poll every 2s to keep UI in sync
    id = setInterval(poll, 2000);
    return () => { mounted = false; if (id) clearInterval(id as any); };
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
    <div className="flex flex-col h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden select-none" onClick={() => {}}>
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
          isLibraryItemUsed={() => false}
          handleLibraryMouseDown={handleLibraryMouseDown}
          onOpenPrismApp={() => openPrismApp().catch(console.error)}
        />
        <div className="w-1 bg-transparent hover:bg-cyan-500/50 cursor-ew-resize z-20 shrink-0 transition-colors" />
        <CanvasView canvasRef={canvasRef} isPanning={isPanning} canvasTransform={canvasTransform} nodes={placedNodes} />
        <div className="w-1 bg-transparent hover:bg-pink-500/50 cursor-ew-resize z-20 shrink-0 transition-colors" />
        <RightPanel width={rightSidebarWidth} devices={devices} />
      </div>

      <div className="h-1 bg-transparent hover:bg-purple-500/50 cursor-ns-resize z-40 shrink-0 transition-colors" />

      <MixerPanel mixerHeight={mixerHeight} masterWidth={masterWidth} channelSources={channelSources} />
    </div>
  );
}
