import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Settings,
  Search,
  Maximize2,
  Grid,
  Workflow,
  Mic,
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
} from 'lucide-react';

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

// --- Mock Data (will be replaced with real data from prismd) ---

const LIBRARY_SOURCES = [
  { id: 'src_spotify', name: 'Spotify', icon: Music, color: 'text-green-400', channel: 'Ch 1-2', channels: 2 },
  { id: 'src_discord', name: 'Discord', icon: MessageSquare, color: 'text-indigo-400', channel: 'Ch 3-4', channels: 2 },
  { id: 'src_game', name: 'Apex Legends', icon: Gamepad2, color: 'text-red-400', channel: 'Ch 5-6', channels: 6 },
  { id: 'src_chrome', name: 'Chrome', icon: Globe, color: 'text-blue-400', channel: 'Ch 7-8', channels: 2 },
  { id: 'src_mic', name: 'Mic Input', icon: Mic, color: 'text-amber-400', channel: 'Ch 9-10', channels: 1 },
];

const LIBRARY_TARGETS = [
  { id: 'out_main', name: 'Main Speakers', type: 'Hardware', icon: Speaker, color: 'text-cyan-400', channels: 2 },
  { id: 'out_phones', name: 'Headphones', type: 'Hardware', icon: Headphones, color: 'text-cyan-400', channels: 2 },
  { id: 'out_obs', name: 'OBS Stream', type: 'Virtual', icon: Radio, color: 'text-pink-400', channels: 2 },
  { id: 'out_zoom', name: 'Zoom Mic', type: 'Virtual', icon: Video, color: 'text-purple-400', channels: 1 },
  { id: 'out_blackhole', name: 'BlackHole 16ch', type: 'System', icon: Monitor, color: 'text-slate-400', channels: 16 },
];

export default function App() {
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);

  // Selection State
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedOutputId, setFocusedOutputId] = useState<string | null>(null);

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

  // --- Initial Setup ---
  useEffect(() => {
    const n1 = createNode('src_spotify', 'source', 100, 100);
    const n2 = createNode('src_discord', 'source', 100, 250);
    const t1 = createNode('out_main', 'target', 600, 100);
    const t2 = createNode('out_obs', 'target', 600, 250);

    setNodes([n1, n2, t1, t2]);

    setConnections([
      { id: 'c1', fromNodeId: n1.id, fromChannel: 0, toNodeId: t1.id, toChannel: 0, sendLevel: 80, muted: false },
      { id: 'c2', fromNodeId: n1.id, fromChannel: 1, toNodeId: t1.id, toChannel: 1, sendLevel: 80, muted: false },
      { id: 'c3', fromNodeId: n2.id, fromChannel: 0, toNodeId: t1.id, toChannel: 0, sendLevel: 90, muted: false },
      { id: 'c4', fromNodeId: n2.id, fromChannel: 1, toNodeId: t1.id, toChannel: 1, sendLevel: 90, muted: false },
      { id: 'c5', fromNodeId: n1.id, fromChannel: 0, toNodeId: t2.id, toChannel: 0, sendLevel: 60, muted: false },
      { id: 'c6', fromNodeId: n1.id, fromChannel: 1, toNodeId: t2.id, toChannel: 1, sendLevel: 60, muted: false },
    ]);

    setFocusedOutputId(t1.id);
  }, []);

  // --- Helpers ---

  const createNode = (libraryId: string, type: NodeType, x: number, y: number): NodeData => {
    let data: (typeof LIBRARY_SOURCES[0]) | (typeof LIBRARY_TARGETS[0]) | undefined;
    if (type === 'source') data = LIBRARY_SOURCES.find(s => s.id === libraryId);
    else data = LIBRARY_TARGETS.find(t => t.id === libraryId);

    const sourceData = data as typeof LIBRARY_SOURCES[0] | undefined;
    const targetData = data as typeof LIBRARY_TARGETS[0] | undefined;

    return {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      libraryId,
      type,
      label: data?.name || 'Unknown',
      subLabel: type === 'source' ? sourceData?.channel : `${targetData?.channels}ch / ${targetData?.type}`,
      icon: data?.icon || Grid,
      color: data?.color || 'text-slate-400',
      x, y,
      volume: 100,
      muted: false,
      channelCount: data?.channels || 2
    };
  };

  const getPortPosition = useCallback((node: NodeData, channelIndex: number, isInput: boolean) => {
    const headerHeight = 36;
    const portHeight = 20;
    const portSpacing = 4;
    const startY = node.y + headerHeight + 16;
    const y = startY + (channelIndex * (portHeight + portSpacing)) + (portHeight / 2);
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

  const updateSendLevel = (sourceId: string, targetId: string, level: number) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId) return { ...c, sendLevel: level };
      return c;
    }));
  };

  const toggleConnectionMute = (sourceId: string, targetId: string) => {
    setConnections(prev => prev.map(c => {
      if (c.fromNodeId === sourceId && c.toNodeId === targetId) return { ...c, muted: !c.muted };
      return c;
    }));
  };

  const updateMasterVolume = (nodeId: string, val: number) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, volume: val } : n));
  };

  // --- D&D Handlers (Library items) ---

  const handleDragStart = (e: React.DragEvent, type: string, id: string) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type, id }));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dataStr = e.dataTransfer.getData('application/json');
    if (!dataStr) return;
    const data = JSON.parse(dataStr);

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left - 90;
    const y = e.clientY - rect.top - 30;

    const type: NodeType = data.type === 'lib_source' ? 'source' : 'target';
    const newNode = createNode(data.id, type, x, y);
    setNodes(prev => [...prev, newNode]);

    if (type === 'target') setFocusedOutputId(newNode.id);
  };

  // --- Node Dragging (DOM-based, no state during drag) ---

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;

    const { nodeId, startX, startY } = dragRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const nodeEl = nodeRefs.current.get(nodeId);
    if (nodeEl) {
      nodeEl.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    // Update drag offset for cable rendering
    setDragOffset({ nodeId, dx, dy });
  }, []);

  const handleDragEnd = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;

    const { nodeId, startX, startY, nodeStartX, nodeStartY } = dragRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

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
  }, [handleDragMove]);

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

  // Cleanup event listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [handleDragMove, handleDragEnd]);

  // --- Wire Drawing ---

  const startWire = useCallback((e: React.MouseEvent, nodeId: string, channelIndex: number) => {
    e.stopPropagation();
    e.preventDefault();

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const pos = getPortPosition(node, channelIndex, false);

    setDrawingWire({
      fromNode: nodeId,
      fromCh: channelIndex,
      startX: pos.x,
      startY: pos.y,
      currentX: e.clientX - rect.left,
      currentY: e.clientY - rect.top,
    });

    const handleWireMove = (ev: MouseEvent) => {
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return;
      setDrawingWire(prev => prev ? {
        ...prev,
        currentX: ev.clientX - r.left,
        currentY: ev.clientY - r.top,
      } : null);
    };

    const handleWireEnd = () => {
      setDrawingWire(null);
      document.removeEventListener('mousemove', handleWireMove);
      document.removeEventListener('mouseup', handleWireEnd);
    };

    document.addEventListener('mousemove', handleWireMove);
    document.addEventListener('mouseup', handleWireEnd);
  }, [nodes]);

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
  }, [drawingWire, connections]);

  const activeTargets = nodes.filter(n => n.type === 'target');
  const focusedTarget = nodes.find(n => n.id === focusedOutputId);

  const mixSourceIds = Array.from(new Set(connections
    .filter(c => c.toNodeId === focusedOutputId)
    .map(c => c.fromNodeId)));
  const mixSources = nodes.filter(n => n.type === 'source' && mixSourceIds.includes(n.id));

  const targetGroups = activeTargets.reduce((acc, target) => {
    const type = target.subLabel?.split('/')[1]?.trim() || 'Other';
    if (!acc[type]) acc[type] = [];
    acc[type].push(target);
    return acc;
  }, {} as Record<string, NodeData[]>);

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
        <div className="w-64 bg-[#111827] border-r border-slate-800 flex flex-col shrink-0 z-10 shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2">
              <LogOut className="w-3 h-3" /> Sources
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
              <input type="text" placeholder="Apps..." className="w-full bg-slate-950 border border-slate-700 rounded-md py-1.5 pl-9 pr-3 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            {LIBRARY_SOURCES.map(item => {
              const isUsed = isLibraryItemUsed(item.id);
              const ItemIcon = item.icon;
              return (
                <div
                  key={item.id}
                  draggable={!isUsed}
                  onDragStart={(e) => handleDragStart(e, 'lib_source', item.id)}
                  className={`
                    group flex items-center gap-3 p-3 rounded-xl border transition-all
                    ${isUsed
                      ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-default grayscale'
                      : 'border-slate-700 bg-slate-800/80 hover:border-cyan-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing hover:shadow-md'}
                  `}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center bg-slate-950 ${item.color}`}>
                    <ItemIcon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-200 truncate">{item.name}</div>
                    <div className="text-[9px] text-slate-500 font-mono">{item.channel}</div>
                  </div>
                  {!isUsed && <Plus className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 transition-colors" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* CENTER: PATCH CANVAS */}
        <div
          ref={canvasRef}
          className="flex-1 bg-[#0b1120] relative overflow-hidden cursor-crosshair"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {/* Grid */}
          <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: 'radial-gradient(#475569 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

          {/* Connection Lines */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
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

            {drawingWire && (
                <path
                    d={`M ${drawingWire.startX} ${drawingWire.startY} C ${drawingWire.startX + 50} ${drawingWire.startY}, ${drawingWire.currentX - 50} ${drawingWire.currentY}, ${drawingWire.currentX} ${drawingWire.currentY}`}
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2"
                    strokeDasharray="4,4"
                />
            )}
          </svg>

          {/* Nodes */}
          {nodes.map(node => {
            const NodeIcon = node.icon;
            const isSelected = selectedNodeId === node.id;
            const isFocused = focusedOutputId === node.id;
            const portCount = node.channelCount;
            const nodeHeight = 36 + 16 + (portCount * 24);

            let borderClass = 'border-slate-700';
            if (node.type === 'source') borderClass = 'border-cyan-500/30 hover:border-cyan-500';
            if (node.type === 'target') borderClass = isFocused ? 'border-pink-500 ring-2 ring-pink-500/20' : 'border-pink-500/30 hover:border-pink-500';
            if (isSelected) borderClass = 'border-white ring-2 ring-white/20';

            return (
              <div
                key={node.id}
                ref={el => { if (el) nodeRefs.current.set(node.id, el); }}
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                className={`absolute w-[180px] bg-slate-800 rounded-lg shadow-xl border-2 group z-10 will-change-transform ${borderClass}`}
                style={{ left: node.x, top: node.y, height: nodeHeight }}
              >
                {/* Header */}
                <div className="h-9 bg-slate-900/50 rounded-t-lg border-b border-slate-700/50 flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing">
                  <div className={`w-2 h-2 rounded-full ${node.color} shadow-[0_0_8px_currentColor]`}></div>
                  <NodeIcon className={`w-4 h-4 ${node.color}`} />
                  <span className="text-xs font-bold text-slate-200 flex-1 truncate">{node.label}</span>
                  <button onClick={(e) => {e.stopPropagation(); deleteNode(node.id)}} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-3 h-3"/></button>
                </div>

                {/* Ports Body */}
                <div className="p-2 space-y-1 relative">
                    {Array.from({length: portCount}).map((_, i) => (
                        <div key={i} className="flex items-center justify-between h-5 relative">
                            {/* Input Port (Target Only) */}
                            <div className="w-3 relative">
                                {node.type === 'target' && (
                                    <div
                                        className="absolute -left-3 w-3 h-3 bg-slate-600 rounded-full border border-slate-400 hover:scale-125 cursor-crosshair z-20"
                                        onMouseUp={(e) => endWire(e, node.id, i)}
                                    ></div>
                                )}
                            </div>

                            <div className="text-[9px] text-slate-500 font-mono flex-1 text-center">CH {i+1}</div>

                            {/* Output Port (Source Only) */}
                            <div className="w-3 relative">
                                {node.type === 'source' && (
                                    <div
                                        className="absolute -right-3 w-3 h-3 bg-slate-600 rounded-full border border-slate-400 hover:bg-white cursor-crosshair z-20"
                                        onMouseDown={(e) => startWire(e, node.id, i)}
                                    ></div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT SIDEBAR: OUTPUTS LIBRARY */}
        <div className="w-64 bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 z-10 shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="p-4 border-b border-slate-800 bg-slate-900/50">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              <LinkIcon className="w-3 h-3" /> Output Devices
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            {LIBRARY_TARGETS.map(item => {
              const isUsed = nodes.some(n => n.libraryId === item.id);
              const ItemIcon = item.icon;
              return (
                <div
                  key={item.id}
                  draggable={!isUsed}
                  onDragStart={(e) => handleDragStart(e, 'lib_target', item.id)}
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

      {/* BOTTOM: INTEGRATED MIXER & MASTER CONTROL */}
      <div className="h-64 bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30">

        {/* MIXER AREA (LEFT) */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#162032]">
          <div className="h-8 bg-slate-900/50 border-b border-slate-800 flex items-center px-4 justify-between shrink-0">
            <div className="flex items-center gap-3">
              <Maximize2 className="w-3 h-3 text-slate-500" />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {focusedTarget ? (
                  <>Mixing for <span className={`text-white ${focusedTarget.color} ml-1`}>{focusedTarget.label}</span></>
                ) : (
                  'Select Output on Canvas to Mix'
                )}
              </span>
            </div>
          </div>

          <div className="flex-1 flex overflow-x-auto p-4 gap-2 items-stretch custom-scrollbar">
            {mixSources.map(node => {
                const conn = connections.find(c => c.fromNodeId === node.id && c.toNodeId === focusedOutputId);
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
                            onChange={(e) => updateSendLevel(node.id, focusedOutputId!, Number(e.target.value))}
                            className={`absolute inset-0 h-full w-6 -left-2 opacity-0 z-20 appearance-slider-vertical ${isMuted ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        />
                        <div className={`absolute left-1/2 -translate-x-1/2 w-6 h-3 bg-slate-700 border-t border-b border-slate-500 rounded shadow pointer-events-none z-10 ${isMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${level}% - 6px)` }}></div>
                    </div>
                    </div>
                    <div className="flex gap-1 mt-2 w-full px-1">
                    <button onClick={() => toggleConnectionMute(node.id, focusedOutputId!)} className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}>M</button>
                    </div>
                </div>
                )
            })}
          </div>
        </div>

        {/* MASTER SECTION (RIGHT) */}
        <div className="w-64 bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 relative shadow-2xl">
          <div className="p-2 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
              <Monitor className="w-3 h-3" /> Master & Monitor
            </div>
          </div>

          <div className="flex-1 flex gap-2 p-3">

             {/* 1. Monitor Selection (Left) */}
             <div className="flex-1 flex flex-col gap-2 overflow-y-auto custom-scrollbar">
                {Object.keys(targetGroups).map(type => (
                    <div key={type} className="mb-2">
                        <div className="text-[9px] font-bold text-slate-600 px-1 mb-1">{type.toUpperCase()}</div>
                        {targetGroups[type].map(node => {
                            const isSelected = focusedOutputId === node.id;
                            const Icon = node.icon;
                            return (
                                <div
                                    key={node.id}
                                    onClick={() => setFocusedOutputId(node.id)}
                                    className={`
                                        flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all mb-1
                                        ${isSelected
                                        ? `bg-slate-800 border-${node.color.split('-')[1]}-500/50 ring-1 ring-${node.color.split('-')[1]}-500/50`
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
                ))}
             </div>

             {/* 2. Master Fader (Right) */}
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
    </div>
  );
}
