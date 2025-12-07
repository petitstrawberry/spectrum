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
  getInputLevels,
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
  getInputDeviceLevels,
  openPrismApp,
  startAudioOutput,
  stopAudioOutput,
  // Bus API
  addBus,
  removeBus as removeBusApi,
  updateBusSend,
  removeBusSend,
  // setRouting, // TODO: Re-enable when channel routing is implemented
  type AppSource,
  type DriverStatus,
  type AudioDevice,
  type LevelData,
  type AppState,
  type InputDeviceInfo,
  type ActiveCaptureInfo,
} from './lib/prismd';

// --- Types ---

type NodeType = 'source' | 'target' | 'bus';

// ソースノードの種類
type SourceType = 'prism-channel' | 'device';

// チャンネルモード
type ChannelMode = 'mono' | 'stereo';

// AudioUnit Plugin info
interface AudioUnitPlugin {
  id: string;
  name: string;
  manufacturer: string;
  type: string; // 'effect', 'instrument', etc.
  enabled: boolean;
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
  channelOffset?: number; // Prism channel offset (0, 2, 4, ... 62)
  // New fields for device-based sources
  sourceType?: SourceType;    // 'prism-channel' or 'device'
  deviceId?: number;          // CoreAudio device ID
  deviceName?: string;        // Device name for display
  // Channel mode: mono (1ch ports) or stereo (2ch ports)
  channelMode: ChannelMode;
  // Device availability - false when device is disconnected
  available?: boolean;
  // Bus-specific fields
  busId?: string;             // Unique bus identifier (bus_1, bus_2, etc.)
  plugins?: AudioUnitPlugin[]; // AudioUnit plugin chain for buses
}

interface Connection {
  id: string;
  fromNodeId: string;
  fromChannel: number;   // 1ch-based index (0 = ch1, 1 = ch2, 2 = ch3, ...)
  toNodeId: string;
  toChannel: number;     // 1ch-based index (0 = ch1, 1 = ch2, 2 = ch3, ...)
  sendLevel: number;
  muted: boolean;
  stereoLinked?: boolean; // If true, this connection is linked with the next channel
}

// --- Output Targets - will be populated from CoreAudio ---
// Now dynamically generated from actual audio devices

// --- Icon Name <-> Icon Component Mapping ---
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Settings, Search, Maximize2, Grid, Workflow, Music, MessageSquare, Gamepad2,
  Headphones, Radio, Globe, Speaker, LogOut, Link: LinkIcon, Plus, Trash2,
  Monitor, Video, RefreshCw, Volume2, Mic, ExternalLink, Cast,
};

function iconToName(icon: React.ComponentType<{ className?: string }>): string {
  for (const [name, component] of Object.entries(ICON_MAP)) {
    if (component === icon) return name;
  }
  return 'Volume2'; // Default
}

function nameToIcon(name: string): React.ComponentType<{ className?: string }> {
  return ICON_MAP[name] || Volume2;
}

// --- Helper: Get port count for a node (always 1ch per port) ---
function getPortCount(node: NodeData): number {
  return node.channelCount;
}

// --- Helper: Get channel label for a port (1-based) ---
// For Prism source nodes, show actual channel number (e.g., 7, 8)
// For device nodes and target nodes, show relative port number (1, 2, ...)
function getPortLabel(node: NodeData, portIndex: number): string {
  // Prism source nodes have channelOffset indicating the actual channel
  if (node.type === 'source' && node.sourceType !== 'device' && node.channelOffset !== undefined) {
    return `${node.channelOffset + portIndex + 1}`;
  }
  return `${portIndex + 1}`;
}

// --- Helper: Check if a port is mono (always true - ports are always 1ch) ---
function isPortMono(_node: NodeData, _portIndex: number): boolean {
  return true;
}

// --- Helper: Get icon for input device ---
function getIconForInputDevice(device: InputDeviceInfo): React.ComponentType<{ className?: string }> {
  const name = device.name.toLowerCase();
  if (device.is_prism) return Volume2; // Prism uses Volume2 (virtual)
  if (name.includes('microphone') || name.includes('mic')) return Mic;
  if (name.includes('line in') || name.includes('input')) return Mic;
  if (name.includes('headphone') || name.includes('headset')) return Headphones;
  if (name.includes('usb') || name.includes('interface')) return Mic;
  return Mic; // Default to Mic for input devices
}

// --- Helper: Get color for input device ---
function getColorForInputDevice(device: InputDeviceInfo): string {
  if (device.is_prism) return 'text-cyan-400';
  return 'text-amber-400'; // All other input devices use amber
}

// --- Helper: Get icon for device node (used across UI) ---
function getDeviceNodeIcon(node: NodeData): React.ComponentType<{ className?: string }> {
  if (node.sourceType === 'device') {
    return Mic; // All non-Prism input devices use Mic
  }
  return node.icon; // Prism channels use their assigned icon
}

// --- Helper: Get color for device node (used across UI) ---
function getDeviceNodeColor(node: NodeData): string {
  if (node.sourceType === 'device') {
    return 'text-amber-400'; // All device nodes use amber
  }
  return node.color;
}

// --- Helper: Get icon for output device type ---
function getIconForOutputDevice(device: AudioDevice): React.ComponentType<{ className?: string }> {
  const name = device.name.toLowerCase();
  const transport = device.transport_type || '';

  // Special case: Apple Studio Display (Thunderbolt but should show as display)
  if (name.includes('studio display')) return Monitor;

  // Transport type based detection (most reliable from CoreAudio)
  if (transport === 'hdmi' || transport === 'displayport') return Monitor;
  if (transport === 'bluetooth') return Headphones; // BT is usually headphones
  if (transport === 'airplay') return Cast;

  // Virtual audio devices - check transport type first
  if (transport === 'virtual' || transport === 'aggregate') return Radio;

  // External headphone jack (built-in headphone port)
  if (name.includes('external headphone') || name.includes('外部ヘッドフォン') ||
      name.includes('headphone port') || name.includes('headphones')) return Headphones;

  // Headphones detection (various naming patterns)
  if (name.includes('headphone') || name.includes('headset') ||
      name.includes('airpods') || name.includes('earpods') ||
      name.includes('earphone') || name.includes('earbuds') ||
      name.includes('beats') || name.includes('wh-1000') || // Sony WH-1000XM
      name.includes('bose') || name.includes('sennheiser') ||
      name.includes('jabra') || name.includes('soundcore')) return Headphones;

  // External speakers (built-in speakers)
  if (name.includes('speaker') || name.includes('built-in output') ||
      name.includes('macbook pro speakers') || name.includes('internal speakers') ||
      name.includes('homepod') || name.includes('sonos') || name.includes('echo')) return Speaker;

  // Virtual audio devices - name based fallback
  if (name.includes('blackhole') || name.includes('loopback') ||
      name.includes('soundflower') || name.includes('vb-cable') ||
      name.includes('virtual') || name.includes('aggregate') ||
      name.includes('existential') || name.includes('rogue amoeba') ||
      name.includes('audio hijack')) return Radio;

  // Streaming / OBS
  if (name.includes('obs') || name.includes('stream') ||
      name.includes('discord') || name.includes('zoom')) return Video;

  // USB audio interfaces / DACs - use Volume2 (generic audio)
  if (name.includes('scarlett') || name.includes('focusrite') ||
      name.includes('steinberg') || name.includes('motu') ||
      name.includes('rme') || name.includes('universal audio') ||
      name.includes('presonus') || name.includes('behringer') ||
      name.includes('fiio') || name.includes('topping') ||
      name.includes('audio interface') || name.includes('dac')) return Volume2;

  // Device type fallback
  if (device.device_type === 'virtual') return Radio;
  if (device.device_type === 'builtin') return Speaker;

  // Default: generic volume icon for unknown devices
  return Volume2;
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

// --- Helper: Get source device ID for a node ---
// Prism channels use device ID 0, device inputs use their actual device ID
function getSourceDeviceId(node: NodeData): number {
  if (node.sourceType === 'device' && node.deviceId !== undefined) {
    return node.deviceId;
  }
  // Prism channels use device ID 0
  return 0;
}

// --- Helper: Get actual channel index for a port (0-based, 1ch per port) ---
function getChannelIndexForPort(node: NodeData, portIndex: number): number {
  const baseOffset = node.channelOffset ?? 0;
  return baseOffset + portIndex;
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

  // Optimized node lookup map
  const nodesById = useMemo(() => {
    const map = new Map<string, NodeData>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  // Selection State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedOutputId, setFocusedOutputId] = useState<string | null>(null);
  const [focusedPairIndex, setFocusedPairIndex] = useState<number>(0); // Which stereo pair (0 = ch 1-2, 1 = ch 3-4, etc)

  // Resizable panel sizes
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(256);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(256);
  const [mixerHeight, setMixerHeight] = useState(350);
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

  // Input device capture state
  const [inputDevices, setInputDevices] = useState<InputDeviceInfo[]>([]);
  const [activeCaptures, setActiveCaptures] = useState<ActiveCaptureInfo[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<number | null>(null);
  const [inputSourceMode, setInputSourceMode] = useState<'prism' | 'devices'>('prism'); // Tab mode

  // Real-time level meters (32 stereo pairs for Prism)
  const [inputLevels, setInputLevels] = useState<LevelData[]>([]);
  // Per-device level meters (device_id -> levels)
  const [deviceLevelsMap, setDeviceLevelsMap] = useState<Map<number, LevelData[]>>(new Map());

  // dB input editing state
  const [editingDbNodeId, setEditingDbNodeId] = useState<string | null>(null);
  const [editingDbValue, setEditingDbValue] = useState<string>('');
  const [editingMasterDb, setEditingMasterDb] = useState<boolean>(false);
  const [editingMasterDbValue, setEditingMasterDbValue] = useState<string>('');

  // Context menu state for node right-click
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [bufferSize, setBufferSizeState] = useState<number>(4096);

  // Bus node counter and selected bus for detail view
  const [busCounter, setBusCounter] = useState(1);
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);

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
      const [apps, status, devices, inputs, captures] = await Promise.all([
        getPrismApps(),
        getDriverStatus(),
        getAudioDevices(),
        getInputDevices(),
        getActiveInputCaptures(),
      ]);
      setPrismApps(apps);
      setDriverStatus(status);
      // Filter to output devices only
      setAudioDevices(devices.filter(d => d.is_output));
      setInputDevices(inputs);
      setActiveCaptures(captures);

      // Auto-select first active capture if none selected
      if (!selectedInputDeviceId && captures.length > 0) {
        setSelectedInputDeviceId(captures[0].device_id);
      }
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
  const restoredRef = useRef(false);
  useEffect(() => {
    const restoreState = async () => {
      if (restoredRef.current) return;

      try {
        const savedState = await getAppState();
        console.log('[Spectrum] Restoring saved state:', savedState);

        // Restore buffer size
        if (savedState.io_buffer_size) {
          setBufferSizeState(savedState.io_buffer_size);
        }

        // Restore canvas transform
        if (savedState.patch_scroll_x !== undefined && savedState.patch_scroll_y !== undefined) {
          setCanvasTransform({
            x: savedState.patch_scroll_x,
            y: savedState.patch_scroll_y,
            scale: savedState.patch_zoom || 1,
          });
        }

        // Restore nodes and connections if available
        if (savedState.saved_nodes && savedState.saved_nodes.length > 0) {
          restoredRef.current = true;

          // Restore nodes - mark unavailable if device doesn't exist
          const restoredNodes: NodeData[] = savedState.saved_nodes.map(sn => {
            // Check if the device/source is currently available
            let available = true;
            let currentLibraryId = sn.library_id;

            if (sn.node_type === 'target') {
              // Check if output device exists (by name, since ID can change)
              const device = audioDevices.find(d => d.name === sn.label && d.is_output);
              available = !!device;
              // Update libraryId if device is available (ID may have changed)
              if (device) {
                currentLibraryId = `out_${device.id}`;
              }
            } else if (sn.source_type === 'device') {
              // Check if input device exists
              const device = inputDevices.find(d => d.name === sn.device_name);
              available = !!device;
              if (device) {
                currentLibraryId = `input_${device.device_id}`;
              }
            } else if (sn.source_type === 'prism-channel') {
              // Prism channels: check if Prism device is in audioDevices list
              // or driver is connected
              const prismDevice = audioDevices.find(d => d.device_type === 'prism');
              available = !!prismDevice || driverStatus?.connected || false;
            }

            return {
              id: sn.id,
              libraryId: currentLibraryId,
              type: sn.node_type as NodeType,
              label: sn.label,
              subLabel: sn.sub_label,
              icon: nameToIcon(sn.icon_name),
              color: sn.color,
              x: sn.x,
              y: sn.y,
              volume: sn.volume,
              muted: sn.muted,
              channelCount: sn.channel_count,
              channelOffset: sn.channel_offset,
              sourceType: sn.source_type as SourceType | undefined,
              deviceId: sn.device_id,
              deviceName: sn.device_name,
              channelMode: sn.channel_mode as ChannelMode,
              available,
              // Restore busId from libraryId for bus nodes (format: "bus_xxx")
              busId: sn.node_type === 'bus' ? sn.library_id.replace('bus_', '') : undefined,
            };
          });

          // Restore connections
          const restoredConnections: Connection[] = (savedState.saved_connections || []).map(sc => ({
            id: sc.id,
            fromNodeId: sc.from_node_id,
            fromChannel: sc.from_channel,
            toNodeId: sc.to_node_id,
            toChannel: sc.to_channel,
            sendLevel: sc.send_level,
            muted: sc.muted,
            stereoLinked: sc.stereo_linked,
          }));

          setNodes(restoredNodes);
          setConnections(restoredConnections);

          // Set focused output to first available target, or first target
          const firstAvailableTarget = restoredNodes.find(n => n.type === 'target' && n.available);
          const firstTarget = restoredNodes.find(n => n.type === 'target');
          if (firstAvailableTarget || firstTarget) {
            setFocusedOutputId((firstAvailableTarget || firstTarget)!.id);
          }

          // Step 1: Start audio inputs and outputs first
          const startPromises: Promise<void>[] = [];

          // Start input capture for source devices
          const prismDeviceForCapture = audioDevices.find(d =>
            d.name.toLowerCase().includes('prism') && !d.is_output
          );
          const startedInputDevices = new Set<number>();
          for (const node of restoredNodes) {
            if (node.type === 'source' && node.available) {
              if (node.sourceType === 'prism-channel' && prismDeviceForCapture) {
                const prismDeviceId = parseInt(prismDeviceForCapture.id);
                if (!isNaN(prismDeviceId) && !startedInputDevices.has(prismDeviceId)) {
                  // Start Prism input capture
                  startedInputDevices.add(prismDeviceId);
                  startPromises.push(
                    startInputCapture(prismDeviceId)
                      .then(() => console.log(`[Spectrum] Started Prism input capture`))
                      .catch(err => { console.error('[Spectrum] Failed to start Prism input capture:', err); })
                  );
                }
              } else if (node.sourceType === 'device' && node.deviceId !== undefined && !startedInputDevices.has(node.deviceId)) {
                // Start device input capture
                startedInputDevices.add(node.deviceId);
                startPromises.push(
                  startInputCapture(node.deviceId)
                    .then(() => console.log(`[Spectrum] Started input capture for device ${node.label}`))
                    .catch(err => { console.error(`[Spectrum] Failed to start input capture for ${node.label}:`, err); })
                );
              }
            }
          }

          // Start audio output for available targets and set volumes
          const startedOutputDevices = new Set<number>();
          for (const node of restoredNodes) {
            if (node.type === 'target' && node.available) {
              const device = audioDevices.find(d => d.name === node.label && d.is_output);
              if (device) {
                const deviceIdNum = parseInt(device.id);
                if (!isNaN(deviceIdNum) && !startedOutputDevices.has(deviceIdNum)) {
                  startedOutputDevices.add(deviceIdNum);
                  // Start audio output to this device
                  startPromises.push(
                    startAudioOutput(deviceIdNum)
                      .then(() => console.log(`[Spectrum] Started audio output to ${device.name}`))
                      .catch(err => { console.error(`[Spectrum] Failed to start output to ${device.name}:`, err); })
                  );
                }

                // Set output volume
                setOutputVolume(device.id, faderToDb(node.volume))
                  .catch(err => console.error('[Spectrum] Failed to restore output volume:', err));
              }
            }
          }

          // Step 2: Wait for all inputs/outputs to start, then establish mixer sends
          Promise.all(startPromises).then(async () => {
            // First, register all buses in the backend and wait for completion
            const busNodes = restoredNodes.filter(n => n.type === 'bus');
            const busPromises = busNodes.map(async (bus) => {
              if (bus.busId) {
                try {
                  await addBus(bus.busId, bus.label, bus.channelCount);
                  console.log(`[Spectrum] Restored bus ${bus.busId}`);
                } catch (err) {
                  console.error(`[Spectrum] Failed to restore bus ${bus.busId}:`, err);
                }
              }
            });

            // Wait for all buses to be registered before setting up connections
            await Promise.all(busPromises);
            console.log(`[Spectrum] All buses registered, now establishing connections...`);

            console.log(`[Spectrum] Re-establishing ${restoredConnections.length} connections...`);
            for (const conn of restoredConnections) {
              const sourceNode = restoredNodes.find(n => n.id === conn.fromNodeId);
              const targetNode = restoredNodes.find(n => n.id === conn.toNodeId);

              console.log(`[Spectrum] Connection: ${sourceNode?.label} -> ${targetNode?.label}, available: ${sourceNode?.available}, ${targetNode?.available}`);

              // Handle Bus connections
              if (sourceNode?.type === 'source' && targetNode?.type === 'bus') {
                // Input -> Bus
                const busId = targetNode.busId;
                if (busId && sourceNode.available) {
                  const srcDevId = sourceNode.sourceType === 'device' && sourceNode.deviceId !== undefined
                    ? sourceNode.deviceId : 0;
                  const srcCh = (sourceNode.channelOffset ?? 0) + conn.fromChannel;
                  const level = conn.muted ? 0 : conn.sendLevel / 100;
                  updateBusSend('input', sourceNode.deviceId?.toString() ?? '0', srcDevId, srcCh, 'bus', busId, conn.toChannel, level, conn.muted)
                    .then(() => console.log(`[Spectrum] Bus send restored: Input -> ${busId}`))
                    .catch(console.error);
                }
                continue;
              }

              if (sourceNode?.type === 'bus' && targetNode?.type === 'bus') {
                // Bus -> Bus
                const srcBusId = sourceNode.busId;
                const tgtBusId = targetNode.busId;
                if (srcBusId && tgtBusId) {
                  const level = conn.muted ? 0 : conn.sendLevel / 100;
                  updateBusSend('bus', srcBusId, 0, conn.fromChannel, 'bus', tgtBusId, conn.toChannel, level, conn.muted)
                    .then(() => console.log(`[Spectrum] Bus chain restored: ${srcBusId} -> ${tgtBusId}`))
                    .catch(console.error);
                }
                continue;
              }

              if (sourceNode?.type === 'bus' && targetNode?.type === 'target') {
                // Bus -> Output
                const srcBusId = sourceNode.busId;
                if (srcBusId && targetNode.available) {
                  const tgtDevId = targetNode.libraryId.replace('out_', '');
                  const level = conn.muted ? 0 : conn.sendLevel / 100;
                  updateBusSend('bus', srcBusId, 0, conn.fromChannel, 'output', tgtDevId, conn.toChannel, level, conn.muted)
                    .then(() => console.log(`[Spectrum] Bus to output restored: ${srcBusId} -> ${tgtDevId}`))
                    .catch(console.error);
                }
                continue;
              }

              // Skip if source or target is bus (already handled above)
              if (sourceNode?.type === 'bus' || targetNode?.type === 'bus') {
                continue;
              }

              // Only set up routing for available nodes (Input -> Output direct)
              if (sourceNode?.available && targetNode?.available) {
                const srcDevId = sourceNode.sourceType === 'device' && sourceNode.deviceId !== undefined
                  ? sourceNode.deviceId : 0;
                const srcCh = (sourceNode.channelOffset ?? 0) + conn.fromChannel;

                // Get target device ID from libraryId (format: "out_123")
                const tgtDevId = targetNode.libraryId.replace('out_', '');
                const tgtCh = (targetNode.channelOffset ?? 0) + conn.toChannel;

                // sendLevel is 0-100 fader value, pass as-is (not divided)
                const sendLevel = conn.muted ? 0 : conn.sendLevel;

                console.log(`[Spectrum] updateMixerSend(${srcDevId}, ${srcCh}, ${tgtDevId}, ${tgtCh}, ${sendLevel}, ${conn.muted})`);

                updateMixerSend(srcDevId, srcCh, tgtDevId, tgtCh, sendLevel, conn.muted)
                  .then(() => console.log(`[Spectrum] Send restored: ${srcDevId}:${srcCh} -> ${tgtDevId}:${tgtCh}`))
                  .catch(err => console.error('[Spectrum] Failed to restore send:', err));
              }
            }
          });

          console.log(`[Spectrum] Restored ${restoredNodes.length} nodes and ${restoredConnections.length} connections`);
        }
      } catch (error) {
        console.error('[Spectrum] Failed to restore state:', error);
      }
    };

    // Wait until we have device info before restoring
    if (audioDevices.length > 0 || inputDevices.length > 0) {
      restoreState();
    }
  }, [audioDevices, inputDevices, driverStatus]);

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
      // Serialize nodes and connections for persistence
      saved_nodes: nodes.map(n => ({
        id: n.id,
        library_id: n.libraryId,
        node_type: n.type,
        label: n.label,
        sub_label: n.subLabel,
        icon_name: iconToName(n.icon),
        color: n.color,
        x: n.x,
        y: n.y,
        volume: n.volume,
        muted: n.muted,
        channel_count: n.channelCount,
        channel_offset: n.channelOffset,
        source_type: n.sourceType,
        device_id: n.deviceId,
        device_name: n.deviceName,
        channel_mode: n.channelMode,
      })),
      saved_connections: connections.map(c => ({
        id: c.id,
        from_node_id: c.fromNodeId,
        from_channel: c.fromChannel,
        to_node_id: c.toNodeId,
        to_channel: c.toChannel,
        send_level: c.sendLevel,
        muted: c.muted,
        stereo_linked: c.stereoLinked,
      })),
    };
  }, [nodes, connections, bufferSize, focusedOutputId, canvasTransform]);

  // Auto-save state when nodes/connections change (debounced)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Don't save until we've initialized or restored
    if (!initializedRef.current && !restoredRef.current) return;
    // Don't save if no nodes
    if (nodes.length === 0) return;

    // Debounce saves to avoid excessive writes
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const state = buildAppState();
        await saveAppState(state);
        console.log('[Spectrum] Auto-saved state');
      } catch (error) {
        console.error('[Spectrum] Failed to auto-save:', error);
      }
    }, 2000); // 2 second debounce

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [nodes, connections, canvasTransform, buildAppState]);

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
          // 1. Get Prism levels (always)
          const prismLevels = await getInputLevels();
          if (prismLevels && prismLevels.length > 0) {
            setInputLevels(prismLevels);
          }

          // 2. Get levels for all active device captures (non-Prism)
          const activeDeviceIds = activeCaptures
            .filter(c => !c.is_prism)
            .map(c => c.device_id);

          if (activeDeviceIds.length > 0) {
            const levelPromises = activeDeviceIds.map(async (deviceId) => {
              const levels = await getInputDeviceLevels(deviceId);
              return { deviceId, levels };
            });

            const results = await Promise.all(levelPromises);
            setDeviceLevelsMap(prev => {
              const newMap = new Map(prev);
              for (const { deviceId, levels } of results) {
                if (levels && levels.length > 0) {
                  newMap.set(deviceId, levels);
                }
              }
              return newMap;
            });
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
  }, [activeCaptures]);

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

  // Get selected input device info
  const selectedInputDevice = useMemo(() => {
    return inputDevices.find(d => d.device_id === selectedInputDeviceId);
  }, [inputDevices, selectedInputDeviceId]);

  // Get Prism device (if any)
  const prismDevice = useMemo(() => {
    return inputDevices.find(d => d.is_prism);
  }, [inputDevices]);

  // Get non-Prism input devices
  const otherInputDevices = useMemo(() => {
    return inputDevices.filter(d => !d.is_prism);
  }, [inputDevices]);

  // Generate stereo channel pairs based on Prism (always uses Prism for channel sources)
  const channelSources = useMemo((): ChannelSource[] => {
    const channels: ChannelSource[] = [];

    // Prism always has 64 channels (32 stereo pairs)
    const numPairs = 32;

    for (let i = 0; i < numPairs; i++) {
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
        icon: getIconForOutputDevice(device),
        color: getColorForDeviceType(device),
        channels: device.output_channels,
        deviceId: device.id,
      }));
  }, [audioDevices]);

  // --- Helpers ---

  // Bus color palette
  const BUS_COLORS = [
    'text-purple-400', 'text-violet-400', 'text-indigo-400', 'text-blue-400',
    'text-teal-400', 'text-emerald-400', 'text-lime-400', 'text-yellow-400',
  ];

  const createNode = useCallback((libraryId: string, type: NodeType, x: number, y: number): NodeData => {
    // Bus nodes
    if (type === 'bus') {
      const busNum = busCounter;
      setBusCounter(prev => prev + 1);
      const busId = `bus_${busNum}`;
      const colorIndex = (busNum - 1) % BUS_COLORS.length;

      return {
        id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        libraryId: busId,
        type: 'bus',
        label: `Bus ${busNum}`,
        subLabel: 'Stereo',
        icon: Workflow,
        color: BUS_COLORS[colorIndex],
        x, y,
        volume: dbToFader(0),
        muted: false,
        channelCount: 2, // Start with stereo
        channelMode: 'stereo',
        available: true,
        busId,
        plugins: [],
      };
    }

    if (type === 'source') {
      // Check if this is a device node (non-Prism)
      if (libraryId.startsWith('dev_')) {
        const deviceId = parseInt(libraryId.replace('dev_', ''), 10);
        const device = inputDevices.find(d => d.device_id === deviceId);
        if (device) {
          // Start capture when node is created (placed on canvas)
          startInputCapture(deviceId).then(() => {
            setSelectedInputDeviceId(deviceId);
            getActiveInputCaptures().then(setActiveCaptures);
          }).catch(console.error);

          // Default: mono for 1ch devices, stereo for 2+ch devices
          const defaultMode: ChannelMode = device.channels === 1 ? 'mono' : 'stereo';

          return {
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            libraryId,
            type,
            label: device.name,
            subLabel: `${device.channels}ch Audio Input`,
            icon: getIconForInputDevice(device),
            color: getColorForInputDevice(device),
            x, y,
            volume: dbToFader(0), // 0dB = unity gain
            muted: false,
            channelCount: device.channels,
            sourceType: 'device',
            deviceId: device.device_id,
            deviceName: device.name,
            channelMode: defaultMode,
            available: true,
          };
        }
      }

      // Source nodes are channel-based (Prism)
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
          sourceType: 'prism-channel',
          channelMode: 'stereo', // Prism is always stereo pairs
          available: true, // Prism channels are available when driver is connected
        };
      }
    }

    // Target nodes
    const targetData = outputTargets.find(t => t.id === libraryId);
    const targetChannels = targetData?.channels || 2;
    return {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      libraryId,
      type,
      label: targetData?.name || 'Unknown',
      subLabel: `${targetChannels}ch / ${targetData?.type}`,
      icon: targetData?.icon || Grid,
      color: targetData?.color || 'text-slate-400',
      x, y,
      volume: dbToFader(0), // 0dB = unity gain
      muted: false,
      channelCount: targetChannels,
      channelMode: (targetChannels >= 2 && targetChannels % 2 === 0) ? 'stereo' : 'mono', // Stereo for even channels >= 2
      available: true,
    };
  }, [channelSources, outputTargets, inputDevices]);

  // --- Initial Setup - add first output when devices are loaded (only if no saved state) ---
  const initializedRef = useRef(false);
  useEffect(() => {
    // Skip initial setup if we restored from saved state
    if (restoredRef.current) {
      initializedRef.current = true;
      return;
    }

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

  // --- Sync node availability with connected devices ---
  // When devices disconnect/reconnect, update node availability and greyout
  // Also restart output when device reconnects
  // Match by device name since device IDs can change on reconnect
  useEffect(() => {
    setNodes(prevNodes => {
      let changed = false;
      const newNodes = prevNodes.map(node => {
        if (node.type === 'target') {
          // Check if this target device still exists in audioDevices
          // First try to match by libraryId (device ID), then fallback to name matching
          let targetData = outputTargets.find(t => t.id === node.libraryId);

          // If not found by ID, try to find by name (device may have reconnected with new ID)
          if (!targetData) {
            targetData = outputTargets.find(t => t.name === node.label);
            if (targetData) {
              // Device reconnected with new ID - update libraryId
              console.log(`[Spectrum] Device reconnected with new ID: ${node.label} (${node.libraryId} -> ${targetData.id})`);
              changed = true;

              // Get old device ID from libraryId (format: "out_123")
              const oldDeviceId = node.libraryId.replace('out_', '');
              const newDeviceId = targetData.deviceId;

              // Restart output with current volume
              setOutputVolume(newDeviceId, faderToDb(node.volume));

              // Re-establish all sends to this device with new device ID
              // Find all connections targeting this node
              const nodeConnections = connections.filter(c => c.toNodeId === node.id);
              for (const conn of nodeConnections) {
                const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
                if (sourceNode) {
                  const srcDevId = getSourceDeviceId(sourceNode);
                  const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
                  const tgtCh = getChannelIndexForPort(node, conn.toChannel);
                  const sendLevel = conn.muted ? 0 : conn.sendLevel / 100;

                  // Remove old send (if it exists) and add new one
                  removeMixerSend(srcDevId, srcCh, oldDeviceId, tgtCh).catch(() => {});
                  updateMixerSend(srcDevId, srcCh, newDeviceId, tgtCh, sendLevel, conn.muted).catch(console.error);
                  console.log(`[Spectrum] Re-established send: src=${srcDevId}:${srcCh} -> ${newDeviceId}:${tgtCh}`);
                }
              }

              return {
                ...node,
                libraryId: targetData.id,  // Update to new ID
                available: true,
                // Update other properties that might have changed
                channelCount: targetData.channels,
                icon: targetData.icon,
                color: targetData.color,
              };
            }
          }

          const isAvailable = targetData !== undefined;

          // Handle reconnection (same ID): restart output and restore volume
          if (isAvailable && node.available === false && targetData) {
            console.log(`[Spectrum] Device reconnected: ${node.label}, restarting output`);
            setOutputVolume(targetData.deviceId, faderToDb(node.volume));
          }

          if (node.available !== isAvailable) {
            changed = true;
            return { ...node, available: isAvailable };
          }
        } else if (node.type === 'source' && node.sourceType === 'device' && node.deviceId) {
          // Check if this input device still exists
          // First try by device ID, then by name
          let device = inputDevices.find(d => d.device_id === node.deviceId);

          // If not found by ID, try to find by name
          if (!device && node.deviceName) {
            device = inputDevices.find(d => d.name === node.deviceName);
            if (device) {
              // Device reconnected with new ID
              const oldDeviceId = node.deviceId;
              const newDeviceId = device.device_id;
              console.log(`[Spectrum] Input device reconnected with new ID: ${node.deviceName} (${oldDeviceId} -> ${newDeviceId})`);
              changed = true;

              // Restart capture
              startInputCapture(newDeviceId).catch(console.error);

              // Re-establish all sends from this device with new device ID
              const nodeConnections = connections.filter(c => c.fromNodeId === node.id);
              for (const conn of nodeConnections) {
                const targetNode = nodes.find(n => n.id === conn.toNodeId);
                if (targetNode) {
                  const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
                  if (targetData) {
                    const srcCh = getChannelIndexForPort(node, conn.fromChannel);
                    const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);
                    const sendLevel = conn.muted ? 0 : conn.sendLevel / 100;

                    // Remove old send and add new one
                    removeMixerSend(oldDeviceId, srcCh, targetData.deviceId, tgtCh).catch(() => {});
                    updateMixerSend(newDeviceId, srcCh, targetData.deviceId, tgtCh, sendLevel, conn.muted).catch(console.error);
                    console.log(`[Spectrum] Re-established send: src=${newDeviceId}:${srcCh} -> ${targetData.deviceId}:${tgtCh}`);
                  }
                }
              }

              return {
                ...node,
                deviceId: newDeviceId,
                libraryId: `dev_${newDeviceId}`,
                available: true,
                channelCount: device.channels,
              };
            }
          }

          const isAvailable = device !== undefined;

          // Handle reconnection (same ID): restart input capture
          if (isAvailable && node.available === false) {
            console.log(`[Spectrum] Input device reconnected: ${node.label}, restarting capture`);
            startInputCapture(node.deviceId).catch(console.error);
          }

          if (node.available !== isAvailable) {
            changed = true;
            return { ...node, available: isAvailable };
          }
        }
        // Prism channels are always available (when Prism is connected)
        return node;
      });
      return changed ? newNodes : prevNodes;
    });
  }, [audioDevices, inputDevices, outputTargets]);

  const getPortPosition = useCallback((node: NodeData, portIndex: number, isInput: boolean) => {
    const headerHeight = 36;
    const portHeight = 20;
    const portSpacing = 4;
    const paddingTop = 8; // p-2 = 8px
    const circleTop = 4; // top-[4px]
    const circleRadius = 6; // w-3 h-3 = 12px, radius = 6px
    const startY = node.y + headerHeight + paddingTop;
    const y = startY + (portIndex * (portHeight + portSpacing)) + circleTop + circleRadius + 2;
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
        // Handle Bus connections
        if (sourceNode.type === 'source' && targetNode.type === 'bus' && targetNode.busId) {
          const srcDevId = getSourceDeviceId(sourceNode);
          const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
          const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);
          removeBusSend('input', sourceNode.deviceId?.toString() ?? '0', srcDevId, srcCh, 'bus', targetNode.busId, tgtCh).catch(console.error);
          continue;
        }
        if (sourceNode.type === 'bus' && targetNode.type === 'bus' && sourceNode.busId && targetNode.busId) {
          const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
          const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);
          removeBusSend('bus', sourceNode.busId, 0, srcCh, 'bus', targetNode.busId, tgtCh).catch(console.error);
          continue;
        }
        if (sourceNode.type === 'bus' && targetNode.type === 'target' && sourceNode.busId) {
          const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
          const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (targetData) {
            removeBusSend('bus', sourceNode.busId, 0, srcCh, 'output', targetData.deviceId, tgtCh).catch(console.error);
          }
          continue;
        }

        // Direct Input -> Output
        if (sourceNode.type === 'source' && targetNode.type === 'target') {
          const srcDevId = getSourceDeviceId(sourceNode);
          const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
          const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (targetData) {
            removeMixerSend(srcDevId, srcCh, targetData.deviceId, tgtCh).catch(console.error);
          }
        }
      }
    }

    // Stop capture if deleting a device source node
    if (nodeToDelete?.type === 'source' && nodeToDelete.sourceType === 'device' && nodeToDelete.deviceId) {
      stopInputCapture(nodeToDelete.deviceId);
      getActiveInputCaptures().then(setActiveCaptures);
      if (selectedInputDeviceId === nodeToDelete.deviceId) {
        setSelectedInputDeviceId(null);
      }
    }

    // Remove bus from backend if deleting a bus node
    if (nodeToDelete?.type === 'bus' && nodeToDelete.busId) {
      removeBusApi(nodeToDelete.busId).catch(console.error);
    }

    // Also stop audio output if deleting a target node
    if (nodeToDelete?.type === 'target') {
      const targetData = outputTargets.find(t => t.id === nodeToDelete.libraryId);
      if (targetData) {
        const deviceIdNum = parseInt(targetData.deviceId);
        if (!isNaN(deviceIdNum)) {
          stopAudioOutput(deviceIdNum).catch(console.error);
        }
      }
    }

    setNodes(prev => prev.filter(n => n.id !== id));
    setConnections(prev => prev.filter(c => c.fromNodeId !== id && c.toNodeId !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    if (focusedOutputId === id) setFocusedOutputId(null);
  };

  // Toggle channel mode for output nodes and bus nodes (stereo <-> mono)
  const toggleChannelMode = (nodeId: string) => {
    setNodes(prev => prev.map(n => {
      if (n.id === nodeId && (n.type === 'target' || n.type === 'bus')) {
        const newMode = n.channelMode === 'stereo' ? 'mono' : 'stereo';
        const newChannelCount = newMode === 'stereo' ? 2 : 1;
        return {
          ...n,
          channelMode: newMode,
          channelCount: n.type === 'bus' ? newChannelCount : n.channelCount, // Only change channelCount for bus
          subLabel: n.type === 'bus' ? (newMode === 'stereo' ? 'Stereo' : 'Mono') : n.subLabel,
        };
      }
      return n;
    }));
  };

  const deleteConnection = (id: string) => {
    // Find the connection to get source and target info for backend cleanup
    const conn = connections.find(c => c.id === id);
    if (conn) {
      const sourceNode = nodesById.get(conn.fromNodeId);
      const targetNode = nodesById.get(conn.toNodeId);

      if (sourceNode && targetNode) {
        const srcDevId = getSourceDeviceId(sourceNode);
        const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
        const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);

        // Handle different connection types
        if (sourceNode.type === 'source' && targetNode.type === 'target') {
          // Input -> Output (direct)
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (targetData) {
            removeMixerSend(srcDevId, srcCh, targetData.deviceId, tgtCh).catch(console.error);
          }
        } else if (sourceNode.type === 'source' && targetNode.type === 'bus') {
          // Input -> Bus
          const busId = targetNode.busId;
          if (busId) {
            removeBusSend('input', sourceNode.deviceId?.toString() ?? '0', srcDevId, srcCh, 'bus', busId, tgtCh).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'bus') {
          // Bus -> Bus
          const srcBusId = sourceNode.busId;
          const tgtBusId = targetNode.busId;
          if (srcBusId && tgtBusId) {
            removeBusSend('bus', srcBusId, 0, srcCh, 'bus', tgtBusId, tgtCh).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'target') {
          // Bus -> Output
          const srcBusId = sourceNode.busId;
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (srcBusId && targetData) {
            removeBusSend('bus', srcBusId, 0, srcCh, 'output', targetData.deviceId, tgtCh).catch(console.error);
          }
        }
      }
    }
    setConnections(prev => prev.filter(c => c.id !== id));
  };

  // Update send level by connection ID (supports stereo linked pairs)
  const updateSendLevelByConnId = (connectionId: string, linkedConnectionId: string | undefined, level: number) => {
    const connIds = linkedConnectionId ? [connectionId, linkedConnectionId] : [connectionId];

    setConnections(prev => prev.map(c => {
      if (connIds.includes(c.id)) return { ...c, sendLevel: level };
      return c;
    }));

    // Update backend for all connections
    for (const connId of connIds) {
      const conn = connections.find(c => c.id === connId);
      if (!conn) continue;

      const sourceNode = nodesById.get(conn.fromNodeId);
      const targetNode = nodesById.get(conn.toNodeId);

      if (sourceNode && targetNode) {
        const srcDevId = getSourceDeviceId(sourceNode);
        const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
        const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);

        // Handle different connection types
        if (sourceNode.type === 'source' && targetNode.type === 'target') {
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (targetData) {
            updateMixerSend(srcDevId, srcCh, targetData.deviceId, tgtCh, level, conn.muted);
          }
        } else if (sourceNode.type === 'source' && targetNode.type === 'bus') {
          const busId = targetNode.busId;
          if (busId) {
            updateBusSend('input', sourceNode.deviceId?.toString() ?? '0', srcDevId, srcCh, 'bus', busId, tgtCh, level / 100, conn.muted).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'bus') {
          const srcBusId = sourceNode.busId;
          const tgtBusId = targetNode.busId;
          if (srcBusId && tgtBusId) {
            updateBusSend('bus', srcBusId, 0, srcCh, 'bus', tgtBusId, tgtCh, level / 100, conn.muted).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'target') {
          const srcBusId = sourceNode.busId;
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (srcBusId && targetData) {
            updateBusSend('bus', srcBusId, 0, srcCh, 'output', targetData.deviceId, tgtCh, level / 100, conn.muted).catch(console.error);
          }
        }
      }
    }
  };

  // Toggle mute by connection ID (supports stereo linked pairs)
  const toggleMuteByConnId = (connectionId: string, linkedConnectionId: string | undefined) => {
    const connIds = linkedConnectionId ? [connectionId, linkedConnectionId] : [connectionId];
    const currentConn = connections.find(c => c.id === connectionId);
    const newMuted = currentConn ? !currentConn.muted : false;

    setConnections(prev => prev.map(c => {
      if (connIds.includes(c.id)) return { ...c, muted: newMuted };
      return c;
    }));

    // Update backend for all connections
    for (const connId of connIds) {
      const conn = connections.find(c => c.id === connId);
      if (!conn) continue;

      const sourceNode = nodesById.get(conn.fromNodeId);
      const targetNode = nodesById.get(conn.toNodeId);

      if (sourceNode && targetNode) {
        const srcDevId = getSourceDeviceId(sourceNode);
        const srcCh = getChannelIndexForPort(sourceNode, conn.fromChannel);
        const tgtCh = getChannelIndexForPort(targetNode, conn.toChannel);

        // Handle different connection types
        if (sourceNode.type === 'source' && targetNode.type === 'target') {
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (targetData) {
            updateMixerSend(srcDevId, srcCh, targetData.deviceId, tgtCh, conn.sendLevel, newMuted);
          }
        } else if (sourceNode.type === 'source' && targetNode.type === 'bus') {
          const busId = targetNode.busId;
          if (busId) {
            updateBusSend('input', sourceNode.deviceId?.toString() ?? '0', srcDevId, srcCh, 'bus', busId, tgtCh, conn.sendLevel / 100, newMuted).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'bus') {
          const srcBusId = sourceNode.busId;
          const tgtBusId = targetNode.busId;
          if (srcBusId && tgtBusId) {
            updateBusSend('bus', srcBusId, 0, srcCh, 'bus', tgtBusId, tgtCh, conn.sendLevel / 100, newMuted).catch(console.error);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'target') {
          const srcBusId = sourceNode.busId;
          const targetData = outputTargets.find(t => t.id === targetNode.libraryId);
          if (srcBusId && targetData) {
            updateBusSend('bus', srcBusId, 0, srcCh, 'output', targetData.deviceId, tgtCh, conn.sendLevel / 100, newMuted).catch(console.error);
          }
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
    // Exclusive selection: Bus and Output are mutually exclusive for mixer view
    if (node.type === 'target') {
      setFocusedOutputId(node.id);
      setSelectedBusId(null); // Clear bus selection when selecting output
    }
    if (node.type === 'bus') {
      setSelectedBusId(node.id);
      // Don't clear focusedOutputId - keep it for reference but show bus mixer
    }

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
      // Find the source node to get channel offset
      const sourceNode = nodes.find(n => n.id === drawingWire.fromNode);
      const targetNode = nodes.find(n => n.id === nodeId);

      if (!sourceNode || !targetNode || drawingWire.fromNode === nodeId) {
        setDrawingWire(null);
        return;
      }

      // Check if target is a real output device or a bus
      const targetData = targetNode.type === 'target' ? outputTargets.find(t => t.id === targetNode.libraryId) : null;
      const targetDeviceInfo = targetData ? audioDevices.find(d => d.id === targetData.deviceId) : null;

      // Prevent Prism→Prism routing (causes feedback loop)
      if (targetDeviceInfo?.device_type === 'prism') {
        console.warn('Cannot route to Prism device - would cause feedback loop');
        setDrawingWire(null);
        return;
      }

      // Check if Shift is held for stereo pair connection (connect 2 channels at once)
      const isStereoPair = e.shiftKey;
      const srcPortCount = getPortCount(sourceNode);
      const tgtPortCount = getPortCount(targetNode);

      // Determine channels to connect
      const channelsToConnect: { srcPort: number; tgtPort: number }[] = [];

      if (isStereoPair) {
        // Shift+drop: connect L+R pair (current channel and next channel)
        // Make sure we're starting from an even index for proper L/R pairing
        const srcBase = Math.floor(drawingWire.fromCh / 2) * 2;
        const tgtBase = Math.floor(channelIndex / 2) * 2;

        // Connect L (even) and R (odd) if both exist
        if (srcBase < srcPortCount && tgtBase < tgtPortCount) {
          channelsToConnect.push({ srcPort: srcBase, tgtPort: tgtBase }); // L→L
        }
        if (srcBase + 1 < srcPortCount && tgtBase + 1 < tgtPortCount) {
          channelsToConnect.push({ srcPort: srcBase + 1, tgtPort: tgtBase + 1 }); // R→R
        }
      } else {
        // Normal: connect single channel
        channelsToConnect.push({ srcPort: drawingWire.fromCh, tgtPort: channelIndex });
      }

      const newConnections: Connection[] = [];

      for (const { srcPort, tgtPort } of channelsToConnect) {
        // Check if this connection already exists
        const exists = connections.some(c =>
          c.fromNodeId === drawingWire.fromNode &&
          c.fromChannel === srcPort &&
          c.toNodeId === nodeId &&
          c.toChannel === tgtPort
        );

        if (exists) continue;

        // Get actual channel index for source and target ports (1ch unit)
        const srcDevId = getSourceDeviceId(sourceNode);
        const srcCh = getChannelIndexForPort(sourceNode, srcPort);
        const tgtCh = getChannelIndexForPort(targetNode, tgtPort);

        // Handle different connection types
        if (sourceNode.type !== 'bus' && targetNode.type === 'target' && targetData) {
          // Input -> Output (direct connection)
          const deviceIdNum = parseInt(targetData.deviceId);
          if (!isNaN(deviceIdNum)) {
            startAudioOutput(deviceIdNum).catch(console.error);
          }

          const defaultLevel = 80; // Default send level

          // Update mixer send (1ch unit)
          updateMixerSend(srcDevId, srcCh, targetData.deviceId, tgtCh, defaultLevel, false);
          console.log(`Route device ${srcDevId} channel ${srcCh} → device ${targetData.deviceId} ch ${tgtCh}${isStereoPair ? ' (stereo pair)' : ''}`);
        } else if (sourceNode.type === 'source' && targetNode.type === 'bus') {
          // Input -> Bus
          const busId = targetNode.busId;
          if (busId) {
            const defaultLevel = 1.0; // 0dB unity
            updateBusSend(
              'input',
              sourceNode.deviceId?.toString() ?? '0',
              srcDevId,
              srcCh,
              'bus',
              busId,
              tgtCh,
              defaultLevel,
              false
            ).catch(console.error);
            console.log(`Bus route: Input ${srcDevId}:${srcCh} → Bus ${busId}:${tgtCh}`);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'bus') {
          // Bus -> Bus (chaining)
          const srcBusId = sourceNode.busId;
          const tgtBusId = targetNode.busId;
          if (srcBusId && tgtBusId) {
            const defaultLevel = 1.0;
            updateBusSend(
              'bus',
              srcBusId,
              0,
              srcCh,
              'bus',
              tgtBusId,
              tgtCh,
              defaultLevel,
              false
            ).catch(console.error);
            console.log(`Bus chain: Bus ${srcBusId}:${srcCh} → Bus ${tgtBusId}:${tgtCh}`);
          }
        } else if (sourceNode.type === 'bus' && targetNode.type === 'target' && targetData) {
          // Bus -> Output
          const srcBusId = sourceNode.busId;
          if (srcBusId) {
            const deviceIdNum = parseInt(targetData.deviceId);
            if (!isNaN(deviceIdNum)) {
              startAudioOutput(deviceIdNum).catch(console.error);
            }

            const defaultLevel = 1.0;
            updateBusSend(
              'bus',
              srcBusId,
              0,
              srcCh,
              'output',
              targetData.deviceId,
              tgtCh,
              defaultLevel,
              false
            ).catch(console.error);
            console.log(`Bus to output: Bus ${srcBusId}:${srcCh} → device ${targetData.deviceId}:${tgtCh}`);
          }
        }

        newConnections.push({
          id: `c_${Date.now()}_${srcPort}_${tgtPort}`,
          fromNodeId: drawingWire.fromNode,
          fromChannel: srcPort,
          toNodeId: nodeId,
          toChannel: tgtPort,
          sendLevel: dbToFader(0), // 0dB = unity gain
          muted: false
        });
      }

      if (newConnections.length > 0) {
        setConnections(prev => [...prev, ...newConnections]);
      }

      setDrawingWire(null);
    }
  }, [drawingWire, connections, nodes, audioDevices, outputTargets]);

  const activeTargets = nodes.filter(n => n.type === 'target');
  const focusedTarget = nodes.find(n => n.id === focusedOutputId);

  // Calculate port count for focused target (based on channel mode)
  const focusedTargetPorts = focusedTarget ? getPortCount(focusedTarget) : 0;

  // Check if focused target is in stereo mode
  const isStereoMode = focusedTarget?.channelMode === 'stereo';

  // Build mixer sources: each direct connection to the focused target becomes a mixer channel
  // Sources are Input nodes or Bus nodes - no recursive tracing
  type MixerSource = {
    nodeId: string;
    node: NodeData;
    fromChannel: number; // Source port index
    connectionId: string;
    // Stereo link support
    linkedConnectionId?: string; // ID of the R channel connection if stereo linked
    isStereoLinked?: boolean;
    isMonoToStereo?: boolean; // True if mono source is connected to both L and R
  };

  // Helper: Get direct connections to a target (no bus tracing)
  const getDirectConnections = useCallback((targetNodeId: string, targetChannel: number): { node: NodeData; fromChannel: number; connectionId: string }[] => {
    return connections
      .filter(c => c.toNodeId === targetNodeId && c.toChannel === targetChannel)
      .map(conn => {
        const sourceNode = nodesById.get(conn.fromNodeId);
        return sourceNode ? { node: sourceNode, fromChannel: conn.fromChannel, connectionId: conn.id } : null;
      })
      .filter((x): x is { node: NodeData; fromChannel: number; connectionId: string } => x !== null);
  }, [connections, nodesById]);

  // Mixer sources for Output selection (shows Inputs and Buses directly connected)
  const mixerSources = useMemo((): MixerSource[] => {
    if (!focusedOutputId) return [];

    const buildSourcesForChannels = (leftCh: number, rightCh?: number): MixerSource[] => {
      const leftConns = getDirectConnections(focusedOutputId, leftCh);
      const rightConns = rightCh !== undefined ? getDirectConnections(focusedOutputId, rightCh) : [];

      const sources: MixerSource[] = [];
      const usedRightIndices = new Set<number>();

      for (const lt of leftConns) {
        let matchingRightIdx = -1;
        let isMonoToStereo = false;

        if (rightCh !== undefined) {
          // Look for stereo pair: same source node, source channel + 1
          matchingRightIdx = rightConns.findIndex((rt, idx) =>
            rt.node.id === lt.node.id &&
            rt.fromChannel === lt.fromChannel + 1 &&
            !usedRightIndices.has(idx)
          );

          // If not found, look for mono-to-stereo: same source node, same source channel
          if (matchingRightIdx === -1) {
            matchingRightIdx = rightConns.findIndex((rt, idx) =>
              rt.node.id === lt.node.id &&
              rt.fromChannel === lt.fromChannel &&
              !usedRightIndices.has(idx)
            );
            if (matchingRightIdx !== -1) {
              isMonoToStereo = true;
            }
          }
        }

        if (matchingRightIdx !== -1) {
          usedRightIndices.add(matchingRightIdx);
          const rt = rightConns[matchingRightIdx];
          sources.push({
            nodeId: lt.node.id,
            node: lt.node,
            fromChannel: lt.fromChannel,
            connectionId: lt.connectionId,
            linkedConnectionId: rt.connectionId,
            isStereoLinked: true,
            isMonoToStereo,
          });
        } else {
          sources.push({
            nodeId: lt.node.id,
            node: lt.node,
            fromChannel: lt.fromChannel,
            connectionId: lt.connectionId,
            isStereoLinked: false,
          });
        }
      }

      // Add unmatched R connections as standalone mono
      if (rightCh !== undefined) {
        for (let idx = 0; idx < rightConns.length; idx++) {
          if (!usedRightIndices.has(idx)) {
            const rt = rightConns[idx];
            sources.push({
              nodeId: rt.node.id,
              node: rt.node,
              fromChannel: rt.fromChannel,
              connectionId: rt.connectionId,
              isStereoLinked: false,
            });
          }
        }
      }

      // Sort: Inputs first, then Buses, alphabetically within each
      return sources.sort((a, b) => {
        if (a.node.type !== b.node.type) {
          return a.node.type === 'source' ? -1 : 1;
        }
        return a.node.label.localeCompare(b.node.label);
      });
    };

    if (isStereoMode && focusedTarget) {
      const leftCh = focusedPairIndex * 2;
      const rightCh = focusedPairIndex * 2 + 1;
      return buildSourcesForChannels(leftCh, rightCh);
    } else {
      return buildSourcesForChannels(focusedPairIndex);
    }
  }, [focusedOutputId, focusedPairIndex, isStereoMode, focusedTarget, getDirectConnections]);

  // Mixer sources for Bus selection (shows Inputs connected to the selected bus)
  const selectedBus = nodes.find(n => n.id === selectedBusId);
  const busMixerSources = useMemo((): MixerSource[] => {
    if (!selectedBusId || !selectedBus) return [];

    const isBusStereo = selectedBus.channelMode === 'stereo';

    const buildSourcesForChannels = (leftCh: number, rightCh?: number): MixerSource[] => {
      const leftConns = getDirectConnections(selectedBusId, leftCh);
      const rightConns = rightCh !== undefined ? getDirectConnections(selectedBusId, rightCh) : [];

      const sources: MixerSource[] = [];
      const usedRightIndices = new Set<number>();

      for (const lt of leftConns) {
        let matchingRightIdx = -1;
        let isMonoToStereo = false;

        if (rightCh !== undefined) {
          matchingRightIdx = rightConns.findIndex((rt, idx) =>
            rt.node.id === lt.node.id &&
            rt.fromChannel === lt.fromChannel + 1 &&
            !usedRightIndices.has(idx)
          );

          if (matchingRightIdx === -1) {
            matchingRightIdx = rightConns.findIndex((rt, idx) =>
              rt.node.id === lt.node.id &&
              rt.fromChannel === lt.fromChannel &&
              !usedRightIndices.has(idx)
            );
            if (matchingRightIdx !== -1) {
              isMonoToStereo = true;
            }
          }
        }

        if (matchingRightIdx !== -1) {
          usedRightIndices.add(matchingRightIdx);
          const rt = rightConns[matchingRightIdx];
          sources.push({
            nodeId: lt.node.id,
            node: lt.node,
            fromChannel: lt.fromChannel,
            connectionId: lt.connectionId,
            linkedConnectionId: rt.connectionId,
            isStereoLinked: true,
            isMonoToStereo,
          });
        } else {
          sources.push({
            nodeId: lt.node.id,
            node: lt.node,
            fromChannel: lt.fromChannel,
            connectionId: lt.connectionId,
            isStereoLinked: false,
          });
        }
      }

      if (rightCh !== undefined) {
        for (let idx = 0; idx < rightConns.length; idx++) {
          if (!usedRightIndices.has(idx)) {
            const rt = rightConns[idx];
            sources.push({
              nodeId: rt.node.id,
              node: rt.node,
              fromChannel: rt.fromChannel,
              connectionId: rt.connectionId,
              isStereoLinked: false,
            });
          }
        }
      }

      return sources.sort((a, b) => a.node.label.localeCompare(b.node.label));
    };

    // For now, show all connections to bus channel 0 (or 0-1 for stereo)
    if (isBusStereo) {
      return buildSourcesForChannels(0, 1);
    } else {
      return buildSourcesForChannels(0);
    }
  }, [selectedBusId, selectedBus, getDirectConnections]);

  // getPairLabel is now inline where needed (stereo mode uses different logic)

  return (
    <div className="flex flex-col h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden select-none"
         onClick={() => setSelectedNodeId(null)}
    >

      {/* HEADER */}
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Workflow className="w-6 h-6 text-cyan-400" />
            <div>
              <div className="font-black text-lg tracking-tighter bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text text-transparent leading-none">Spectrum</div>
              <div className="text-[8px] text-slate-500 font-mono tracking-wider uppercase">Audio Mixer & Router</div>
            </div>
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
              <LogOut className="w-3 h-3" /> Input Sources
              {/* Connection status indicator - always visible */}
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

            {/* Input Source Mode Tabs */}
            <div className="flex gap-1 mb-2">
              <button
                onClick={() => {
                  setInputSourceMode('prism');
                  // Auto-select Prism device if available
                  if (prismDevice && selectedInputDeviceId !== prismDevice.device_id) {
                    startInputCapture(prismDevice.device_id).then(() => {
                      setSelectedInputDeviceId(prismDevice.device_id);
                      getActiveInputCaptures().then(setActiveCaptures);
                    }).catch(console.error);
                  }
                }}
                className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${
                  inputSourceMode === 'prism'
                    ? 'bg-cyan-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                } ${!prismDevice ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={!prismDevice}
              >
                Prism
              </button>
              <button
                onClick={() => setInputSourceMode('devices')}
                className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${
                  inputSourceMode === 'devices'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                Devices
              </button>
            </div>

            {selectedInputDevice?.is_prism && inputSourceMode === 'prism' && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
                <input type="text" placeholder="Channels..." className="w-full bg-slate-950 border border-slate-700 rounded-md py-1.5 pl-9 pr-3 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" />
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {/* Prism mode: Show channel list */}
            {inputSourceMode === 'prism' && prismDevice ? (
              <>
                {/* Open Prism App button */}
                <button
                  onClick={() => openPrismApp().catch(console.error)}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mb-2 rounded-md bg-slate-800/50 border border-slate-700/50 hover:border-slate-600 hover:bg-slate-800 text-slate-400 hover:text-slate-300 text-[10px] transition-all"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>Configure routing in Prism</span>
                </button>
                {/* Per-channel nodes with app assignment */}
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
              </>
            ) : inputSourceMode === 'prism' && !prismDevice ? (
              // Prism mode but no Prism device available
              <div className="text-center py-8 text-slate-600 text-xs">
                <div className="text-amber-400 mb-2">Prism not detected</div>
                <div>Install Prism driver to use per-app audio routing</div>
              </div>
            ) : inputSourceMode === 'devices' ? (
              // Devices mode: Show all non-Prism devices as a simple draggable list
              otherInputDevices.length > 0 ? (
                otherInputDevices.map(device => {
                  const deviceLibraryId = `dev_${device.device_id}`;
                  const isUsed = isLibraryItemUsed(deviceLibraryId);

                  return (
                    <div
                      key={deviceLibraryId}
                      onMouseDown={!isUsed ? (e) => handleLibraryMouseDown(e, 'lib_source', deviceLibraryId) : undefined}
                      className={`
                        group flex items-center gap-2 p-2 rounded-lg border transition-all relative overflow-hidden
                        ${isUsed
                          ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-default'
                          : 'border-slate-700/30 bg-slate-800/60 hover:border-amber-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing'}
                      `}
                    >
                      <div className="w-6 h-6 rounded-md flex items-center justify-center relative z-10 bg-slate-800 text-slate-500 group-hover:bg-amber-900/50 group-hover:text-amber-400">
                          <Mic className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0 relative z-10">
                        <div className="text-[10px] font-medium truncate text-slate-300">
                          {device.name}
                        </div>
                        <div className="text-[8px] text-slate-600">{device.channels}ch</div>
                      </div>
                      {!isUsed && (
                        <Plus className="w-3 h-3 text-slate-600 group-hover:text-amber-400 transition-colors opacity-0 group-hover:opacity-100 relative z-10" />
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-8 text-slate-600 text-xs">
                  No input devices available
                </div>
              )
            ) : null}
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
                  const start = nodesById.get(conn.fromNodeId);
                  const end = nodesById.get(conn.toNodeId);
                  if (!start || !end) return null;

                  const startPos = getPortPosition(start, conn.fromChannel, false);
                  const endPos = getPortPosition(end, conn.toChannel, true);

                  // Check if either node is unavailable
                  const isDisconnected = start.available === false || end.available === false;
                  const isBusConnection = start.type === 'bus' || end.type === 'bus';
                  const isActive = !isDisconnected && (end.id === focusedOutputId || (isBusConnection && selectedBusId && (start.id === selectedBusId || end.id === selectedBusId)));

                  // Determine stroke color based on connection type
                  let strokeColor = '#475569'; // default inactive
                  if (isDisconnected) {
                    strokeColor = '#64748b';
                  } else if (isActive) {
                    if (isBusConnection) {
                      strokeColor = '#a855f7'; // purple for bus
                    } else if (end.color.includes('cyan')) {
                      strokeColor = '#22d3ee';
                    } else {
                      strokeColor = '#f472b6';
                    }
                  }

                  const path = `M ${startPos.x} ${startPos.y} C ${startPos.x + 50} ${startPos.y}, ${endPos.x - 50} ${endPos.y}, ${endPos.x} ${endPos.y}`;

                  return (
                    <g key={conn.id} className="pointer-events-auto group cursor-pointer" onClick={(e) => { e.stopPropagation(); deleteConnection(conn.id); }}>
                      <path d={path} fill="none" stroke="transparent" strokeWidth="10" />
                      <path
                        d={path}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={isActive ? 2 : 1}
                        strokeDasharray={isDisconnected ? '4,4' : 'none'}
                        opacity={isDisconnected ? 0.5 : 1}
                        className="group-hover:stroke-red-400"
                      />
                      {isActive && !isDisconnected && (
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
                      <>
                        <path
                            d={`M ${drawingWire.startX} ${drawingWire.startY} C ${drawingWire.startX + 50} ${drawingWire.startY}, ${currentCanvasX - 50} ${currentCanvasY}, ${currentCanvasX} ${currentCanvasY}`}
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2"
                            strokeDasharray="4,4"
                        />
                        {/* Stereo hint tooltip near cursor */}
                        <g transform={`translate(${currentCanvasX + 12}, ${currentCanvasY - 8})`}>
                          <rect x="0" y="-10" width="100" height="16" rx="3" fill="rgba(15, 23, 42, 0.9)" stroke="rgba(100, 116, 139, 0.5)" strokeWidth="1" />
                          <text x="6" y="1" fontSize="9" fill="#94a3b8" fontFamily="ui-monospace, monospace">
                            <tspan fill="#22d3ee" fontWeight="bold">⇧ Shift</tspan>
                            <tspan fill="#64748b"> : Stereo</tspan>
                          </text>
                        </g>
                      </>
                    );
                })()}
              </g>
            </svg>

            {/* Nodes */}
            {nodes.map(node => {
              // Determine if this is a device node (non-Prism) or channel node (Prism)
              const isDeviceNode = node.sourceType === 'device';

              // For source nodes, get dynamic info from channelSources (Prism only)
              const channelData = (node.type === 'source' && !isDeviceNode)
                ? channelSources.find(c => c.id === node.libraryId)
                : null;

              // Dynamic display for Prism channel nodes
              const dynamicLabel = channelData ? `Ch ${channelData.channelLabel}` : node.label;
              const dynamicSubLabel = channelData
                ? (channelData.isMain
                    ? (channelData.apps.length > 0 ? `MAIN (${channelData.apps.length} apps)` : 'MAIN')
                    : (channelData.apps.map(a => a.name).join(', ') || 'Empty'))
                : node.subLabel;
              const dynamicIcon = isDeviceNode
                ? getDeviceNodeIcon(node)
                : (channelData
                    ? (channelData.isMain ? Volume2 : (channelData.apps[0]?.icon || Music))
                    : node.icon);
              const dynamicColor = isDeviceNode
                ? getDeviceNodeColor(node)
                : (channelData
                    ? (channelData.isMain ? 'text-cyan-400' : (channelData.apps[0]?.color || 'text-slate-500'))
                    : node.color);
              const NodeIcon = dynamicIcon;

              // Get level data for source nodes
              let avgLevel = 0;
              let meterColorClass = 'from-green-500/20';

              if (node.type === 'source') {
                if (isDeviceNode && node.deviceId !== undefined) {
                  // Device node: aggregate all channel levels from deviceLevelsMap
                  const numPairs = Math.floor(node.channelCount / 2);
                  const deviceLevels = deviceLevelsMap.get(node.deviceId);
                  if (deviceLevels) {
                    const maxDb = deviceLevels.slice(0, numPairs).reduce((max, l) => {
                      if (!l) return max;
                      return Math.max(max, rmsToDb(l.left_rms), rmsToDb(l.right_rms));
                    }, -60);
                    avgLevel = dbToMeterPercent(maxDb);
                    meterColorClass = maxDb > 0 ? 'from-red-500/30' :
                                      maxDb > -6 ? 'from-amber-500/25' :
                                      maxDb > -12 ? 'from-yellow-500/20' :
                                      'from-green-500/20';
                  }
                } else if (channelData) {
                  // Prism channel node: single pair level
                  const pairIndex = channelData.channelOffset / 2;
                  const levelData = inputLevels[pairIndex];
                  const leftDb = levelData ? rmsToDb(levelData.left_rms) : -60;
                  const rightDb = levelData ? rmsToDb(levelData.right_rms) : -60;
                  const maxDb = Math.max(leftDb, rightDb);
                  avgLevel = dbToMeterPercent(maxDb);
                  meterColorClass = maxDb > 0 ? 'from-red-500/30' :
                                    maxDb > -6 ? 'from-amber-500/25' :
                                    maxDb > -12 ? 'from-yellow-500/20' :
                                    'from-green-500/20';
                }
              }

              const isSelected = selectedNodeId === node.id;
              const isFocused = focusedOutputId === node.id;
              const portCount = getPortCount(node);
              const nodeHeight = 36 + 16 + (portCount * 24);
              const isUnavailable = node.available === false;

              let borderClass = 'border-slate-700';
              if (isUnavailable) {
                // Grayed out style for unavailable devices
                borderClass = 'border-slate-600/50';
              } else if (node.type === 'source') {
                if (isDeviceNode) {
                  borderClass = 'border-amber-500/30 hover:border-amber-500';
                } else {
                  borderClass = 'border-cyan-500/30 hover:border-cyan-500';
                }
              } else if (node.type === 'bus') {
                const isBusSelected = selectedBusId === node.id;
                borderClass = isBusSelected ? 'border-purple-500 ring-2 ring-purple-500/20' : 'border-purple-500/30 hover:border-purple-500';
              }
              if (node.type === 'target' && !isUnavailable) borderClass = isFocused ? 'border-pink-500 ring-2 ring-pink-500/20' : 'border-pink-500/30 hover:border-pink-500';
              if (isSelected && !isUnavailable) borderClass = 'border-white ring-2 ring-white/20';

              // Background class for unavailable nodes
              const bgClass = isUnavailable ? 'bg-slate-900/50' : 'bg-slate-800';

              return (
                <div
                  key={node.id}
                  ref={el => { if (el) nodeRefs.current.set(node.id, el); }}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
                  }}
                  className={`canvas-node absolute w-[180px] ${bgClass} rounded-lg shadow-xl border-2 group z-10 will-change-transform ${borderClass} ${isUnavailable ? 'opacity-50' : ''}`}
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
                  {/* Fixed width container for link icon or colored dot */}
                  <div className="w-3 h-3 flex items-center justify-center relative z-10 shrink-0">
                    {node.type === 'target' && node.channelMode === 'stereo' ? (
                      <LinkIcon className="w-3 h-3 text-cyan-400" />
                    ) : (
                      <div className={`w-2 h-2 rounded-full ${dynamicColor} shadow-[0_0_8px_currentColor]`}></div>
                    )}
                  </div>
                  <NodeIcon className={`w-4 h-4 ${isUnavailable ? 'text-slate-500' : dynamicColor} relative z-10`} />
                  <div className="flex-1 min-w-0 relative z-10">
                    {isUnavailable ? (
                      // Unavailable device: show disconnected status
                      <>
                        <span className="text-xs font-bold text-slate-500 truncate block">{node.label}</span>
                        <span className="text-[9px] text-red-400 truncate block">Disconnected</span>
                      </>
                    ) : isDeviceNode ? (
                      // Device node: show device name prominently
                      <>
                        <span className="text-xs font-bold text-amber-200 truncate block">{node.deviceName}</span>
                        <span className="text-[9px] text-slate-500 truncate block">{node.channelCount}ch Input</span>
                      </>
                    ) : node.type === 'source' ? (
                      // Prism channel node: show app info
                      <>
                        <span className="text-xs font-bold text-slate-200 truncate block">{dynamicSubLabel}</span>
                        <span className="text-[9px] text-slate-500 truncate block">{dynamicLabel}</span>
                      </>
                    ) : node.type === 'bus' ? (
                      // Bus node: show bus name and mode
                      <>
                        <span className="text-xs font-bold text-purple-200 truncate block">{node.label}</span>
                        <span className="text-[9px] text-slate-500 truncate block">
                          {node.channelMode === 'stereo' ? 'Stereo' : 'Mono'} • {node.plugins?.length || 0} FX
                        </span>
                      </>
                    ) : (
                      // Target node: show device name
                      <span className="text-xs font-bold text-slate-200 truncate block">{node.label}</span>
                    )}
                  </div>
                  <button onClick={(e) => {e.stopPropagation(); deleteNode(node.id)}} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity relative z-10"><Trash2 className="w-3 h-3"/></button>
                </div>

                {/* Ports Body - Channel Ports (based on channelMode) */}
                <div className="p-2 space-y-1 relative">
                    {Array.from({length: portCount}).map((_, portIdx) => {
                        const label = `CH ${getPortLabel(node, portIdx)}`;
                        const isMono = isPortMono(node, portIdx);

                        return (
                            <div key={portIdx} className="flex items-center justify-between h-5 relative">
                                {/* Input Port (Target and Bus) */}
                                <div className="w-3 relative h-full flex items-center">
                                    {(node.type === 'target' || node.type === 'bus') && (
                                        <div
                                            className={`absolute -left-[15px] w-3 h-3 rounded-full border border-slate-400 hover:scale-125 cursor-crosshair z-20 top-[4px] ${isMono ? 'bg-slate-500' : 'bg-slate-600'} ${node.type === 'bus' ? 'border-purple-400' : ''}`}
                                            onMouseUp={(e) => endWire(e, node.id, portIdx)}
                                        ></div>
                                    )}
                                </div>

                                <div className={`text-[9px] font-mono flex-1 text-center ${isMono ? 'text-slate-400' : 'text-slate-500'}`}>{label}</div>

                                {/* Output Port (Source and Bus) */}
                                <div className="w-3 relative h-full flex items-center">
                                    {(node.type === 'source' || node.type === 'bus') && (
                                        <div
                                            className={`absolute -right-[15px] w-3 h-3 rounded-full border border-slate-400 hover:bg-white cursor-crosshair z-20 top-[4px] ${isMono ? 'bg-slate-500' : 'bg-slate-600'} ${node.type === 'bus' ? 'border-purple-400' : ''}`}
                                            onMouseDown={(e) => startWire(e, node.id, portIdx)}
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
          {/* Bus Section */}
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-3">
              <Workflow className="w-3 h-3" /> Buses / Aux
            </div>
            <button
              onClick={() => {
                // Create a new bus at center of canvas
                const centerX = 400;
                const centerY = 250;
                const busNode = createNode('new_bus', 'bus', centerX, centerY);
                setNodes(prev => [...prev, busNode]);
                
                // Register bus in backend
                if (busNode.busId) {
                  addBus(busNode.busId, busNode.label, busNode.channelCount)
                    .then(() => console.log(`[Spectrum] Registered bus ${busNode.busId} in backend`))
                    .catch(console.error);
                }
              }}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-dashed border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/20 hover:border-purple-400 text-purple-400 hover:text-purple-300 transition-all text-xs font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Bus
            </button>
            {/* List existing buses */}
            <div className="mt-2 space-y-1">
              {nodes.filter(n => n.type === 'bus').map(bus => (
                <div
                  key={bus.id}
                  onClick={() => setSelectedBusId(bus.id)}
                  className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-all ${
                    selectedBusId === bus.id
                      ? 'bg-purple-500/20 border border-purple-500/50'
                      : 'bg-slate-800/50 border border-transparent hover:bg-slate-800'
                  }`}
                >
                  <Workflow className={`w-4 h-4 ${bus.color}`} />
                  <span className="text-xs text-slate-200 flex-1">{bus.label}</span>
                  <span className="text-[9px] text-slate-500 uppercase">{bus.channelMode}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Output Devices Section */}
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
        onMouseDown={(e) => handleResizeStart(e, 'top', mixerHeight, setMixerHeight, 220, 500)}
      />

      {/* BOTTOM: INTEGRATED MIXER & MASTER CONTROL */}
      <div
        className="bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30"
        style={{ height: mixerHeight }}
      >

        {/* BUS DETAIL VIEW (Shows when a bus is selected) */}
        {selectedBusId && (() => {
          const selectedBus = nodes.find(n => n.id === selectedBusId);
          if (!selectedBus || selectedBus.type !== 'bus') return null;

          return (
            <div className="w-64 bg-[#1a1f2e] border-r border-slate-700 flex flex-col shrink-0">
              {/* Bus Header */}
              <div className="h-8 bg-purple-900/30 border-b border-purple-500/30 flex items-center px-4 justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <Workflow className="w-3 h-3 text-purple-400" />
                  <span className="text-[10px] font-bold text-purple-300 uppercase tracking-widest">
                    {selectedBus.label}
                  </span>
                  <span className="text-[9px] text-slate-500 uppercase ml-1">
                    {selectedBus.channelMode}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedBusId(null)}
                  className="text-slate-500 hover:text-white transition-colors"
                >
                  ×
                </button>
              </div>

              {/* Effect Chain (Logic-style) */}
              <div className="flex-1 overflow-y-auto p-3">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                  Effect Chain
                </div>

                {/* Plugin Slots */}
                <div className="space-y-1">
                  {(selectedBus.plugins || []).length === 0 ? (
                    <div className="text-[10px] text-slate-600 text-center py-4">
                      No effects loaded
                    </div>
                  ) : (
                    selectedBus.plugins?.map((plugin, idx) => (
                      <div
                        key={plugin.id}
                        className={`flex items-center gap-2 p-2 rounded-lg border transition-all ${
                          plugin.enabled
                            ? 'bg-purple-500/10 border-purple-500/30'
                            : 'bg-slate-800/50 border-slate-700 opacity-50'
                        }`}
                      >
                        <div className="w-4 text-[9px] text-slate-500 text-center">{idx + 1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] font-medium text-slate-200 truncate">{plugin.name}</div>
                          <div className="text-[8px] text-slate-500 truncate">{plugin.manufacturer}</div>
                        </div>
                        <button
                          onClick={() => {
                            // Toggle plugin enabled state
                            setNodes(prev => prev.map(n => {
                              if (n.id === selectedBusId && n.plugins) {
                                return {
                                  ...n,
                                  plugins: n.plugins.map(p =>
                                    p.id === plugin.id ? { ...p, enabled: !p.enabled } : p
                                  ),
                                };
                              }
                              return n;
                            }));
                          }}
                          className={`w-6 h-6 rounded flex items-center justify-center text-[9px] font-bold transition-colors ${
                            plugin.enabled
                              ? 'bg-purple-500 text-white'
                              : 'bg-slate-700 text-slate-400'
                          }`}
                        >
                          {plugin.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Add Plugin Button */}
                <button
                  onClick={() => {
                    // TODO: Open AudioUnit plugin browser
                    // For now, add a placeholder plugin
                    const newPlugin: AudioUnitPlugin = {
                      id: `plugin_${Date.now()}`,
                      name: 'Placeholder Effect',
                      manufacturer: 'System',
                      type: 'effect',
                      enabled: true,
                    };
                    setNodes(prev => prev.map(n => {
                      if (n.id === selectedBusId) {
                        return {
                          ...n,
                          plugins: [...(n.plugins || []), newPlugin],
                        };
                      }
                      return n;
                    }));
                  }}
                  className="w-full mt-3 py-2 px-3 rounded-lg border border-dashed border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10 text-purple-400 hover:text-purple-300 transition-all text-[10px] font-medium flex items-center justify-center gap-2"
                >
                  <Plus className="w-3 h-3" />
                  Add AudioUnit
                </button>
              </div>

              {/* Bus Controls */}
              <div className="p-3 border-t border-slate-700 bg-slate-900/50">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => toggleChannelMode(selectedBusId)}
                    className="px-3 py-1.5 rounded text-[10px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                  >
                    {selectedBus.channelMode === 'stereo' ? 'Switch to Mono' : 'Switch to Stereo'}
                  </button>
                  <button
                    onClick={() => deleteNode(selectedBusId)}
                    className="p-1.5 rounded text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* MIXER AREA (LEFT) */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#162032]">
          <div className="h-8 bg-slate-900/50 border-b border-slate-800 flex items-center px-4 justify-between shrink-0">
            <div className="flex items-center gap-3">
              <Maximize2 className="w-3 h-3 text-slate-500" />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {/* Bus selected: show bus mixing header */}
                {selectedBus ? (
                  <>Mixing for <span className="text-purple-400 ml-1">{selectedBus.label}</span>
                    <span className={`ml-2 px-1.5 py-0.5 rounded text-[8px] ${selectedBus.channelMode === 'stereo' ? 'bg-purple-500/20 text-purple-400' : 'bg-slate-600/50 text-slate-400'}`}>
                      {selectedBus.channelMode === 'stereo' ? 'STEREO' : 'MONO'}
                    </span>
                  </>
                ) : focusedTarget ? (
                  <>Mixing for <span className={`text-white ${focusedTarget.available === false ? 'text-slate-500' : focusedTarget.color} ml-1`}>{focusedTarget.label}</span>
                    {focusedTarget.available === false && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[8px] bg-red-500/20 text-red-400">
                        DISCONNECTED
                      </span>
                    )}
                    {focusedTarget.available !== false && focusedTargetPorts > 1 && (
                      <span className="text-slate-400 ml-1">
                        {isStereoMode
                          ? `Ch ${focusedPairIndex * 2 + 1}-${focusedPairIndex * 2 + 2}`
                          : `Ch ${focusedPairIndex + 1}`}
                      </span>
                    )}
                    {focusedTarget.available !== false && (
                      <span className={`ml-2 px-1.5 py-0.5 rounded text-[8px] ${isStereoMode ? 'bg-cyan-500/20 text-cyan-400' : 'bg-slate-600/50 text-slate-400'}`}>
                        {isStereoMode ? 'STEREO' : 'MONO'}
                      </span>
                    )}
                  </>
                ) : (
                  'Select Output or Bus on Canvas to Mix'
                )}
              </span>
            </div>
          </div>

          <div className="flex-1 flex overflow-x-auto p-4 gap-2 items-stretch">
            {/* Use busMixerSources when bus is selected, otherwise mixerSources */}
            {(selectedBus ? busMixerSources : mixerSources).map(ms => {
                const { node, fromChannel, connectionId, linkedConnectionId, isStereoLinked, isMonoToStereo } = ms;
                const isBusNode = node.type === 'bus';
                const conn = connections.find(c => c.id === connectionId);
                const level = conn ? conn.sendLevel : 0;
                const isMuted = conn ? conn.muted : false;

                // Check if this is a device node (non-Prism)
                const isDeviceNode = node.sourceType === 'device';

                // Get dynamic info from channelSources (Prism only)
                const channelData = !isDeviceNode ? channelSources.find(c => c.id === node.libraryId) : null;

                // Dynamic display based on node type and source channel
                // For stereo linked (true stereo pair), show both channels like "1-2"
                // For mono-to-stereo, show single channel like "1" (mono source to stereo output)
                const sourcePortLabel = isStereoLinked
                  ? (isMonoToStereo ? `${fromChannel + 1}` : `${fromChannel + 1}-${fromChannel + 2}`)
                  : getPortLabel(node, fromChannel);
                const sourceIsMono = !isStereoLinked && isPortMono(node, fromChannel);
                // For Prism: channelData.channelLabel is stereo pair label like "7-8"
                // In mono mode, show individual channel based on fromChannel (0=L, 1=R of pair)
                // In stereo linked mode, show the full pair label (or single for mono-to-stereo)
                let prismChLabel = '';
                if (channelData) {
                  const baseChannel = channelData.channelOffset; // e.g., 6 for ch7-8
                  if (isStereoLinked && !isMonoToStereo) {
                    // Stereo: show pair like "7-8"
                    prismChLabel = `${baseChannel + 1}-${baseChannel + 2}`;
                  } else {
                    // Mono or mono-to-stereo: show individual channel like "7" or "8"
                    const actualChannel = baseChannel + fromChannel + 1;
                    prismChLabel = `${actualChannel}`;
                  }
                }
                const dynamicLabel = isDeviceNode
                  ? `Ch ${sourcePortLabel}`  // Show specific channel for device
                  : (channelData ? `Ch ${prismChLabel}` : node.label);

                // Add bus routing info to sublabel if routed via bus
                const baseSubLabel = isDeviceNode
                  ? node.deviceName  // Show device name as sub label
                  : (channelData
                      ? (channelData.isMain
                          ? (channelData.apps.length > 0 ? `MAIN (${channelData.apps.length} apps)` : 'MAIN')
                          : (channelData.apps.map(a => a.name).join(', ') || 'Empty'))
                      : node.subLabel);
                const dynamicSubLabel = isBusNode
                  ? `${node.channelMode} • ${node.plugins?.length || 0} FX`
                  : baseSubLabel;
                const dynamicIcon = isBusNode
                  ? Workflow
                  : isDeviceNode
                    ? getDeviceNodeIcon(node)
                    : (channelData
                        ? (channelData.isMain ? Volume2 : (channelData.apps[0]?.icon || Music))
                        : node.icon);
                const dynamicColor = isBusNode
                  ? 'text-purple-400'
                  : isDeviceNode
                    ? getDeviceNodeColor(node)
                    : (channelData
                        ? (channelData.isMain ? 'text-cyan-400' : (channelData.apps[0]?.color || 'text-slate-500'))
                        : node.color);
                const NodeIcon = dynamicIcon;

                // Get real input levels for this specific channel pair (dB conversion)
                let leftDb = -60;
                let rightDb = -60;

                if (isDeviceNode) {
                  // Device node: get level from deviceLevelsMap for the specific device
                  const deviceId = node.deviceId;
                  const deviceLevels = deviceId !== undefined ? deviceLevelsMap.get(deviceId) : undefined;
                  if (isStereoLinked) {
                    if (isMonoToStereo) {
                      // Mono source to stereo output: use same channel level for both L and R
                      const levelData = deviceLevels?.[Math.floor(fromChannel / 2)];
                      leftDb = levelData ? rmsToDb(levelData.left_peak) : -60;
                      rightDb = leftDb; // Same level for both (mono source)
                    } else {
                      // True stereo linked: L from fromChannel, R from fromChannel+1
                      const leftLevelData = deviceLevels?.[Math.floor(fromChannel / 2)];
                      const rightLevelData = deviceLevels?.[Math.floor((fromChannel + 1) / 2)];
                      leftDb = leftLevelData ? rmsToDb(leftLevelData.left_peak) : -60;
                      rightDb = rightLevelData ? rmsToDb(rightLevelData.right_peak) : -60;
                    }
                  } else {
                    const levelData = deviceLevels?.[Math.floor(fromChannel / 2)];
                    const isRightCh = fromChannel % 2 === 1;
                    leftDb = levelData ? rmsToDb(isRightCh ? levelData.right_peak : levelData.left_peak) : -60;
                    rightDb = leftDb; // Mono display
                  }
                } else {
                  const channelOffset = node.channelOffset ?? 0;
                  // For Prism, channelOffset is already the stereo pair index * 2
                  // fromChannel 0 = L, fromChannel 1 = R of that pair
                  const pairIndex = Math.floor((channelOffset + fromChannel) / 2);
                  const levelData = inputLevels[pairIndex];
                  if (isStereoLinked) {
                    // Stereo linked: use L and R from the same pair
                    leftDb = levelData ? rmsToDb(levelData.left_peak) : -60;
                    rightDb = levelData ? rmsToDb(levelData.right_peak) : -60;
                  } else {
                    // Mono: use appropriate channel based on odd/even
                    const isRightChannel = (channelOffset + fromChannel) % 2 === 1;
                    const peakVal = levelData ? (isRightChannel ? levelData.right_peak : levelData.left_peak) : 0;
                    leftDb = rmsToDb(peakVal);
                    rightDb = leftDb; // Same for mono display
                  }
                }

                // Calculate post-fader level (input dB + fader gain dB)
                const faderDb = faderToDb(level);
                const postFaderLeftDb = faderDb <= -100 ? -Infinity : leftDb + faderDb;
                const postFaderRightDb = faderDb <= -100 ? -Infinity : rightDb + faderDb;

                // Unique key for mixer channel (node + source channel)
                const mixerKey = `${node.id}_ch${fromChannel}${isStereoLinked ? '_stereo' : ''}`;

                // Check if source or target node is unavailable
                const isSourceUnavailable = node.available === false;
                const isTargetUnavailable = focusedTarget?.available === false;
                const isChannelDisabled = isSourceUnavailable || isTargetUnavailable;

                return (
                <div key={mixerKey} className={`w-32 bg-slate-900 border rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none ${isStereoLinked ? 'border-cyan-500/50' : isDeviceNode ? 'border-amber-500/30' : 'border-slate-700'} ${isChannelDisabled ? 'opacity-40 grayscale' : ''}`}>
                    {/* Stereo link indicator */}
                    {isStereoLinked && (
                      <div className="absolute top-1 right-1">
                        <LinkIcon className="w-3 h-3 text-cyan-400" />
                      </div>
                    )}
                    <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
                    <div className={`w-6 h-6 rounded-lg bg-slate-800 border border-slate-600 flex items-center justify-center shadow-lg ${dynamicColor}`}>
                        <NodeIcon className="w-3 h-3" />
                    </div>
                    </div>
                    <div className="w-full px-1 text-center mb-2">
                    <div className="text-[7px] text-slate-500 font-mono">{dynamicLabel}</div>
                    <div className={`text-[9px] font-bold truncate ${isDeviceNode ? 'text-amber-200' : 'text-slate-300'}`}>{dynamicSubLabel || 'Empty'}</div>
                    </div>
                    <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
                    {/* Fader with scale on left */}
                    <div className="relative mr-2">
                      {/* Left: Fader Scale (+6dB = top) - matches Logic Pro X */}
                      <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none">
                        {/* Scale tick marks and labels - clickable */}
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ top: '0', transform: 'translateY(-50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(6))}>
                          <span className="mr-0.5">+6</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(3)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(3))}>
                          <span className="mr-0.5">+3</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-cyan-400" style={{ bottom: `${dbToFader(0)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(0))}>
                          <span className="mr-0.5 text-white font-bold">0</span>
                          <div className="w-2.5 h-px bg-white"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-3)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-3))}>
                          <span className="mr-0.5">-3</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-6)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-6))}>
                          <span className="mr-0.5">-6</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-10)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-10))}>
                          <span className="mr-0.5 text-[6px]">-10</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-15)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-15))}>
                          <span className="mr-0.5 text-[6px]">-15</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-20)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-20))}>
                          <span className="mr-0.5 text-[6px]">-20</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-30)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-30))}>
                          <span className="mr-0.5 text-[6px]">-30</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: `${dbToFader(-40)}%`, transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(-40))}>
                          <span className="mr-0.5 text-[6px]">-40</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                        <div className="absolute right-0 flex items-center cursor-pointer hover:text-white" style={{ bottom: '0', transform: 'translateY(50%)' }} onClick={() => updateSendLevelByConnId(connectionId, linkedConnectionId, 0)}>
                          <span className="mr-0.5">-∞</span>
                          <div className="w-1.5 h-px bg-slate-500"></div>
                        </div>
                      </div>
                      <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                          <input
                              type="range" min="0" max="100" value={level} disabled={isMuted}
                              onChange={(e) => updateSendLevelByConnId(connectionId, linkedConnectionId, Number(e.target.value))}
                              className={`absolute inset-0 h-full w-6 -left-2 opacity-0 z-20 appearance-slider-vertical ${isMuted ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                          />
                          <div className={`absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10 ${isMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${level}% - 5px)` }}></div>
                      </div>
                    </div>
                    {/* Level Meters on right */}
                    <div className="flex gap-0.5 relative">
                      {sourceIsMono ? (
                        /* Mono meter - single wider meter */
                        <div className="w-3 h-full bg-slate-950 rounded-sm overflow-hidden relative border border-slate-800">
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
                      ) : (
                        /* Stereo meters - Left and Right */
                        <>
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
                        </>
                      )}
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
                    {editingDbNodeId === mixerKey ? (
                      <input
                        type="text"
                        autoFocus
                        className="w-12 text-[8px] font-mono text-center bg-slate-800 border border-cyan-500 rounded px-1 py-0.5 mt-1 text-cyan-400 outline-none"
                        value={editingDbValue}
                        onChange={(e) => setEditingDbValue(e.target.value)}
                        onBlur={() => {
                          const trimmed = editingDbValue.trim().toLowerCase();
                          if (trimmed === '-inf' || trimmed === 'inf' || trimmed === '-∞' || trimmed === '∞') {
                            updateSendLevelByConnId(connectionId, linkedConnectionId, 0);
                          } else {
                            const parsed = parseFloat(trimmed);
                            if (!isNaN(parsed)) {
                              const clampedDb = Math.max(-100, Math.min(6, parsed));
                              updateSendLevelByConnId(connectionId, linkedConnectionId, dbToFader(clampedDb));
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
                          setEditingDbNodeId(mixerKey);
                        }}
                      >
                        {isMuted ? 'MUTE' : faderToDb(level) <= -60 ? '-∞' : `${faderToDb(level) >= 0 ? '+' : ''}${faderToDb(level).toFixed(1)}dB`}
                      </div>
                    )}
                    <div className="flex gap-1 mt-1 w-full px-1">
                    <button onClick={() => toggleMuteByConnId(connectionId, linkedConnectionId)} className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>M</button>
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

             {/* 1. Channel Port Selector (Left) */}
             {focusedTarget && focusedTargetPorts > 1 && (
               <div className="w-14 flex flex-col gap-1 overflow-y-auto border-r border-slate-800 pr-2 min-h-0">
                 <div className="text-[8px] font-bold text-slate-600 mb-1 text-center shrink-0">
                   {isStereoMode ? 'PAIR' : 'CH'}
                 </div>
                 {/* In stereo mode, show pairs (0 = ch 1-2, 1 = ch 3-4, etc.) */}
                 {/* In mono mode, show individual channels */}
                 {Array.from({ length: isStereoMode ? Math.ceil(focusedTargetPorts / 2) : focusedTargetPorts }).map((_, idx) => {
                   const isPortSelected = focusedPairIndex === idx;
                   const label = isStereoMode
                     ? `${idx * 2 + 1}-${Math.min(idx * 2 + 2, focusedTargetPorts)}`
                     : `${idx + 1}`;
                   return (
                     <button
                       key={idx}
                       onClick={() => setFocusedPairIndex(idx)}
                       className={`
                         w-full py-1.5 rounded text-[9px] font-bold border transition-all text-center shrink-0
                         ${isPortSelected
                           ? `bg-${focusedTarget.color.split('-')[1]}-500/20 border-${focusedTarget.color.split('-')[1]}-500 text-white`
                           : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'}
                       `}
                     >
                       {label}
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
                                ${node.available === false
                                  ? 'opacity-40 grayscale border-slate-800'
                                  : isSelected
                                    ? `bg-slate-800 border-${node.color.split('-')[1]}-500/50`
                                    : 'border-slate-800 hover:border-slate-600'}
                            `}
                        >
                            <div className={`w-5 h-5 rounded flex items-center justify-center bg-slate-950 ${node.available === false ? 'text-slate-500' : node.color}`}>
                                <Icon className="w-3 h-3" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-[10px] font-bold truncate ${node.available === false ? 'text-slate-500' : isSelected ? 'text-white' : 'text-slate-400'}`}>{node.label}</div>
                                {node.available === false && <div className="text-[8px] text-red-400">Disconnected</div>}
                            </div>
                            {isSelected && node.available !== false && <div className={`w-1.5 h-1.5 rounded-full ${node.color.replace('text-', 'bg-')} animate-pulse`}></div>}
                        </div>
                    );
                })}
             </div>

             {/* 3. Master Fader (Right) */}
             {focusedTarget && (() => {
                 // Calculate master levels from connected sources
                 // In stereo mode, need to consider both L and R channels
                 const leftCh = focusedPairIndex * 2;
                 const rightCh = focusedPairIndex * 2 + 1;
                 const connectedSources = isStereoMode
                   ? connections.filter(c => c.toNodeId === focusedTarget.id && (c.toChannel === leftCh || c.toChannel === rightCh))
                   : connections.filter(c => c.toNodeId === focusedTarget.id && c.toChannel === focusedPairIndex);
                 let masterLeftRms = 0;
                 let masterRightRms = 0;

                 // Track which connections we've processed to avoid double-counting stereo pairs
                 const processedConnIds = new Set<string>();

                 for (const conn of connectedSources) {
                   if (conn.muted) continue;
                   if (processedConnIds.has(conn.id)) continue;

                   const sourceNode = nodes.find(n => n.id === conn.fromNodeId);
                   if (!sourceNode) continue;

                   // Determine level data based on source type
                   let levelData: { left_rms: number; right_rms: number; left_peak: number; right_peak: number } | undefined;
                   const isDeviceSource = sourceNode.sourceType === 'device';

                   if (isDeviceSource && sourceNode.deviceId !== undefined) {
                     // Device node: use deviceLevelsMap with conn.fromChannel to get the correct pair
                     const deviceLevels = deviceLevelsMap.get(sourceNode.deviceId);
                     const pairIdx = Math.floor(conn.fromChannel / 2);
                     levelData = deviceLevels?.[pairIdx];
                   } else {
                     // Prism channel: use inputLevels
                     const channelOffset = sourceNode.channelOffset ?? 0;
                     const pairIdx = channelOffset / 2;
                     levelData = inputLevels[pairIdx];
                   }

                   if (levelData) {
                     const sendGain = faderToDb(conn.sendLevel) <= -100 ? 0 : Math.pow(10, faderToDb(conn.sendLevel) / 20);

                     // In stereo mode, determine if this is L or R channel
                     if (isStereoMode) {
                       const isLeftChannel = conn.toChannel === leftCh;
                       const isRightChannel = conn.toChannel === rightCh;

                       // Check for stereo pair or mono-to-stereo
                       const pairedConn = connectedSources.find(c =>
                         c.fromNodeId === conn.fromNodeId &&
                         c.id !== conn.id &&
                         !processedConnIds.has(c.id)
                       );

                       if (pairedConn) {
                         // Mark paired connection as processed
                         processedConnIds.add(conn.id);
                         processedConnIds.add(pairedConn.id);

                         const pairedGain = faderToDb(pairedConn.sendLevel) <= -100 ? 0 : Math.pow(10, faderToDb(pairedConn.sendLevel) / 20);

                         // Check if mono-to-stereo (same fromChannel) or true stereo pair
                         const isMonoToStereo = conn.fromChannel === pairedConn.fromChannel;

                         if (isMonoToStereo) {
                           // Mono source to stereo output: use same level for both
                           const monoLevel = levelData.left_peak; // Use left (mono) level
                           if (isLeftChannel) {
                             masterLeftRms += Math.pow(monoLevel * sendGain, 2);
                             masterRightRms += Math.pow(monoLevel * pairedGain, 2);
                           } else {
                             masterLeftRms += Math.pow(monoLevel * pairedGain, 2);
                             masterRightRms += Math.pow(monoLevel * sendGain, 2);
                           }
                         } else {
                           // True stereo pair
                           if (isLeftChannel) {
                             masterLeftRms += Math.pow(levelData.left_peak * sendGain, 2);
                             masterRightRms += Math.pow(levelData.right_peak * pairedGain, 2);
                           } else {
                             masterLeftRms += Math.pow(levelData.left_peak * pairedGain, 2);
                             masterRightRms += Math.pow(levelData.right_peak * sendGain, 2);
                           }
                         }
                       } else {
                         // Single channel (L only or R only)
                         processedConnIds.add(conn.id);
                         if (isLeftChannel) {
                           masterLeftRms += Math.pow(levelData.left_peak * sendGain, 2);
                         } else if (isRightChannel) {
                           masterRightRms += Math.pow(levelData.right_peak * sendGain, 2);
                         }
                       }
                     } else {
                       // Mono mode: sum both L and R
                       masterLeftRms += Math.pow(levelData.left_peak * sendGain, 2);
                       masterRightRms += Math.pow(levelData.right_peak * sendGain, 2);
                     }
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
                  // Check if it's a device node (dev_xxx)
                  if (libraryDrag.id.startsWith('dev_')) {
                    const deviceId = parseInt(libraryDrag.id.replace('dev_', ''), 10);
                    const device = inputDevices.find(d => d.device_id === deviceId);
                    return device?.name || 'Device';
                  }
                  // Prism channel
                  const ch = channelSources.find(c => c.id === libraryDrag.id);
                  return ch?.isMain ? 'Ch 1-2 (MAIN)' : `Ch ${ch?.channelLabel || '?'}`;
                })()
              : outputTargets.find(t => t.id === libraryDrag.id)?.name
            }
          </span>
        </div>
      )}

      {/* Node Context Menu */}
      {contextMenu && (() => {
        const node = nodes.find(n => n.id === contextMenu.nodeId);
        if (!node) return null;
        return (
          <>
            {/* Backdrop to close menu on click outside */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setContextMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
            />
            {/* Context Menu */}
            <div
              className="fixed z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl py-1 min-w-[160px]"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="px-3 py-1.5 text-[10px] text-slate-500 font-medium border-b border-slate-700">
                {node.label || node.deviceName || 'Node'}
              </div>

              {/* Node info */}
              <div className="px-3 py-1.5 text-[10px] text-slate-400">
                {node.channelCount}ch • {node.type === 'source' ? 'Input' : node.type === 'bus' ? 'Bus' : 'Output'}
                {(node.type === 'target' || node.type === 'bus') && ` • ${node.channelMode === 'stereo' ? 'Stereo' : 'Mono'}`}
              </div>

              {/* Channel Mode Toggle (for output nodes and bus nodes with 2+ channels) */}
              {(node.type === 'target' || node.type === 'bus') && node.channelCount >= 1 && (
                <>
                  <div className="border-t border-slate-700 my-1" />
                  <button
                    onClick={() => { toggleChannelMode(contextMenu.nodeId); setContextMenu(null); }}
                    className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 flex items-center gap-2"
                  >
                    <LinkIcon className="w-4 h-4" />
                    <span>{node.channelMode === 'stereo' ? 'Switch to Mono' : 'Switch to Stereo'}</span>
                  </button>
                </>
              )}

              {/* Separator */}
              <div className="border-t border-slate-700 my-1" />

              {/* Delete Node */}
              <button
                onClick={() => { deleteNode(contextMenu.nodeId); setContextMenu(null); }}
                className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/20 flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                <span>Delete Node</span>
              </button>
            </div>
          </>
        );
      })()}

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
