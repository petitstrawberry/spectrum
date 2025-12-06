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
  // setRouting, // TODO: Re-enable when channel routing is implemented
  type AppSource, 
  type DriverStatus 
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

// --- Output Targets (Hardware/Virtual outputs) ---

const LIBRARY_TARGETS = [
  { id: 'out_main', name: 'Main Speakers', type: 'Hardware', icon: Speaker, color: 'text-cyan-400', channels: 2 },
  { id: 'out_phones', name: 'Headphones', type: 'Hardware', icon: Headphones, color: 'text-cyan-400', channels: 2 },
  { id: 'out_obs', name: 'OBS Stream', type: 'Virtual', icon: Radio, color: 'text-pink-400', channels: 2 },
  { id: 'out_zoom', name: 'Zoom Mic', type: 'Virtual', icon: Video, color: 'text-purple-400', channels: 1 },
  { id: 'out_blackhole', name: 'BlackHole 16ch', type: 'System', icon: Monitor, color: 'text-slate-400', channels: 16 },
];

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
  const [driverStatus, setDriverStatus] = useState<DriverStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // --- Prism Daemon Communication ---
  const fetchPrismData = async () => {
    try {
      const [apps, status] = await Promise.all([
        getPrismApps(),
        getDriverStatus(),
      ]);
      setPrismApps(apps);
      setDriverStatus(status);
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

  // Fetch on mount and poll every 2 seconds
  useEffect(() => {
    fetchPrismData();
    const interval = setInterval(fetchPrismData, 2000);
    return () => clearInterval(interval);
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

  // --- Initial Setup ---
  useEffect(() => {
    // Create initial target nodes only (sources will be added from prism apps)
    const t1 = createNode('out_main', 'target', 600, 100);
    const t2 = createNode('out_obs', 'target', 600, 250);

    setNodes([t1, t2]);
    setConnections([]);
    setFocusedOutputId(t1.id);
  }, []);

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
          volume: 100,
          muted: false,
          channelCount: 2, // Always stereo pair
          channelOffset: channelData.channelOffset,
        };
      }
    }
    
    // Target nodes
    const targetData = LIBRARY_TARGETS.find(t => t.id === libraryId);
    return {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      libraryId,
      type,
      label: targetData?.name || 'Unknown',
      subLabel: `${targetData?.channels}ch / ${targetData?.type}`,
      icon: targetData?.icon || Grid,
      color: targetData?.color || 'text-slate-400',
      x, y,
      volume: 100,
      muted: false,
      channelCount: targetData?.channels || 2,
    };
  }, [channelSources]);

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
    setNodes(prev => prev.filter(n => n.id !== id));
    setConnections(prev => prev.filter(c => c.fromNodeId !== id && c.toNodeId !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    if (focusedOutputId === id) setFocusedOutputId(null);
  };

  const deleteConnection = (id: string) => {
    setConnections(prev => prev.filter(c => c.id !== id));
  };

  const updateSendLevel = (sourceId: string, targetId: string, pairIndex: number, level: number) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex) return { ...c, sendLevel: level };
      return c;
    }));
  };

  const toggleConnectionMute = (sourceId: string, targetId: string, pairIndex: number) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId && c.toChannel === pairIndex) return { ...c, muted: !c.muted };
      return c;
    }));
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

        if (nodeType === 'target') setFocusedOutputId(newNode.id);
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
        
        // Calculate channel offset based on target channel pair
        // Each pair is 2 channels, so pair 0 = offset 0, pair 1 = offset 2, etc.
        const targetChannelOffset = channelIndex * 2;

        // TODO: Implement channel-to-channel routing
        // For now, log the routing attempt
        if (sourceNode?.channelOffset !== undefined) {
          console.log(`Route from channel ${sourceNode.channelOffset} to channel ${targetChannelOffset}`);
        }

        setConnections(prev => [...prev, {
          id: `c_${Date.now()}`,
          fromNodeId: drawingWire.fromNode,
          fromChannel: drawingWire.fromCh,
          toNodeId: nodeId,
          toChannel: channelIndex,
          sendLevel: 80,
          muted: false
        }]);
      }
      setDrawingWire(null);
    }
  }, [drawingWire, connections, nodes]);

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
        <button className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors">
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
              
              return (
                <div
                  key={channel.id}
                  onMouseDown={!isUsed ? (e) => handleLibraryMouseDown(e, 'lib_source', channel.id) : undefined}
                  className={`
                    group flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all
                    ${isUsed
                      ? 'border-transparent bg-slate-900/30 opacity-40 cursor-default'
                      : hasApps
                        ? 'border-slate-700/50 bg-slate-800/60 hover:border-cyan-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing'
                        : 'border-transparent bg-slate-900/20 hover:border-slate-700/50 hover:bg-slate-900/40 cursor-grab active:cursor-grabbing'}
                  `}
                >
                  {/* Channel number */}
                  <div className={`w-10 text-[10px] font-mono font-bold ${hasApps ? 'text-cyan-400' : 'text-slate-600'}`}>
                    {channel.channelLabel}
                  </div>
                  
                  {/* App info */}
                  {channel.isMain ? (
                    // MAIN channel - show icon and app count
                    <div className="flex-1 flex items-center gap-2 min-w-0">
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
                    <div className="flex-1 flex items-center gap-2 min-w-0">
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
                    <div className="flex-1 text-[10px] text-slate-600 italic">Empty</div>
                  )}
                  
                  {!isUsed && <Plus className="w-3 h-3 text-slate-700 group-hover:text-cyan-400 transition-colors opacity-0 group-hover:opacity-100" />}
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
              const NodeIcon = node.icon;
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
                {/* Header */}
                <div className="h-9 bg-slate-900/50 rounded-t-lg border-b border-slate-700/50 flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing">
                  <div className={`w-2 h-2 rounded-full ${node.color} shadow-[0_0_8px_currentColor]`}></div>
                  <NodeIcon className={`w-4 h-4 ${node.color}`} />
                  <span className="text-xs font-bold text-slate-200 flex-1 truncate">{node.label}</span>
                  <button onClick={(e) => {e.stopPropagation(); deleteNode(node.id)}} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-3 h-3"/></button>
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
            {LIBRARY_TARGETS.map(item => {
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
                    <div className="text-[9px] text-slate-500 uppercase">{item.type}</div>
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
                const NodeIcon = node.icon;

                return (
                <div key={node.id} className="w-16 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none">
                    <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
                    <div className={`w-6 h-6 rounded-lg bg-slate-800 border border-slate-600 flex items-center justify-center shadow-lg ${node.color}`}>
                        <NodeIcon className="w-3 h-3" />
                    </div>
                    </div>
                    <div className="w-full px-1 text-center mb-2">
                    <div className="text-[9px] font-bold truncate text-slate-300">{node.label}</div>
                    </div>
                    <div className="flex-1 w-full px-4 flex gap-1.5 justify-center relative">
                    <div className="w-1 h-full bg-slate-800 rounded-full overflow-hidden relative">
                        <div className="absolute bottom-0 w-full bg-gradient-to-t from-green-500 to-cyan-400 opacity-60 animate-meter" style={{ '--meter-height': isMuted ? '0%' : '70%' } as React.CSSProperties}></div>
                    </div>
                    <div className="w-1.5 h-full bg-slate-950 rounded-full relative group/fader">
                        <input
                            type="range" min="0" max="100" value={level} disabled={isMuted}
                            onChange={(e) => updateSendLevel(node.id, focusedOutputId!, focusedPairIndex, Number(e.target.value))}
                            className={`absolute inset-0 h-full w-6 -left-2 opacity-0 z-20 appearance-slider-vertical ${isMuted ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        />
                        <div className={`absolute left-1/2 -translate-x-1/2 w-6 h-3 bg-slate-700 border-t border-b border-slate-500 rounded shadow pointer-events-none z-10 ${isMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${level}% - 6px)` }}></div>
                    </div>
                    </div>
                    <div className="flex gap-1 mt-2 w-full px-1">
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
             {focusedTarget && (
                 <div className="w-16 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none shadow-xl">
                    <div className="text-[8px] font-bold text-slate-500 mb-2">MASTER</div>
                    <div className="flex-1 w-full px-4 flex gap-1.5 justify-center relative">
                        {/* Multi-channel Meter */}
                        <div className="w-1 h-full bg-slate-800 rounded-full overflow-hidden relative">
                            <div className="absolute bottom-0 w-full bg-gradient-to-t from-cyan-600 to-blue-500 opacity-80 animate-meter-l"></div>
                        </div>
                        <div className="w-1 h-full bg-slate-800 rounded-full overflow-hidden relative">
                            <div className="absolute bottom-0 w-full bg-gradient-to-t from-cyan-600 to-blue-500 opacity-80 animate-meter-r"></div>
                        </div>
                        {/* Fader */}
                        <div className="absolute inset-0 w-full group/master">
                            <input
                                type="range" min="0" max="100" value={focusedTarget.volume}
                                onChange={(e) => updateMasterVolume(focusedTarget.id, Number(e.target.value))}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20 appearance-slider-vertical"
                            />
                            <div
                                className="absolute left-1/2 -translate-x-1/2 w-8 h-4 bg-slate-700 border border-slate-500 rounded shadow-lg pointer-events-none z-10 flex items-center justify-center"
                                style={{ bottom: `calc(${focusedTarget.volume}% - 8px)` }}
                            >
                                <div className="w-4 h-0.5 bg-white"></div>
                            </div>
                        </div>
                    </div>
                    <div className="text-[9px] font-mono font-bold text-slate-300 mt-2">-0.0</div>
                 </div>
             )}
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
              : LIBRARY_TARGETS.find(t => t.id === libraryDrag.id)?.name
            }
          </span>
        </div>
      )}
    </div>
  );
}
