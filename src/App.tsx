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
} from 'lucide-react';
import {
  getPrismApps,
  getDriverStatus,
  getAudioDevices,
  getInputLevels,
  updateMixerSend,
  removeMixerSend,
  setOutputVolume,
  getBufferSize,
  setBufferSize,
  getAppState,
  saveAppState,
  restartApp,
  // setRouting, // TODO: Re-enable when channel routing is implemented
  type AppSource,
  type DriverStatus,
  type AudioDevice,
  type LevelData,
  type AppState,
} from './lib/prismd';

// --- Types ---

type NodeType = 'source' | 'target';

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
  channelOffset?: number; // Prism channel offset (0, 2, 4, ... 62)
}

interface Connection {
  id: string;
  fromNodeId: string;
  fromChannel: number;
  toNodeId: string;
  toChannel: number;
  sendLevel: number;
  muted: boolean;
}

// --- Output Targets - will be populated from CoreAudio ---
// Now dynamically generated from actual audio devices

// --- Helper: Get icon for device type ---
function getIconForDeviceType(device: AudioDevice): React.ComponentType<{ className?: string }> {
  const name = device.name.toLowerCase();
  if (name.includes('headphone')) return Headphones;
  if (name.includes('speaker') || name.includes('built-in output')) return Speaker;
  if (name.includes('blackhole') || name.includes('loopback')) return Radio;
  if (name.includes('obs') || name.includes('stream')) return Video;
  if (device.device_type === 'virtual') return Radio;
  if (device.device_type === 'builtin') return Speaker;
  return Monitor;
}

// --- Helper: Get color for device type ---
function getColorForDeviceType(device: AudioDevice): string {
  switch (device.device_type) {
    case 'prism': return 'text-cyan-400';
    case 'virtual': return 'text-pink-400';
    case 'builtin': return 'text-green-400';
    case 'external': return 'text-amber-400';
    default: return 'text-slate-400';
  }
}

// --- Helper: Get type label ---
function getTypeLabelForDevice(device: AudioDevice): string {
  switch (device.device_type) {
    case 'prism': return 'Prism';
    case 'virtual': return 'Virtual';
    case 'builtin': return 'Built-in';
    case 'external': return 'External';
    default: return 'System';
  }
}

// --- Level Meter Helpers ---

// Convert RMS to dB, returns value in range [-60, 6] (allowing for slight over 0dB)
function rmsToDb(rms: number): number {
  if (rms <= 0.00001) return -60;
  return Math.max(-60, Math.min(6, 20 * Math.log10(rms)));
}

// Logic Pro X style fader scale (measured via pixel analysis)
// Fader labels and positions (% from bottom):
// +6=100%, +3=94%, 0=87%, -3=80%, -6=73%, -10=63%, -15=53%, -20=43%, -30=28%, -40=13%, ∞=0%

// Convert fader position (0-100) to dB (-∞ to +6)
function faderToDb(faderValue: number): number {
  // Logic Pro X fader scale (normalized: +6=100%, -∞=0%)
  // +6=100%, +3=86.9%, 0=74.3%, -3=61.2%, -6=48.5%
  // -10=39.9%, -15=29.1%, -20=20.9%, -30=12.3%, -40=8.2%, -∞=0%
  if (faderValue <= 0) return -Infinity;
  if (faderValue >= 100) return 6;

  if (faderValue >= 86.9) return 3 + ((faderValue - 86.9) / 13.1) * 3;   // 86.9-100: +3 to +6
  if (faderValue >= 74.3) return 0 + ((faderValue - 74.3) / 12.6) * 3;   // 74.3-86.9: 0 to +3
  if (faderValue >= 61.2) return -3 + ((faderValue - 61.2) / 13.1) * 3;  // 61.2-74.3: -3 to 0
  if (faderValue >= 48.5) return -6 + ((faderValue - 48.5) / 12.7) * 3;  // 48.5-61.2: -6 to -3
  if (faderValue >= 39.9) return -10 + ((faderValue - 39.9) / 8.6) * 4;  // 39.9-48.5: -10 to -6
  if (faderValue >= 29.1) return -15 + ((faderValue - 29.1) / 10.8) * 5; // 29.1-39.9: -15 to -10
  if (faderValue >= 20.9) return -20 + ((faderValue - 20.9) / 8.2) * 5;  // 20.9-29.1: -20 to -15
  if (faderValue >= 12.3) return -30 + ((faderValue - 12.3) / 8.6) * 10; // 12.3-20.9: -30 to -20
  if (faderValue >= 8.2) return -40 + ((faderValue - 8.2) / 4.1) * 10;   // 8.2-12.3: -40 to -30
  // 0-8.2: -∞ to -40
  return -40 - (60 * (1 - faderValue / 8.2));
}

// Convert dB to fader position (0-100) - inverse of faderToDb
function dbToFader(db: number): number {
  // Logic Pro X fader scale (normalized: +6=100%, -∞=0%)
  // +6=100%, +3=86.9%, 0=74.3%, -3=61.2%, -6=48.5%
  // -10=39.9%, -15=29.1%, -20=20.9%, -30=12.3%, -40=8.2%, -∞=0%
  if (!isFinite(db) || db <= -100) return 0;
  if (db >= 6) return 100;

  if (db >= 3) return 86.9 + ((db - 3) / 3) * 13.1;      // +3 to +6: 86.9-100
  if (db >= 0) return 74.3 + (db / 3) * 12.6;            // 0 to +3: 74.3-86.9
  if (db >= -3) return 61.2 + ((db + 3) / 3) * 13.1;     // -3 to 0: 61.2-74.3
  if (db >= -6) return 48.5 + ((db + 6) / 3) * 12.7;     // -6 to -3: 48.5-61.2
  if (db >= -10) return 39.9 + ((db + 10) / 4) * 8.6;    // -10 to -6: 39.9-48.5
  if (db >= -15) return 29.1 + ((db + 15) / 5) * 10.8;   // -15 to -10: 29.1-39.9
  if (db >= -20) return 20.9 + ((db + 20) / 5) * 8.2;    // -20 to -15: 20.9-29.1
  if (db >= -30) return 12.3 + ((db + 30) / 10) * 8.6;   // -30 to -20: 12.3-20.9
  if (db >= -40) return 8.2 + ((db + 40) / 10) * 4.1;    // -40 to -30: 8.2-12.3
  // Below -40: 0-8.2
  return Math.max(0, 8.2 * (1 + (db + 40) / 60));
}

// Convert dB to percentage (0-100%) for meter display
// Logic Pro X meter scale (normalized: 0dB=100%, -60dB=0%)
// Measured from meter.png via x=0 scan
// 0=100%, -3=93.3%, -6=86.6%, -9=79.9%, -12=73.5%, -15=66.8%, -18=60.1%, -21=53.4%, -24=46.6%
// -30=37.7%, -35=30.2%, -40=23.1%, -45=15.7%, -50=8.2%, -60=0%
function dbToMeterPercent(db: number): number {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;

  const m = -db; // m is positive (0 to 60)

  // 0-24dB range: ~6.7% per 3dB
  if (m <= 3) return 93.3 + ((3 - m) / 3) * 6.7;    // 0-3: 93.3-100
  if (m <= 6) return 86.6 + ((6 - m) / 3) * 6.7;    // 3-6: 86.6-93.3
  if (m <= 9) return 79.9 + ((9 - m) / 3) * 6.7;    // 6-9: 79.9-86.6
  if (m <= 12) return 73.5 + ((12 - m) / 3) * 6.4;  // 9-12: 73.5-79.9
  if (m <= 15) return 66.8 + ((15 - m) / 3) * 6.7;  // 12-15: 66.8-73.5
  if (m <= 18) return 60.1 + ((18 - m) / 3) * 6.7;  // 15-18: 60.1-66.8
  if (m <= 21) return 53.4 + ((21 - m) / 3) * 6.7;  // 18-21: 53.4-60.1
  if (m <= 24) return 46.6 + ((24 - m) / 3) * 6.8;  // 21-24: 46.6-53.4
  // 24-60dB range
  if (m <= 30) return 37.7 + ((30 - m) / 6) * 8.9;  // 24-30: 37.7-46.6
  if (m <= 35) return 30.2 + ((35 - m) / 5) * 7.5;  // 30-35: 30.2-37.7
  if (m <= 40) return 23.1 + ((40 - m) / 5) * 7.1;  // 35-40: 23.1-30.2
  if (m <= 45) return 15.7 + ((45 - m) / 5) * 7.4;  // 40-45: 15.7-23.1
  if (m <= 50) return 8.2 + ((50 - m) / 5) * 7.5;   // 45-50: 8.2-15.7
  // 50-60dB: bottom 8.2%
  return ((60 - m) / 10) * 8.2;                     // 50-60: 0-8.2
}

// Convert meter display value (0, 3, 6, ..., 60) to percentage position (100% to 0%)
// Simply use dbToMeterPercent with negated value
function dbToMeterPosition(meterValue: number): number {
  return dbToMeterPercent(-meterValue);
}

// Get gradient stops for level meter
function getMeterGradient(_level: number, db: number): string {
  // Create a multi-stop gradient based on the level
  if (db > 0) {
    return 'linear-gradient(to top, #22c55e 0%, #22c55e 60%, #eab308 70%, #f59e0b 85%, #ef4444 95%, #ef4444 100%)';
  } else if (db > -6) {
    return 'linear-gradient(to top, #22c55e 0%, #22c55e 65%, #eab308 80%, #f59e0b 100%)';
  } else if (db > -12) {
    return 'linear-gradient(to top, #22c55e 0%, #22c55e 70%, #eab308 100%)';
  }
  return 'linear-gradient(to top, #22c55e 0%, #22c55e 100%)';
}

// --- Icon helpers ---

function getIconForCategory(category: AppSource['category']): React.ComponentType<{ className?: string }> {
  switch (category) {
    case 'game': return Gamepad2;
    case 'browser': return Globe;
    case 'music': return Music;
    case 'voice': return MessageSquare;
    case 'system': return Monitor;
  }
}

export default function App() {
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);

  // Selection State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedOutputId, setFocusedOutputId] = useState<string | null>(null);
  const [focusedPairIndex, setFocusedPairIndex] = useState<number>(0); // Which stereo pair (0 = ch 1-2, 1 = ch 3-4, etc)

  // Resizable panel sizes
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(256);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(256);
  const [mixerHeight, setMixerHeight] = useState(256);
  const [masterWidth, setMasterWidth] = useState(288);

  // Wire drawing state
  const [drawingWire, setDrawingWire] = useState<{
    fromNode: string;
    fromCh: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Drag offset for cable updates during drag
  const [dragOffset, setDragOffset] = useState<{ nodeId: string; dx: number; dy: number } | null>(null);

  // Canvas pan and zoom state
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);

  // Prism daemon state
  const [prismApps, setPrismApps] = useState<AppSource[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [driverStatus, setDriverStatus] = useState<DriverStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Real-time level meters (32 stereo pairs)
  const [inputLevels, setInputLevels] = useState<LevelData[]>([]);

  // dB input editing state
  const [editingDbNodeId, setEditingDbNodeId] = useState<string | null>(null);
  const [editingDbValue, setEditingDbValue] = useState<string>('');
  const [editingMasterDb, setEditingMasterDb] = useState<boolean>(false);
  const [editingMasterDbValue, setEditingMasterDbValue] = useState<string>('');

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [bufferSize, setBufferSizeState] = useState<number>(4096);

  // Refs for performant drag
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    nodeId: string;
    startX: number;
    startY: number;
    nodeStartX: number;
    nodeStartY: number;
  } | null>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // --- Prism Daemon & Audio Device Communication ---
  const fetchPrismData = async () => {
    try {
      const [apps, status, devices] = await Promise.all([
        getPrismApps(),
        getDriverStatus(),
        getAudioDevices(),
      ]);
      setPrismApps(apps);
      setDriverStatus(status);
      // Filter to output devices only
      setAudioDevices(devices.filter(d => d.is_output));
    } catch (error) {
      console.error('Failed to fetch prism data:', error);
      setDriverStatus({ connected: false, sample_rate: 0, buffer_size: 0 });
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchPrismData();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  // Restore saved app state on mount
  useEffect(() => {
    const restoreState = async () => {
      try {
        const savedState = await getAppState();
        console.log('[Spectrum] Restoring saved state:', savedState);

        // Restore buffer size
        if (savedState.io_buffer_size) {
          setBufferSizeState(savedState.io_buffer_size);
        }

        // Note: Master fader and output routing restoration
        // happens after nodes are created from devices
      } catch (error) {
        console.error('[Spectrum] Failed to restore state:', error);
      }
    };

    restoreState();
  }, []);

  // Fetch on mount and poll every 2 seconds
  useEffect(() => {
    fetchPrismData();
    // Fetch initial buffer size
    getBufferSize().then(size => setBufferSizeState(size)).catch(console.error);
    const interval = setInterval(fetchPrismData, 2000);
    return () => clearInterval(interval);
  }, []);

  // Build current app state for saving
  const buildAppState = useCallback((): AppState => {
    // Build output routings from current nodes and connections
    const outputRoutings: Record<string, {
      device_name: string;
      sources: [number, number][];
      fader_gains: number[];
      send_gains: Record<number, number>[];
    }> = {};

    // Get focused target for master fader state
    const targetNodes = nodes.filter(n => n.type === 'target');
    const focusedTarget = targetNodes.find(n => n.id === focusedOutputId) || targetNodes[0];

    for (const target of targetNodes) {
      const deviceConnections = connections.filter(c => c.toNodeId === target.id);
      const sources: [number, number][] = [];
      const faderGains: number[] = [];

      for (const conn of deviceConnections) {
        const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
        if (sourceNode) {
          // Extract channel pair from libraryId (e.g., "prism-pair-0")
          const match = sourceNode.libraryId.match(/prism-pair-(\d+)/);
          if (match) {
            const pairIndex = parseInt(match[1], 10);
            sources.push([pairIndex * 2, pairIndex * 2 + 1]);
            faderGains.push(sourceNode.volume / 100); // Convert 0-100 to 0-1
          }
        }
      }

      if (sources.length > 0) {
        outputRoutings[target.label] = {
          device_name: target.label,
          sources,
          fader_gains: faderGains,
          send_gains: sources.map(() => ({})),
        };
      }
    }

    return {
      io_buffer_size: bufferSize,
      output_routings: outputRoutings,
      active_outputs: targetNodes.map(n => n.label),
      master_gain: focusedTarget ? focusedTarget.volume / 100 : 1.0,
      master_muted: focusedTarget ? focusedTarget.muted : false,
      patch_scroll_x: canvasTransform.x,
      patch_scroll_y: canvasTransform.y,
      patch_zoom: canvasTransform.scale,
    };
  }, [nodes, connections, bufferSize, focusedOutputId, canvasTransform]);

  // Pending restart flag
  const [pendingRestart, setPendingRestart] = useState(false);

  // Handle buffer size change - save state and prompt for restart
  const handleBufferSizeChange = async (size: number) => {
    if (size === bufferSize) return; // No change

    try {
      // First, save current app state with new buffer size
      const state = buildAppState();
      state.io_buffer_size = size;
      await saveAppState(state);

      // Set the buffer size (will be saved to config)
      await setBufferSize(size);
      setBufferSizeState(size);

      // Show restart required message
      setPendingRestart(true);

      console.log('[Spectrum] Buffer size saved, restart required:', size);
    } catch (error) {
      console.error('Failed to change buffer size:', error);
    }
  };

  // Handle app restart
  const handleRestartApp = async () => {
    try {
      await restartApp();
    } catch (error) {
      console.error('Failed to restart app:', error);
      // Fallback: try window reload (for dev mode)
      window.location.reload();
    }
  };

  // High-frequency level meter polling (~30fps)
  useEffect(() => {
    let animationFrame: number;
    let lastTime = 0;
    let errorCount = 0;

    const updateLevels = async (currentTime: number) => {
      // Throttle to ~30fps (33ms interval)
      if (currentTime - lastTime >= 33) {
        try {
          const levels = await getInputLevels();
          if (levels && levels.length > 0) {
            setInputLevels(levels);
          }
        } catch (error) {
          errorCount++;
          if (errorCount <= 3) {
            console.error('Level fetch error:', error);
          }
        }
        lastTime = currentTime;
      }
      animationFrame = requestAnimationFrame(updateLevels);
    };

    animationFrame = requestAnimationFrame(updateLevels);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  // Channel-based source type for UI (32 stereo pairs = 64 channels)
  type ChannelSource = {
    id: string;           // e.g., "ch_0" for Ch 1-2
    channelOffset: number; // 0, 2, 4, ... 62
    channelLabel: string;  // "1-2", "3-4", etc.
    apps: Array<{
      name: string;
      icon: React.ComponentType<{ className?: string }>;
      color: string;
      pid: number;
      clientCount: number;
    }>;
    hasApps: boolean;
    isMain: boolean;
  };

  // Generate 32 stereo channel pairs with app assignments
  const channelSources = useMemo((): ChannelSource[] => {
    const channels: ChannelSource[] = [];

    for (let i = 0; i < 32; i++) {
      const offset = i * 2;
      const ch1 = offset + 1;
      const ch2 = offset + 2;

      // Ch 1-2 is the MAIN (full mix) channel
      const isMain = offset === 0;

      // Find apps assigned to this channel
      const assignedApps = prismApps
        .filter(app => app.clients.some(c => c.offset === offset))
        .map(app => ({
          name: app.name,
          icon: getIconForCategory(app.category),
          color: app.color,
          pid: app.pid,
          clientCount: app.clients.filter(c => c.offset === offset).length,
        }));

      channels.push({
        id: `ch_${offset}`,
        channelOffset: offset,
        channelLabel: `${ch1}-${ch2}`,
        apps: assignedApps,
        hasApps: assignedApps.length > 0,
        isMain,
      });
    }

    return channels;
  }, [prismApps]);

  // Generate output targets from actual audio devices
  type OutputTarget = {
    id: string;
    name: string;
    type: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
    channels: number;
    deviceId: string;
  };

  const outputTargets = useMemo((): OutputTarget[] => {
    // Filter out Prism devices to prevent feedback loops (Prism→Prism routing)
    return audioDevices
      .filter(device => device.device_type !== 'prism')
      .map(device => ({
        id: `out_${device.id}`,
        name: device.name,
        type: getTypeLabelForDevice(device),
        icon: getIconForDeviceType(device),
        color: getColorForDeviceType(device),
        channels: device.output_channels,
        deviceId: device.id,
      }));
  }, [audioDevices]);

  // --- Helpers ---

  const createNode = useCallback((libraryId: string, type: NodeType, x: number, y: number): NodeData => {
    if (type === 'source') {
      // Source nodes are channel-based
      const channelData = channelSources.find(c => c.id === libraryId);
      if (channelData) {
        // Get app names for label
        const isMain = channelData.isMain;
        const appNames = isMain
          ? (channelData.apps.length > 0 ? `MAIN (${channelData.apps.length} apps)` : 'MAIN')
          : (channelData.apps.map(a => a.name).join(', ') || 'Empty');
        const icon = isMain ? Volume2 : (channelData.apps[0]?.icon || Music);
        const color = isMain ? 'text-cyan-400' : (channelData.apps[0]?.color || 'text-slate-500');

        return {
          id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          libraryId,
          type,
          label: `Ch ${channelData.channelLabel}`,
          subLabel: appNames,
          icon,
          color,
          x, y,
          volume: dbToFader(0), // 0dB = unity gain
          muted: false,
          channelCount: 2, // Always stereo pair
          channelOffset: channelData.channelOffset,
        };
      }
    }

    // Target nodes
    const targetData = outputTargets.find(t => t.id === libraryId);
    return {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      libraryId,
      type,
      label: targetData?.name || 'Unknown',
      subLabel: `${targetData?.channels}ch / ${targetData?.type}`,
      icon: targetData?.icon || Grid,
      color: targetData?.color || 'text-slate-400',
      x, y,
      volume: dbToFader(0), // 0dB = unity gain
      muted: false,
      channelCount: targetData?.channels || 2,
    };
  }, [channelSources, outputTargets]);

  // --- Initial Setup - add first output when devices are loaded ---
  const initializedRef = useRef(false);
  useEffect(() => {
    if (outputTargets.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      // Create initial nodes with first available output device
      const firstTarget = outputTargets[0];
      const t1 = createNode(firstTarget.id, 'target', 600, 100);
      setNodes([t1]);
      setConnections([]);
      setFocusedOutputId(t1.id);
      // Initialize backend with 0dB
      setOutputVolume(firstTarget.deviceId, 0);
    }
  }, [outputTargets, createNode]);

  const getPortPosition = useCallback((node: NodeData, pairIndex: number, isInput: boolean) => {
    const headerHeight = 36;
    const portHeight = 20;
    const portSpacing = 4;
    const paddingTop = 8; // p-2 = 8px
    const circleTop = 4; // top-[4px]
    const circleRadius = 6; // w-3 h-3 = 12px, radius = 6px
    const startY = node.y + headerHeight + paddingTop;
    const y = startY + (pairIndex * (portHeight + portSpacing)) + circleTop + circleRadius + 2;
    const x = isInput ? node.x : node.x + 180;

    // Apply drag offset if this node is being dragged
    if (dragOffset && dragOffset.nodeId === node.id) {
      return { x: x + dragOffset.dx, y: y + dragOffset.dy };
    }

    return { x, y };
  }, [dragOffset]);

  const isLibraryItemUsed = (id: string) => nodes.some(n => n.libraryId === id);

  // --- Actions ---

  const deleteNode = (id: string) => {
    // Find the node being deleted to determine its type
    const nodeToDelete = nodes.find(n => n.id === id);

    // Remove all backend sends for connections involving this node
    const connectionsToRemove = connections.filter(c => c.fromNodeId === id || c.toNodeId === id);
    for (const conn of connectionsToRemove) {
      const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
      const targetNode = nodes.find(n => n.id === conn.toNodeId);
      if (sourceNode && targetNode) {
        const channelOffset = sourceNode.channelOffset ?? 0;
        const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
        if (targetData) {
          removeMixerSend(channelOffset, targetData.deviceId, conn.toChannel).catch(console.error);
        }
      }
    }

    // Also stop audio output if deleting a target node
    if (nodeToDelete?.type === 'target') {
      const targetData = outputTargets.find(t => t.id === nodeToDelete.libraryId);
      if (targetData) {
        const deviceIdNum = parseInt(targetData.deviceId);
        if (!isNaN(deviceIdNum)) {
          import('./lib/prismd').then(({ stopAudioOutput }) => {
            stopAudioOutput(deviceIdNum);
          });
        }
      }
    }

    setNodes(prev => prev.filter(n => n.id !== id));
    setConnections(prev => prev.filter(c => c.fromNodeId !== id && c.toNodeId !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    if (focusedOutputId === id) setFocusedOutputId(null);
  };

  const deleteConnection = (id: string) => {
    // Find the connection to get source and target info for backend cleanup
    const conn = connections.find(c => c.id === id);
    if (conn) {
      const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
      const targetNode = nodes.find(n => n.id === conn.toNodeId);
      if (sourceNode && targetNode) {
        const channelOffset = sourceNode.channelOffset ?? 0;
        const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
        if (targetData) {
          // Remove from backend
          removeMixerSend(channelOffset, targetData.deviceId, conn.toChannel).catch(console.error);
        }
      }
    }
    setConnections(prev => prev.filter(c => c.id !== id));
  };

  const updateSendLevel = (sourceId: string, targetId: string, pairIndex: number, level: number) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex) return { ...c, sendLevel: level };
      return c;
    }));

    // Update backend
    const sourceNode = nodes.find(n => n.id === sourceId);
    const targetNode = nodes.find(n => n.id === targetId);
    if (sourceNode && targetNode) {
      const channelOffset = sourceNode.channelOffset ?? 0;
      const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
      if (targetData) {
        const conn = connections.find(c => c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex);
        updateMixerSend(channelOffset, targetData.deviceId, pairIndex, level, conn?.muted ?? false);
      }
    }
  };

  const toggleConnectionMute = (sourceId: string, targetId: string, pairIndex: number) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex) return { ...c, muted: !c.muted };
      return c;
    }));

    // Update backend
    const sourceNode = nodes.find(n => n.id === sourceId);
    const targetNode = nodes.find(n => n.id === targetId);
    if (sourceNode && targetNode) {
      const channelOffset = sourceNode.channelOffset ?? 0;
      const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
      if (targetData) {
        const conn = connections.find(c => c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex);
        if (conn) {
          updateMixerSend(channelOffset, targetData.deviceId, pairIndex, conn.sendLevel, !conn.muted);
        }
      }
    }
  };

  const updateMasterVolume = (nodeId: string, val: number) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, volume: val } : n));
  };

  // --- D&D Handlers (Library items) - Using mouse events instead of native D&D ---

  const [libraryDrag, setLibraryDrag] = useState<{
    type: 'lib_source' | 'lib_target';
    id: string;
    x: number;
    y: number;
  } | null>(null);

  const handleLibraryMouseDown = useCallback((e: React.MouseEvent, type: 'lib_source' | 'lib_target', id: string) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;

    setLibraryDrag({ type, id, x: startX, y: startY });
    document.body.style.cursor = 'grabbing';

    const handleMouseMove = (ev: MouseEvent) => {
      setLibraryDrag(prev => prev ? { ...prev, x: ev.clientX, y: ev.clientY } : null);
    };

    const handleMouseUp = (ev: MouseEvent) => {
      // Check if dropped on canvas
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right &&
          ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
        // Convert screen coords to canvas coords (accounting for pan & zoom)
        // Offset so node center is at cursor position (node width=180, estimated height ~60)
        const screenX = ev.clientX - rect.left;
        const screenY = ev.clientY - rect.top;
        const canvasX = (screenX - canvasTransform.x) / canvasTransform.scale - 90;
        const canvasY = (screenY - canvasTransform.y) / canvasTransform.scale - 40;

        const nodeType: NodeType = type === 'lib_source' ? 'source' : 'target';
        const newNode = createNode(id, nodeType, canvasX, canvasY);
        setNodes(prev => [...prev, newNode]);

        if (nodeType === 'target') {
          setFocusedOutputId(newNode.id);
          // Initialize backend with 0dB for new output device
          const targetData = outputTargets.find(t => t.id === id);
          if (targetData) {
            setOutputVolume(targetData.deviceId, 0);
          }
        }
      }

      setLibraryDrag(null);
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [canvasTransform, createNode]);

  // --- Node Dragging (DOM-based, no state during drag) ---

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;

    const { nodeId, startX, startY } = dragRef.current;
    // Convert screen delta to canvas delta (accounting for zoom)
    const dx = (e.clientX - startX) / canvasTransform.scale;
    const dy = (e.clientY - startY) / canvasTransform.scale;

    const nodeEl = nodeRefs.current.get(nodeId);
    if (nodeEl) {
      nodeEl.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    // Update drag offset for cable rendering
    setDragOffset({ nodeId, dx, dy });
  }, [canvasTransform.scale]);

  const handleDragEnd = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;

    const { nodeId, startX, startY, nodeStartX, nodeStartY } = dragRef.current;
    // Convert screen delta to canvas delta (accounting for zoom)
    const dx = (e.clientX - startX) / canvasTransform.scale;
    const dy = (e.clientY - startY) / canvasTransform.scale;

    // Reset transform and update state once
    const nodeEl = nodeRefs.current.get(nodeId);
    if (nodeEl) {
      nodeEl.style.transform = '';
    }

    // Clear drag offset
    setDragOffset(null);

    setNodes(prev => prev.map(n =>
      n.id === nodeId
        ? { ...n, x: nodeStartX + dx, y: nodeStartY + dy }
        : n
    ));

    dragRef.current = null;
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  }, [handleDragMove, canvasTransform.scale]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    // Don't interfere with native drag events from library items
    if ((e.target as HTMLElement).closest('[draggable="true"]') && !nodeRefs.current.has(nodeId)) {
      return;
    }

    e.stopPropagation();
    e.preventDefault();

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    setSelectedNodeId(nodeId);
    if (node.type === 'target') setFocusedOutputId(node.id);

    dragRef.current = {
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      nodeStartX: node.x,
      nodeStartY: node.y,
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  }, [nodes, handleDragMove, handleDragEnd]);

  // --- Canvas Pan & Zoom ---

  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Pinch gesture (ctrlKey is set on trackpad pinch)
    if (e.ctrlKey) {
      // Zoom with pinch - use smaller factor for smoother zoom
      const zoomIntensity = 0.01;
      const zoomFactor = 1 - e.deltaY * zoomIntensity;
      const newScale = Math.min(Math.max(canvasTransform.scale * zoomFactor, 0.25), 3);

      // Adjust pan to zoom toward mouse position
      const scaleChange = newScale / canvasTransform.scale;
      const newX = mouseX - (mouseX - canvasTransform.x) * scaleChange;
      const newY = mouseY - (mouseY - canvasTransform.y) * scaleChange;

      setCanvasTransform({ x: newX, y: newY, scale: newScale });
    } else {
      // Two-finger scroll for panning (like Chrome)
      setCanvasTransform(prev => ({
        ...prev,
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      }));
    }
  }, [canvasTransform]);

  const handleCanvasPanStart = useCallback((e: React.MouseEvent) => {
    // Only start pan if clicking on empty canvas (not on nodes)
    if ((e.target as HTMLElement).closest('.canvas-node')) return;
    if (e.button !== 0) return; // Left click only

    e.preventDefault();
    setIsPanning(true);
    panStart.current = {
      x: e.clientX,
      y: e.clientY,
      canvasX: canvasTransform.x,
      canvasY: canvasTransform.y,
    };

    const handlePanMove = (ev: MouseEvent) => {
      if (!panStart.current) return;
      const dx = ev.clientX - panStart.current.x;
      const dy = ev.clientY - panStart.current.y;
      setCanvasTransform(prev => ({
        ...prev,
        x: panStart.current!.canvasX + dx,
        y: panStart.current!.canvasY + dy,
      }));
    };

    const handlePanEnd = () => {
      setIsPanning(false);
      panStart.current = null;
      document.removeEventListener('mousemove', handlePanMove);
      document.removeEventListener('mouseup', handlePanEnd);
    };

    document.addEventListener('mousemove', handlePanMove);
    document.addEventListener('mouseup', handlePanEnd);
  }, [canvasTransform]);

  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [handleDragMove, handleDragEnd]);

  // --- Panel Resize Handlers ---

  const handleResizeStart = useCallback((
    e: React.MouseEvent,
    direction: 'left' | 'right' | 'top' | 'master',
    currentValue: number,
    setter: (value: number) => void,
    minValue: number,
    maxValue: number
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const startPos = direction === 'top' ? e.clientY : e.clientX;
    const startValue = currentValue;

    const handleMove = (ev: MouseEvent) => {
      const currentPos = direction === 'top' ? ev.clientY : ev.clientX;
      let delta = currentPos - startPos;

      // Invert delta for right sidebar, master, and top (mixer)
      if (direction === 'right' || direction === 'top' || direction === 'master') {
        delta = -delta;
      }

      const newValue = Math.min(maxValue, Math.max(minValue, startValue + delta));
      setter(newValue);
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

  // --- Wire Drawing ---

  // Convert screen coordinates to canvas local coordinates (accounting for pan & zoom)
  const screenToCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };

    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;

    // Reverse the transform: subtract pan, then divide by scale
    const canvasX = (screenX - canvasTransform.x) / canvasTransform.scale;
    const canvasY = (screenY - canvasTransform.y) / canvasTransform.scale;

    return { x: canvasX, y: canvasY };
  }, [canvasTransform]);

  const startWire = useCallback((e: React.MouseEvent, nodeId: string, channelIndex: number) => {
    e.stopPropagation();
    e.preventDefault();

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const pos = getPortPosition(node, channelIndex, false);
    const mousePos = screenToCanvas(e.clientX, e.clientY);

    setDrawingWire({
      fromNode: nodeId,
      fromCh: channelIndex,
      startX: pos.x,
      startY: pos.y,
      currentX: mousePos.x,
      currentY: mousePos.y,
    });

    const handleWireMove = (ev: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Need to get current transform state
      setDrawingWire(prev => {
        if (!prev) return null;
        const screenX = ev.clientX - rect.left;
        const screenY = ev.clientY - rect.top;
        return {
          ...prev,
          currentX: screenX,
          currentY: screenY,
          // Store screen coords, we'll convert in render
        };
      });
    };

    const handleWireEnd = () => {
      setDrawingWire(null);
      document.removeEventListener('mousemove', handleWireMove);
      document.removeEventListener('mouseup', handleWireEnd);
    };

    document.addEventListener('mousemove', handleWireMove);
    document.addEventListener('mouseup', handleWireEnd);
  }, [nodes, screenToCanvas]);

  const endWire = useCallback((e: React.MouseEvent, nodeId: string, channelIndex: number) => {
    e.stopPropagation();
    if (drawingWire) {
      const exists = connections.some(c =>
        c.fromNodeId === drawingWire.fromNode &&
        c.fromChannel === drawingWire.fromCh &&
        c.toNodeId === nodeId &&
        c.toChannel === channelIndex
      );

      if (!exists && drawingWire.fromNode !== nodeId) {
        // Find the source node to get channel offset
        const sourceNode = nodes.find(n => n.id === drawingWire.fromNode);

        // Check if target is Prism device - prevent Prism→Prism routing (causes feedback loop)
        const targetNode = nodes.find(n => n.id === nodeId);
        const targetData = targetNode ? outputTargets.find(t => t.id === targetNode.libraryId) : null;
        const targetDeviceInfo = targetData ? audioDevices.find(d => d.id === targetData.deviceId) : null;

        if (targetDeviceInfo?.device_type === 'prism') {
          console.warn('Cannot route to Prism device - would cause feedback loop');
          setDrawingWire(null);
          return;
        }

        // Calculate channel offset based on target channel pair
        // Each pair is 2 channels, so pair 0 = offset 0, pair 1 = offset 2, etc.
        const targetChannelOffset = channelIndex * 2;

        // TODO: Implement channel-to-channel routing
        // For now, log the routing attempt
        if (sourceNode?.channelOffset !== undefined) {
          console.log(`Route from channel ${sourceNode.channelOffset} to channel ${targetChannelOffset}`);

          // Start output to the target device and update mixer send
          const targetNode = nodes.find(n => n.id === nodeId);
          if (targetNode) {
            const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
            if (targetData) {
              // Start audio output to this device
              const deviceIdNum = parseInt(targetData.deviceId);
              if (!isNaN(deviceIdNum)) {
                import('./lib/prismd').then(({ startAudioOutput }) => {
                  startAudioOutput(deviceIdNum).catch(console.error);
                });
              }

              // Update mixer send
              updateMixerSend(
                sourceNode.channelOffset,
                targetData.deviceId,
                channelIndex,
                80, // Default send level
                false // Not muted
              );
            }
          }
        }

        setConnections(prev => [...prev, {
          id: `c_${Date.now()}`,
          fromNodeId: drawingWire.fromNode,
          fromChannel: drawingWire.fromCh,
          toNodeId: nodeId,
          toChannel: channelIndex,
          sendLevel: dbToFader(0), // 0dB = unity gain
          muted: false
        }]);
      }
      setDrawingWire(null);
    }
  }, [drawingWire, connections, nodes, audioDevices, outputTargets]);

  const activeTargets = nodes.filter(n => n.type === 'target');
  const focusedTarget = nodes.find(n => n.id === focusedOutputId);

  // Calculate stereo pairs for focused target
  const focusedTargetPairs = focusedTarget
    ? Math.ceil(focusedTarget.channelCount / 2)
    : 0;

  // Filter connections to only show sources connected to the selected pair
  const mixSourceIds = Array.from(new Set(connections
    .filter(c => c.toNodeId === focusedOutputId && c.toChannel === focusedPairIndex)
    .map(c => c.fromNodeId)));
  const mixSources = nodes.filter(n => n.type === 'source' && mixSourceIds.includes(n.id));

  // Helper to get stereo pair label (1-2, 3-4, etc.)
  const getPairLabel = (pairIndex: number) => {
    const ch1 = pairIndex * 2 + 1;
    const ch2 = pairIndex * 2 + 2;
    return `${ch1}-${ch2}`;
  };

  return (
    <div className="flex flex-col h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden select-none"
         onClick={() => setSelectedNodeId(null)}
    >

      {/* HEADER */}
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-6">
          <div className="font-black text-xl tracking-tighter bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text text-transparent flex items-center gap-2">
            <Workflow className="w-6 h-6 text-cyan-400" /> Spectrum
          </div>
          <div className="h-6 w-px bg-slate-800"></div>
          <div className="flex items-center gap-2 text-[10px] text-slate-500 bg-slate-950 px-3 py-1.5 rounded-full border border-slate-800">
            <span className="w-2 h-2 rounded-full bg-fuchsia-500 animate-pulse"></span>
            PRISM ENGINE ACTIVE
          </div>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
        >
          <Settings className="w-5 h-5" />
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">

        {/* LEFT SIDEBAR: SOURCES LIBRARY */}
        <div
          className="bg-[#111827] border-r border-slate-800 flex flex-col shrink-0 z-10 shadow-xl relative"
          style={{ width: leftSidebarWidth }}
          onClick={e => e.stopPropagation()}
        >
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2">
              <LogOut className="w-3 h-3" /> Prism Channels
              {/* Connection status indicator */}
              {driverStatus && (
                <span className={`ml-auto flex items-center gap-1 ${driverStatus.connected ? 'text-green-400' : 'text-red-400'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${driverStatus.connected ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="text-[9px]">{driverStatus.connected ? 'Connected' : 'Disconnected'}</span>
                </span>
              )}
              <button
                onClick={handleRefresh}
                className="ml-1 p-1 hover:bg-slate-700 rounded transition-colors"
                title="Refresh"
              >
                <RefreshCw className={`w-3 h-3 text-slate-400 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
              <input type="text" placeholder="Channels..." className="w-full bg-slate-950 border border-slate-700 rounded-md py-1.5 pl-9 pr-3 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {channelSources.map(channel => {
              const isUsed = isLibraryItemUsed(channel.id);
              const hasApps = channel.hasApps;
              const FirstIcon = channel.apps[0]?.icon || Music;

              // Get real level data for this channel
              const pairIndex = channel.channelOffset / 2;
              const levelData = inputLevels[pairIndex];
              // Convert RMS to dB using helper functions
              const leftDb = levelData ? rmsToDb(levelData.left_rms) : -60;
              const rightDb = levelData ? rmsToDb(levelData.right_rms) : -60;
              const maxDb = Math.max(leftDb, rightDb);
              const avgLevel = dbToMeterPercent(maxDb);

              // Get color based on level
              const meterColorClass = maxDb > 0 ? 'from-red-500/30' :
                                      maxDb > -6 ? 'from-amber-500/25' :
                                      maxDb > -12 ? 'from-yellow-500/20' :
                                      'from-green-500/20';

              return (
                <div
                  key={channel.id}
                  onMouseDown={!isUsed ? (e) => handleLibraryMouseDown(e, 'lib_source', channel.id) : undefined}
                  className={`
                    group flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all relative overflow-hidden
                    ${isUsed
                      ? 'border-transparent bg-slate-900/30 opacity-40 cursor-default'
                      : hasApps
                        ? 'border-slate-700/50 bg-slate-800/60 hover:border-cyan-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing'
                        : 'border-transparent bg-slate-900/20 hover:border-slate-700/50 hover:bg-slate-900/40 cursor-grab active:cursor-grabbing'}
                  `}
                >
                  {/* Level meter bar (background) with color based on level */}
                  <div
                    className={`absolute left-0 top-0 bottom-0 bg-gradient-to-r ${meterColorClass} to-transparent rounded-lg transition-all duration-75 pointer-events-none`}
                    style={{ width: `${Math.min(avgLevel, 100)}%` }}
                  />

                  {/* Channel number */}
                  <div className={`w-10 text-[10px] font-mono font-bold ${hasApps ? 'text-cyan-400' : 'text-slate-600'} relative z-10`}>
                    {channel.channelLabel}
                  </div>

                  {/* App info */}
                  {channel.isMain ? (
                    // MAIN channel - show icon and app count
                    <div className="flex-1 flex items-center gap-2 min-w-0 relative z-10">
                      <div className="w-5 h-5 rounded flex items-center justify-center bg-cyan-900/50 text-cyan-400">
                        <Volume2 className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-cyan-300">MAIN</div>
                        {channel.apps.length > 0 && (
                          <div className="text-[8px] text-slate-500">{channel.apps.length} apps</div>
                        )}
                      </div>
                    </div>
                  ) : hasApps ? (
                    <div className="flex-1 flex items-center gap-2 min-w-0 relative z-10">
                      <div className={`w-5 h-5 rounded flex items-center justify-center bg-slate-950 ${channel.apps[0].color}`}>
                        <FirstIcon className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-slate-300 truncate">
                          {channel.apps.map(a => a.name).join(', ')}
                        </div>
                        {channel.apps.length > 1 && (
                          <div className="text-[8px] text-slate-500">{channel.apps.length} apps</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 text-[10px] text-slate-600 italic relative z-10">Empty</div>
                  )}

                  {!isUsed && <Plus className="w-3 h-3 text-slate-700 group-hover:text-cyan-400 transition-colors opacity-0 group-hover:opacity-100 relative z-10" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* LEFT RESIZE HANDLE */}
        <div
          className="w-1 bg-transparent hover:bg-cyan-500/50 cursor-ew-resize z-20 shrink-0 transition-colors"
          onMouseDown={(e) => handleResizeStart(e, 'left', leftSidebarWidth, setLeftSidebarWidth, 180, 400)}
        />

        {/* CENTER: PATCH CANVAS */}
        <div
          ref={canvasRef}
          className={`flex-1 bg-[#0b1120] relative overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}
          onWheel={handleCanvasWheel}
          onMouseDown={handleCanvasPanStart}
        >
          {/* Transformable Canvas Content */}
          <div
            className="absolute inset-0 origin-top-left"
            style={{
              transform: `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})`,
            }}
          >
            {/* Grid */}
            <div
              className="absolute pointer-events-none opacity-20"
              style={{
                backgroundImage: 'radial-gradient(#475569 1px, transparent 1px)',
                backgroundSize: '24px 24px',
                width: '4000px',
                height: '4000px',
                left: '-2000px',
                top: '-2000px',
              }}
            ></div>

            {/* Connection Lines */}
            <svg className="absolute pointer-events-none z-0" style={{ width: '4000px', height: '4000px', left: '-2000px', top: '-2000px', overflow: 'visible' }}>
              <g transform="translate(2000, 2000)">
                {connections.map(conn => {
                  const start = nodes.find(n => n.id === conn.fromNodeId);
                  const end = nodes.find(n => n.id === conn.toNodeId);
                  if (!start || !end) return null;

                  const startPos = getPortPosition(start, conn.fromChannel, false);
                  const endPos = getPortPosition(end, conn.toChannel, true);

                  const isActive = end.id === focusedOutputId;
                  const strokeColor = isActive ? (end.color.includes('cyan') ? '#22d3ee' : '#f472b6') : '#475569';

                  const path = `M ${startPos.x} ${startPos.y} C ${startPos.x + 50} ${startPos.y}, ${endPos.x - 50} ${endPos.y}, ${endPos.x} ${endPos.y}`;

                  return (
                    <g key={conn.id} className="pointer-events-auto group cursor-pointer" onClick={(e) => { e.stopPropagation(); deleteConnection(conn.id); }}>
                      <path d={path} fill="none" stroke="transparent" strokeWidth="10" />
                      <path d={path} fill="none" stroke={strokeColor} strokeWidth={isActive ? 2 : 1} className="group-hover:stroke-red-400" />
                      {isActive && (
                        <circle r="3" fill="#fff" opacity="0.8">
                          <animateMotion dur="2s" repeatCount="indefinite" path={path} />
                        </circle>
                      )}
                    </g>
                  );
                })}

                {drawingWire && (() => {
                    // Convert screen coords to canvas coords for the current mouse position
                    const currentCanvasX = (drawingWire.currentX - canvasTransform.x) / canvasTransform.scale;
                    const currentCanvasY = (drawingWire.currentY - canvasTransform.y) / canvasTransform.scale;
                    return (
                        <path
                            d={`M ${drawingWire.startX} ${drawingWire.startY} C ${drawingWire.startX + 50} ${drawingWire.startY}, ${currentCanvasX - 50} ${currentCanvasY}, ${currentCanvasX} ${currentCanvasY}`}
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2"
                            strokeDasharray="4,4"
                        />
                    );
                })()}
              </g>
            </svg>

            {/* Nodes */}
            {nodes.map(node => {
              // For source nodes, get dynamic info from channelSources
              const channelData = node.type === 'source' ? channelSources.find(c => c.id === node.libraryId) : null;
              const dynamicLabel = channelData ? `Ch ${channelData.channelLabel}` : node.label;
              const dynamicSubLabel = channelData
                ? (channelData.isMain
                    ? (channelData.apps.length > 0 ? `MAIN (${channelData.apps.length} apps)` : 'MAIN')
                    : (channelData.apps.map(a => a.name).join(', ') || 'Empty'))
                : node.subLabel;
              const dynamicIcon = channelData
                ? (channelData.isMain ? Volume2 : (channelData.apps[0]?.icon || Music))
                : node.icon;
              const dynamicColor = channelData
                ? (channelData.isMain ? 'text-cyan-400' : (channelData.apps[0]?.color || 'text-slate-500'))
                : node.color;
              const NodeIcon = dynamicIcon;

              // Get level data for source nodes
              const pairIndex = channelData ? channelData.channelOffset / 2 : 0;
              const levelData = node.type === 'source' ? inputLevels[pairIndex] : null;
              const leftDb = levelData ? rmsToDb(levelData.left_rms) : -60;
              const rightDb = levelData ? rmsToDb(levelData.right_rms) : -60;
              const maxDb = Math.max(leftDb, rightDb);
              const avgLevel = dbToMeterPercent(maxDb);
              const meterColorClass = maxDb > 0 ? 'from-red-500/30' :
                                      maxDb > -6 ? 'from-amber-500/25' :
                                      maxDb > -12 ? 'from-yellow-500/20' :
                                      'from-green-500/20';

              const isSelected = selectedNodeId === node.id;
              const isFocused = focusedOutputId === node.id;
              const pairCount = Math.ceil(node.channelCount / 2);
              const nodeHeight = 36 + 16 + (pairCount * 24);

              let borderClass = 'border-slate-700';
              if (node.type === 'source') borderClass = 'border-cyan-500/30 hover:border-cyan-500';
              if (node.type === 'target') borderClass = isFocused ? 'border-pink-500 ring-2 ring-pink-500/20' : 'border-pink-500/30 hover:border-pink-500';
              if (isSelected) borderClass = 'border-white ring-2 ring-white/20';

              return (
                <div
                  key={node.id}
                  ref={el => { if (el) nodeRefs.current.set(node.id, el); }}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  className={`canvas-node absolute w-[180px] bg-slate-800 rounded-lg shadow-xl border-2 group z-10 will-change-transform ${borderClass}`}
                  style={{ left: node.x, top: node.y, height: nodeHeight }}
                >
                {/* Header with level meter for source nodes */}
                <div className="h-9 bg-slate-900/50 rounded-t-lg border-b border-slate-700/50 flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing relative overflow-hidden">
                  {/* Level meter background for source nodes */}
                  {node.type === 'source' && (
                    <div
                      className={`absolute left-0 top-0 bottom-0 bg-gradient-to-r ${meterColorClass} to-transparent transition-all duration-75 pointer-events-none`}
                      style={{ width: `${Math.min(avgLevel, 100)}%` }}
                    />
                  )}
                  <div className={`w-2 h-2 rounded-full ${dynamicColor} shadow-[0_0_8px_currentColor] relative z-10`}></div>
                  <NodeIcon className={`w-4 h-4 ${dynamicColor} relative z-10`} />
                  <div className="flex-1 min-w-0 relative z-10">
                    <span className="text-xs font-bold text-slate-200 truncate block">
                      {node.type === 'source' ? dynamicSubLabel : node.label}
                    </span>
                    {node.type === 'source' && (
                      <span className="text-[9px] text-slate-500 truncate block">{dynamicLabel}</span>
                    )}
                  </div>
                  <button onClick={(e) => {e.stopPropagation(); deleteNode(node.id)}} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity relative z-10"><Trash2 className="w-3 h-3"/></button>
                </div>

                {/* Ports Body - Stereo Pairs */}
                <div className="p-2 space-y-1 relative">
                    {Array.from({length: pairCount}).map((_, pairIdx) => {
                        const ch1 = pairIdx * 2 + 1;
                        const ch2 = pairIdx * 2 + 2;
                        const isLastOdd = node.channelCount % 2 === 1 && pairIdx === pairCount - 1;
                        const label = isLastOdd ? `CH ${ch1}` : `CH ${ch1}-${ch2}`;

                        return (
                            <div key={pairIdx} className="flex items-center justify-between h-5 relative">
                                {/* Input Port (Target Only) */}
                                <div className="w-3 relative h-full flex items-center">
                                    {node.type === 'target' && (
                                        <div
                                            className="absolute -left-[15px] w-3 h-3 bg-slate-600 rounded-full border border-slate-400 hover:scale-125 cursor-crosshair z-20 top-[4px]"
                                            onMouseUp={(e) => endWire(e, node.id, pairIdx)}
                                        ></div>
                                    )}
                                </div>

                                <div className="text-[9px] text-slate-500 font-mono flex-1 text-center">{label}</div>

                                {/* Output Port (Source Only) */}
                                <div className="w-3 relative h-full flex items-center">
                                    {node.type === 'source' && (
                                        <div
                                            className="absolute -right-[15px] w-3 h-3 bg-slate-600 rounded-full border border-slate-400 hover:bg-white cursor-crosshair z-20 top-[4px]"
                                            onMouseDown={(e) => startWire(e, node.id, pairIdx)}
                                        ></div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
              </div>
            );
          })}
          </div>
        </div>

        {/* RIGHT RESIZE HANDLE */}
        <div
          className="w-1 bg-transparent hover:bg-pink-500/50 cursor-ew-resize z-20 shrink-0 transition-colors"
          onMouseDown={(e) => handleResizeStart(e, 'right', rightSidebarWidth, setRightSidebarWidth, 180, 400)}
        />

        {/* RIGHT SIDEBAR: OUTPUTS LIBRARY */}
        <div
          className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 z-10 shadow-xl relative"
          style={{ width: rightSidebarWidth }}
          onClick={e => e.stopPropagation()}
        >
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              <LinkIcon className="w-3 h-3" /> Output Devices
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {outputTargets.length === 0 ? (
              <div className="text-center py-8 text-slate-600 text-xs">
                No output devices found
              </div>
            ) : outputTargets.map(item => {
              const isUsed = nodes.some(n => n.libraryId === item.id);
              const ItemIcon = item.icon;
              return (
                <div
                  key={item.id}
                  onMouseDown={!isUsed ? (e) => handleLibraryMouseDown(e, 'lib_target', item.id) : undefined}
                  className={`
                    group flex items-center gap-3 p-3 rounded-xl border transition-all
                    ${isUsed
                      ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-default grayscale'
                      : 'border-slate-700 bg-slate-800/80 hover:border-pink-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing hover:shadow-md'}
                  `}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center bg-slate-950 ${item.color}`}>
                    <ItemIcon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-200 truncate">{item.name}</div>
                    <div className="text-[9px] text-slate-500 uppercase">{item.channels}ch • {item.type}</div>
                  </div>
                  {!isUsed && <Plus className="w-4 h-4 text-slate-600 group-hover:text-pink-400 transition-colors" />}
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* MIXER RESIZE HANDLE */}
      <div
        className="h-1 bg-transparent hover:bg-purple-500/50 cursor-ns-resize z-40 shrink-0 transition-colors"
        onMouseDown={(e) => handleResizeStart(e, 'top', mixerHeight, setMixerHeight, 150, 400)}
      />

      {/* BOTTOM: INTEGRATED MIXER & MASTER CONTROL */}
      <div
        className="bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30"
        style={{ height: mixerHeight }}
      >

        {/* MIXER AREA (LEFT) */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#162032]">
          <div className="h-8 bg-slate-900/50 border-b border-slate-800 flex items-center px-4 justify-between shrink-0">
            <div className="flex items-center gap-3">
              <Maximize2 className="w-3 h-3 text-slate-500" />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {focusedTarget ? (
                  <>Mixing for <span className={`text-white ${focusedTarget.color} ml-1`}>{focusedTarget.label}</span>
                    {focusedTargetPairs > 1 && (
                      <span className="text-slate-400 ml-1">Ch {getPairLabel(focusedPairIndex)}</span>
                    )}
                  </>
                ) : (
                  'Select Output on Canvas to Mix'
                )}
              </span>
            </div>
          </div>

          <div className="flex-1 flex overflow-x-auto p-4 gap-2 items-stretch">
            {mixSources.map(node => {
                const conn = connections.find(c => c.fromNodeId === node.id && c.toNodeId === focusedOutputId && c.toChannel === focusedPairIndex);
                const level = conn ? conn.sendLevel : 0;
                const isMuted = conn ? conn.muted : false;

                // Get dynamic info from channelSources
                const channelData = channelSources.find(c => c.id === node.libraryId);
                const dynamicLabel = channelData ? `Ch ${channelData.channelLabel}` : node.label;
                const dynamicSubLabel = channelData
                  ? (channelData.isMain
                      ? (channelData.apps.length > 0 ? `MAIN (${channelData.apps.length} apps)` : 'MAIN')
                      : (channelData.apps.map(a => a.name).join(', ') || 'Empty'))
                  : node.subLabel;
                const dynamicIcon = channelData
                  ? (channelData.isMain ? Volume2 : (channelData.apps[0]?.icon || Music))
                  : node.icon;
                const dynamicColor = channelData
                  ? (channelData.isMain ? 'text-cyan-400' : (channelData.apps[0]?.color || 'text-slate-500'))
                  : node.color;
                const NodeIcon = dynamicIcon;

                // Get real input levels for this channel (dB conversion)
                const channelOffset = node.channelOffset ?? 0;
                const pairIndex = channelOffset / 2;
                const levelData = inputLevels[pairIndex];

                // Calculate dB using PEAK (not RMS) for meter display - like Logic/LadioCast
                const leftDb = levelData ? rmsToDb(levelData.left_peak) : -60;
                const rightDb = levelData ? rmsToDb(levelData.right_peak) : -60;

                // Calculate post-fader level (input dB + fader gain dB)
                const faderDb = faderToDb(level);
                const postFaderLeftDb = faderDb <= -100 ? -Infinity : leftDb + faderDb;
                const postFaderRightDb = faderDb <= -100 ? -Infinity : rightDb + faderDb;

                return (
                <div key={node.id} className="w-32 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none">
                    <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
                    <div className={`w-6 h-6 rounded-lg bg-slate-800 border border-slate-600 flex items-center justify-center shadow-lg ${dynamicColor}`}>
                        <NodeIcon className="w-3 h-3" />
                    </div>
                    </div>
                    <div className="w-full px-1 text-center mb-2">
                    <div className="text-[7px] text-slate-500 font-mono">{dynamicLabel}</div>
                    <div className="text-[9px] font-bold truncate text-slate-300">{dynamicSubLabel || 'Empty'}</div>
                    </div>
                    <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
                    {/* Fader with scale on left */}
                    <div className="relative mr-2">
                      {/* Left: Fader Scale (+6dB = top) - matches Logic Pro X */}
                      <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none">
                        {/* Scale tick marks and labels - clickable */}
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ top: '0', transform: 'translateY(-50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(6))}>
                          <span className="mr-0.5">+6</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(3)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(3))}>
                          <span className="mr-0.5">+3</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-cyan-400" style={{ bottom: `${dbToFader(0)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(0))}>
                          <span className="mr-0.5 text-white font-bold">0</span>
                          <div className="w-2.5 h-px bg-white"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-3)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-3))}>
                          <span className="mr-0.5">-3</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-6)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-6))}>
                          <span className="mr-0.5">-6</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-10)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-10))}>
                          <span className="mr-0.5 text-[6px]">-10</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-15)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-15))}>
                          <span className="mr-0.5 text-[6px]">-15</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-20)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-20))}>
                          <span className="mr-0.5 text-[6px]">-20</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-30)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-30))}>
                          <span className="mr-0.5 text-[6px]">-30</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-40)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(-40))}>
                          <span className="mr-0.5 text-[6px]">-40</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: '0', transform: 'translateY(50%)' }} onClick={() => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, 0)}>
                          <span className="mr-0.5">-∞</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                      </div>
                      <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                          <input
                              type="range" min="0" max="100" value={level} disabled={isMuted}
                              onChange={(e) => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, Number(e.target.value))}
                              className={`absolute inset-0 h-full w-6 -left-2 opacity-0 z-20 appearance-slider-vertical ${isMuted ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                          />
                          <div className={`absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10 ${isMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${level}% - 5px)` }}></div>
                      </div>
                    </div>
                    {/* Level Meters on right */}
                    <div className="flex gap-0.5 relative">
                      {/* Left meter */}
                      <div className="w-2 h-full bg-slate-950 rounded-sm overflow-hidden relative border border-slate-800">
                        {/* Meter fill - post-fader level, capped at 0dB (100%) */}
                        <div
                          className="absolute bottom-0 w-full transition-all duration-75"
                          style={{
                            height: isMuted ? '0%' : `${Math.min(100, Math.max(0, dbToMeterPercent(postFaderLeftDb)))}%`,
                            background: getMeterGradient(Math.min(100, dbToMeterPercent(postFaderLeftDb)), postFaderLeftDb),
                          }}
                        />
                        {/* Clip indicator - shows red at top if clipping */}
                        {postFaderLeftDb > 0 && !isMuted && (
                          <div className="absolute top-0 w-full h-1 bg-red-500" />
                        )}
                      </div>
                      {/* Right meter */}
                      <div className="w-2 h-full bg-slate-950 rounded-sm overflow-hidden relative border border-slate-800">
                        {/* Meter fill - post-fader level, capped at 0dB (100%) */}
                        <div
                          className="absolute bottom-0 w-full transition-all duration-75"
                          style={{
                            height: isMuted ? '0%' : `${Math.min(100, Math.max(0, dbToMeterPercent(postFaderRightDb)))}%`,
                            background: getMeterGradient(Math.min(100, dbToMeterPercent(postFaderRightDb)), postFaderRightDb),
                          }}
                        />
                        {/* Clip indicator - shows red at top if clipping */}
                        {postFaderRightDb > 0 && !isMuted && (
                          <div className="absolute top-0 w-full h-1 bg-red-500" />
                        )}
                      </div>
                      {/* Right: Meter Scale - independent from fader scale */}
                      {/* Uses dbToMeterPosition() for meter-specific scale positions */}
                      <div className="absolute -right-6 top-0 bottom-0 w-6 flex flex-col text-[7px] text-slate-400 font-mono pointer-events-none select-none">
                        {/* Scale tick marks and labels */}
                        <div className="absolute left-0 flex items-center" style={{ top: '0', transform: 'translateY(-50%)' }}>
                          <div className="w-2 h-px bg-red-400"></div>
                          <span className="ml-0.5 text-red-400 font-bold">0</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(6)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5">6</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(12)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">12</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(18)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">18</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(24)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">24</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(30)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">30</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(40)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">40</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(50)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">50</span>
                        </div>
                        <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(60)}%`, transform: 'translateY(50%)' }}>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                          <span className="ml-0.5 text-[6px]">60</span>
                        </div>
                      </div>
                    </div>
                    </div>
                    {/* dB readout - shows fader position in dB, click to edit */}
                    {editingDbNodeId === node.id ? (
                      <input
                        type="text"
                        autoFocus
                        className="w-12 text-[8px] font-mono text-center bg-slate-800 border border-cyan-500 rounded px-1 py-0.5 mt-1 text-cyan-400 outline-none"
                        value={editingDbValue}
                        onChange={(e) => setEditingDbValue(e.target.value)}
                        onBlur={() => {
                          const trimmed = editingDbValue.trim().toLowerCase();
                          if (trimmed === '-inf' || trimmed === 'inf' || trimmed === '-∞' || trimmed === '∞') {
                            updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, 0);
                          } else {
                            const parsed = parseFloat(trimmed);
                            if (!isNaN(parsed)) {
                              const clampedDb = Math.max(-100, Math.min(6, parsed));
                              updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, dbToFader(clampedDb));
                            }
                          }
                          setEditingDbNodeId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            setEditingDbNodeId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className="text-[8px] font-mono text-slate-500 mt-1 cursor-pointer hover:text-cyan-400 hover:bg-slate-800 px-1 rounded"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentDb = faderToDb(level);
                          setEditingDbValue(currentDb <= -60 ? '-∞' : currentDb.toFixed(1));
                          setEditingDbNodeId(node.id);
                        }}
                      >
                        {isMuted ? 'MUTE' : faderToDb(level) <= -60 ? '-∞' : `${faderToDb(level) >= 0 ? '+' : ''}${faderToDb(level).toFixed(1)}dB`}
                      </div>
                    )}
                    <div className="flex gap-1 mt-1 w-full px-1">
                    <button onClick={() => toggleConnectionMute(node.id, focusedOutputId!, focusedPairIndex)} className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>M</button>
                    </div>
                </div>
                )
            })}
          </div>
        </div>

        {/* MASTER RESIZE HANDLE */}
        <div
          className="w-1 bg-transparent hover:bg-amber-500/50 cursor-ew-resize z-40 shrink-0 transition-colors"
          onMouseDown={(e) => handleResizeStart(e, 'master', masterWidth, setMasterWidth, 200, 450)}
        />

        {/* MASTER SECTION (RIGHT) */}
        <div
          className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 relative shadow-2xl min-h-0"
          style={{ width: masterWidth }}
        >
          <div className="p-2 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between shrink-0">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              <Monitor className="w-3 h-3" /> Master & Monitor
            </div>
          </div>

          <div className="flex-1 flex gap-2 p-3 min-h-0">

             {/* 1. Channel Pair Selector (Left) */}
             {focusedTarget && focusedTargetPairs > 1 && (
               <div className="w-14 flex flex-col gap-1 overflow-y-auto border-r border-slate-800 pr-2 min-h-0">
                 <div className="text-[8px] font-bold text-slate-600 mb-1 text-center shrink-0">CH</div>
                 {Array.from({ length: focusedTargetPairs }).map((_, pairIdx) => {
                   const isPairSelected = focusedPairIndex === pairIdx;
                   return (
                     <button
                       key={pairIdx}
                       onClick={() => setFocusedPairIndex(pairIdx)}
                       className={`
                         w-full py-1.5 rounded text-[9px] font-bold border transition-all text-center shrink-0
                         ${isPairSelected
                           ? `bg-${focusedTarget.color.split('-')[1]}-500/20 border-${focusedTarget.color.split('-')[1]}-500 text-white`
                           : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'}
                       `}
                     >
                       {getPairLabel(pairIdx)}
                     </button>
                   );
                 })}
               </div>
             )}

             {/* 2. Output Device Selection (Middle) */}
             <div className="flex-1 flex flex-col gap-1 overflow-y-auto min-h-0">
                {activeTargets.map(node => {
                    const isSelected = focusedOutputId === node.id;
                    const Icon = node.icon;

                    return (
                        <div
                            key={node.id}
                            onClick={() => {
                                setFocusedOutputId(node.id);
                                setFocusedPairIndex(0);
                            }}
                            className={`
                                flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all shrink-0
                                ${isSelected
                                ? `bg-slate-800 border-${node.color.split('-')[1]}-500/50`
                                : 'border-slate-800 hover:border-slate-600'}
                            `}
                        >
                            <div className={`w-5 h-5 rounded flex items-center justify-center bg-slate-950 ${node.color}`}>
                                <Icon className="w-3 h-3" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-[10px] font-bold truncate ${isSelected ? 'text-white' : 'text-slate-400'}`}>{node.label}</div>
                            </div>
                            {isSelected && <div className={`w-1.5 h-1.5 rounded-full ${node.color.replace('text-', 'bg-')} animate-pulse`}></div>}
                        </div>
                    );
                })}
             </div>

             {/* 3. Master Fader (Right) */}
             {focusedTarget && (() => {
                 // Calculate master levels from connected sources
                 const connectedSources = connections.filter(c => c.toNodeId === focusedTarget.id && c.toChannel === focusedPairIndex);
                 let masterLeftRms = 0;
                 let masterRightRms = 0;

                 for (const conn of connectedSources) {
                   if (conn.muted) continue;
                   const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
                   if (!sourceNode) continue;
                   const channelOffset = sourceNode.channelOffset ?? 0;
                   const pairIdx = channelOffset / 2;
                   const levelData = inputLevels[pairIdx];
                   if (levelData) {
                     const sendGain = faderToDb(conn.sendLevel) <= -100 ? 0 : Math.pow(10, faderToDb(conn.sendLevel) / 20);
                     // Sum power (RMS^2) for proper mixing
                     masterLeftRms += Math.pow(levelData.left_peak * sendGain, 2);
                     masterRightRms += Math.pow(levelData.right_peak * sendGain, 2);
                   }
                 }

                 // Apply master volume and convert to dB for meter display
                 const masterDb = faderToDb(focusedTarget.volume);
                 const masterGain = masterDb <= -100 ? 0 : Math.pow(10, masterDb / 20);
                 masterLeftRms = Math.sqrt(masterLeftRms) * masterGain;
                 masterRightRms = Math.sqrt(masterRightRms) * masterGain;

                 // Convert to dB for meter display
                 const masterLeftDb = rmsToDb(masterLeftRms);
                 const masterRightDb = rmsToDb(masterRightRms);

                 // Helper to update master volume from dB
                 const updateMasterFromDb = (db: number) => {
                   const newLevel = dbToFader(db);
                   updateMasterVolume(focusedTarget.id, newLevel);
                   const targetData = outputTargets.find(t => t.id === focusedTarget.libraryId);
                   if (targetData) {
                     setOutputVolume(targetData.deviceId, db); // Pass dB value to backend
                   }
                 };

                 return (
                 <div className="w-28 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none shadow-xl">
                    <div className="text-[8px] font-bold text-slate-500 mb-2">MASTER</div>
                    <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
                        {/* Fader with scale on left */}
                        <div className="relative mr-2">
                          {/* Left: Fader Scale (+6dB = top) - matches Logic Pro X */}
                          <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none">
                            {/* Scale tick marks and labels - clickable */}
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ top: '0', transform: 'translateY(-50%)' }} onClick={() => updateMasterFromDb(6)}>
                              <span className="mr-0.5">+6</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(3)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(3)}>
                              <span className="mr-0.5">+3</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-cyan-400" style={{ bottom: `${dbToFader(0)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(0)}>
                              <span className="mr-0.5 text-white font-bold">0</span>
                              <div className="w-2.5 h-px bg-white"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-3)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-3)}>
                              <span className="mr-0.5">-3</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-6)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-6)}>
                              <span className="mr-0.5">-6</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-10)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-10)}>
                              <span className="mr-0.5 text-[6px]">-10</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-15)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-15)}>
                              <span className="mr-0.5 text-[6px]">-15</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-20)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-20)}>
                              <span className="mr-0.5 text-[6px]">-20</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-30)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-30)}>
                              <span className="mr-0.5 text-[6px]">-30</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-40)}%`, transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-40)}>
                              <span className="mr-0.5 text-[6px]">-40</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                            <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: '0', transform: 'translateY(50%)' }} onClick={() => updateMasterFromDb(-100)}>
                              <span className="mr-0.5">-∞</span>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                            </div>
                          </div>
                          <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                              <input
                                  type="range" min="0" max="100" value={focusedTarget.volume}
                                  onChange={(e) => {
                                    const vol = Number(e.target.value);
                                    updateMasterVolume(focusedTarget.id, vol);
                                    const targetData = outputTargets.find(t => t.id === focusedTarget.libraryId);
                                    if (targetData) {
                                      setOutputVolume(targetData.deviceId, faderToDb(vol)); // Pass dB value to backend
                                    }
                                  }}
                                  className="absolute inset-0 h-full w-6 -left-2 opacity-0 z-20 cursor-pointer appearance-slider-vertical"
                              />
                              <div className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10" style={{ bottom: `calc(${focusedTarget.volume}% - 5px)` }}></div>
                          </div>
                        </div>
                        {/* Level Meters on right */}
                        <div className="flex gap-0.5 relative">
                          {/* Left meter */}
                          <div className="w-2 h-full bg-slate-950 rounded-sm overflow-hidden relative border border-slate-800">
                            <div
                              className="absolute bottom-0 w-full transition-all duration-75"
                              style={{
                                height: `${Math.min(100, Math.max(0, dbToMeterPercent(masterLeftDb)))}%`,
                                background: getMeterGradient(Math.min(100, dbToMeterPercent(masterLeftDb)), masterLeftDb),
                              }}
                            />
                            {masterLeftDb > 0 && (
                              <div className="absolute top-0 w-full h-1 bg-red-500" />
                            )}
                          </div>
                          {/* Right meter */}
                          <div className="w-2 h-full bg-slate-950 rounded-sm overflow-hidden relative border border-slate-800">
                            <div
                              className="absolute bottom-0 w-full transition-all duration-75"
                              style={{
                                height: `${Math.min(100, Math.max(0, dbToMeterPercent(masterRightDb)))}%`,
                                background: getMeterGradient(Math.min(100, dbToMeterPercent(masterRightDb)), masterRightDb),
                              }}
                            />
                            {masterRightDb > 0 && (
                              <div className="absolute top-0 w-full h-1 bg-red-500" />
                            )}
                          </div>
                          {/* Right: Meter Scale */}
                          <div className="absolute -right-6 top-0 bottom-0 w-6 flex flex-col text-[7px] text-slate-400 font-mono pointer-events-none select-none">
                            <div className="absolute left-0 flex items-center" style={{ top: '0', transform: 'translateY(-50%)' }}>
                              <div className="w-2 h-px bg-red-400"></div>
                              <span className="ml-0.5 text-red-400 font-bold">0</span>
                            </div>
                            <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(6)}%`, transform: 'translateY(50%)' }}>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                              <span className="ml-0.5">6</span>
                            </div>
                            <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(12)}%`, transform: 'translateY(50%)' }}>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                              <span className="ml-0.5 text-[6px]">12</span>
                            </div>
                            <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(24)}%`, transform: 'translateY(50%)' }}>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                              <span className="ml-0.5 text-[6px]">24</span>
                            </div>
                            <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(40)}%`, transform: 'translateY(50%)' }}>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                              <span className="ml-0.5 text-[6px]">40</span>
                            </div>
                            <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(60)}%`, transform: 'translateY(50%)' }}>
                              <div className="w-1.5 h-px bg-slate-500"></div>
                              <span className="ml-0.5 text-[6px]">60</span>
                            </div>
                          </div>
                        </div>
                    </div>
                    {/* dB readout - click to edit */}
                    {editingMasterDb ? (
                      <input
                        type="text"
                        autoFocus
                        className="w-12 text-[8px] font-mono text-center bg-slate-800 border border-cyan-500 rounded px-1 py-0.5 mt-1 text-cyan-400 outline-none"
                        value={editingMasterDbValue}
                        onChange={(e) => setEditingMasterDbValue(e.target.value)}
                        onBlur={() => {
                          const trimmed = editingMasterDbValue.trim().toLowerCase();
                          if (trimmed === '-inf' || trimmed === 'inf' || trimmed === '-∞' || trimmed === '∞') {
                            updateMasterFromDb(-100);
                          } else {
                            const parsed = parseFloat(trimmed);
                            if (!isNaN(parsed)) {
                              const clampedDb = Math.max(-100, Math.min(6, parsed));
                              updateMasterFromDb(clampedDb);
                            }
                          }
                          setEditingMasterDb(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            setEditingMasterDb(false);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className="text-[8px] font-mono text-slate-500 mt-1 cursor-pointer hover:text-cyan-400 hover:bg-slate-800 px-1 rounded"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentDb = faderToDb(focusedTarget.volume);
                          setEditingMasterDbValue(currentDb <= -60 ? '-∞' : currentDb.toFixed(1));
                          setEditingMasterDb(true);
                        }}
                      >
                        {faderToDb(focusedTarget.volume) <= -60 ? '-∞' : `${faderToDb(focusedTarget.volume) >= 0 ? '+' : ''}${faderToDb(focusedTarget.volume).toFixed(1)}dB`}
                      </div>
                    )}
                 </div>
                 );
             })()}
          </div>
        </div>

      </div>

      {/* Library drag preview */}
      {libraryDrag && (
        <div
          className="fixed pointer-events-none z-50 bg-slate-800 border-2 border-cyan-500 rounded-lg px-4 py-2 shadow-xl opacity-80"
          style={{ left: libraryDrag.x - 60, top: libraryDrag.y - 20, transform: 'translate(0, 0)' }}
        >
          <span className="text-xs font-bold text-white">
            {libraryDrag.type === 'lib_source'
              ? (() => {
                  const ch = channelSources.find(c => c.id === libraryDrag.id);
                  return ch?.isMain ? 'Ch 1-2 (MAIN)' : `Ch ${ch?.channelLabel || '?'}`;
                })()
              : outputTargets.find(t => t.id === libraryDrag.id)?.name
            }
          </span>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-96"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-cyan-400" />
                Settings
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-white transition-colors p-1 hover:bg-slate-800 rounded"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              {/* Buffer Size Setting */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  I/O Buffer Size (Latency)
                </label>
                <select
                  value={bufferSize}
                  onChange={e => handleBufferSizeChange(Number(e.target.value))}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-cyan-500 focus:outline-none"
                >
                  <option value={64}>64 samples (~1.3ms) - Ultra Low</option>
                  <option value={128}>128 samples (~2.7ms) - Low</option>
                  <option value={256}>256 samples (~5.3ms) - Default</option>
                  <option value={512}>512 samples (~10.7ms) - Safe</option>
                  <option value={1024}>1024 samples (~21.3ms) - Very Safe</option>
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  CoreAudio I/O buffer size. Lower = less latency but may cause audio glitches on slower systems.
                  <br />
                  <span className="text-amber-400">⚠️ Changing this will restart the app.</span>
                </p>
                {pendingRestart && (
                  <div className="mt-3 p-3 bg-amber-900/50 border border-amber-600 rounded-lg">
                    <p className="text-amber-300 text-sm mb-2">
                      Buffer size changed. Please restart the app to apply changes.
                    </p>
                    <button
                      onClick={handleRestartApp}
                      className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Restart App
                    </button>
                  </div>
                )}
              </div>

              {/* Driver Status Info */}
              {driverStatus && (
                <div className="pt-4 border-t border-slate-700">
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Prism Driver Status
                  </label>
                  <div className="bg-slate-800 rounded-lg p-3 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Connection</span>
                      <span className={driverStatus.connected ? 'text-green-400' : 'text-red-400'}>
                        {driverStatus.connected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Sample Rate</span>
                      <span className="text-white">{driverStatus.sample_rate} Hz</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Driver Buffer</span>
                      <span className="text-white">{driverStatus.buffer_size} samples</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
