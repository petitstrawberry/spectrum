/**
 * Spectrum v2 - Audio Mixer & Router
 *
 * Rebuilt with v2 Pure Sends-on-Fader architecture
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Settings,
  Workflow,
  Headphones,
  Speaker,
  LogOut,
  Plus,
  Trash2,
  RefreshCw,
  Volume2,
  Mic,
} from 'lucide-react';

import {
  useGraph,
  useMeters,
  useDevices,
  useAudio,
  type MeterData,
} from './hooks';
import SpectrumLayout from './ui/SpectrumLayout';
import type { UINode, UIEdge } from './types/graph';
import { getInputPorts, getOutputPorts } from './types/graph';

// =============================================================================
// Helper Functions
// =============================================================================

function faderToDb(faderValue: number): number {
  if (faderValue <= 0) return -Infinity;
  if (faderValue >= 127) return 10;
  const normalized = faderValue / 100;
  return 40 * Math.log10(normalized);
}

function dbToFader(db: number): number {
  if (!isFinite(db) || db <= -100) return 0;
  if (db >= 10) return 127;
  const normalized = Math.pow(10, db / 40);
  return Math.round(normalized * 100);
}

function dbToMeterPercent(db: number): number {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;
  return ((db + 60) / 60) * 100;
}

// =============================================================================
// Components
// =============================================================================

interface NodeComponentProps {
  node: UINode;
  isSelected: boolean;
  meters: MeterData | null;
  onSelect: (handle: number) => void;
  onDelete: (handle: number) => void;
  onPositionChange: (handle: number, x: number, y: number) => void;
  onPortMouseDown: (nodeHandle: number, portIndex: number, isInput: boolean, e: React.MouseEvent) => void;
}

function NodeComponent({
  node,
  isSelected,
  meters,
  onSelect,
  onDelete,
  onPositionChange,
  onPortMouseDown,
}: NodeComponentProps) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
  } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.handle);

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      onPositionChange(node.handle, dragRef.current.nodeX + dx, dragRef.current.nodeY + dy);
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [node, onSelect, onPositionChange]);

  const Icon = node.icon;
  const peakDb = meters ? Math.max(...meters.outputPeaks.map(p => 20 * Math.log10(Math.max(0.00001, p)))) : -60;
  const meterPercent = dbToMeterPercent(peakDb);

  const colorClass = node.type === 'source'
    ? 'border-cyan-500/50 bg-cyan-900/20'
    : node.type === 'bus'
    ? 'border-purple-500/50 bg-purple-900/20'
    : 'border-pink-500/50 bg-pink-900/20';

  const inputPorts = getInputPorts(node);
  const outputPorts = getOutputPorts(node);

  return (
    <div
      className={`absolute w-48 rounded-lg border-2 ${colorClass} ${isSelected ? 'ring-2 ring-white/30' : ''} cursor-grab active:cursor-grabbing`}
      style={{ left: node.x, top: node.y }}
      onMouseDown={handleMouseDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-2 bg-slate-900/80 rounded-t-lg border-b border-slate-700/50">
        <div className={`w-6 h-6 rounded flex items-center justify-center ${node.color}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate text-slate-200">{node.label}</div>
          <div className="text-[9px] text-slate-500">{node.type}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node.handle); }}
          className="p-1 hover:bg-red-500/20 rounded text-slate-500 hover:text-red-400"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Meter Bar */}
      <div className="h-1 bg-slate-950">
        <div
          className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500"
          style={{ width: `${meterPercent}%` }}
        />
      </div>

      {/* Ports */}
      <div className="flex justify-between p-2 bg-slate-900/60 rounded-b-lg">
        {/* Input Ports */}
        <div className="flex flex-col gap-1">
          {inputPorts.map((portIdx) => (
            <div
              key={portIdx}
              className="flex items-center gap-1 cursor-pointer"
              onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(node.handle, portIdx, true, e); }}
            >
              <div className="w-2 h-2 rounded-full bg-cyan-400 hover:bg-cyan-300" />
              <span className="text-[9px] text-slate-500">{portIdx + 1}</span>
            </div>
          ))}
        </div>

        {/* Output Ports */}
        <div className="flex flex-col gap-1 items-end">
          {outputPorts.map((portIdx) => (
            <div
              key={portIdx}
              className="flex items-center gap-1 cursor-pointer"
              onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(node.handle, portIdx, false, e); }}
            >
              <span className="text-[9px] text-slate-500">{portIdx + 1}</span>
              <div className="w-2 h-2 rounded-full bg-pink-400 hover:bg-pink-300" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface EdgeFaderProps {
  edge: UIEdge;
  sourceNode: UINode | undefined;
  targetNode: UINode | undefined;
  meters: { peak: number; rms: number } | undefined;
  onGainChange: (id: number, gain: number) => void;
  onMutedChange: (id: number, muted: boolean) => void;
}

function EdgeFader({ edge, sourceNode, targetNode, meters, onGainChange, onMutedChange }: EdgeFaderProps) {
  const [faderValue, setFaderValue] = useState(() => dbToFader(edge.gain));
  const db = faderToDb(faderValue);
  const peakDb = meters ? 20 * Math.log10(Math.max(0.00001, meters.peak)) : -60;
  const meterPercent = dbToMeterPercent(peakDb);

  const handleFaderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    setFaderValue(val);
    const db = faderToDb(val);
    const gain = db <= -100 ? 0 : Math.pow(10, db / 20);
    onGainChange(edge.id, gain);
  }, [edge.id, onGainChange]);

  return (
    <div className="flex flex-col items-center p-2 bg-slate-800/50 rounded-lg min-w-[80px]">
      <div className="text-[9px] text-slate-400 truncate max-w-full mb-1">
        {sourceNode?.label || '?'} → {targetNode?.label || '?'}
      </div>
      <div className="text-[8px] text-slate-500 mb-1">
        {edge.sourcePort + 1} → {edge.targetPort + 1}
      </div>

      {/* Vertical fader */}
      <div className="relative h-24 w-8 flex flex-col items-center">
        {/* Meter background */}
        <div className="absolute inset-x-1 top-0 bottom-0 bg-slate-950 rounded">
          <div
            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-green-500 via-yellow-500 to-red-500 rounded"
            style={{ height: `${meterPercent}%` }}
          />
        </div>

        {/* Fader track */}
        <input
          type="range"
          min="0"
          max="127"
          value={faderValue}
          onChange={handleFaderChange}
          className="absolute w-24 -rotate-90 origin-center"
          style={{ top: '50%', left: '-30px' }}
        />
      </div>

      {/* dB value */}
      <div className={`text-[10px] mt-1 ${edge.muted ? 'text-red-400' : 'text-slate-300'}`}>
        {db <= -100 ? '-∞' : db.toFixed(1)} dB
      </div>

      {/* Mute button */}
      <button
        onClick={() => onMutedChange(edge.id, !edge.muted)}
        className={`mt-1 px-2 py-0.5 text-[9px] rounded ${edge.muted ? 'bg-red-500 text-white' : 'bg-slate-700 text-slate-400'}`}
      >
        {edge.muted ? 'MUTED' : 'M'}
      </button>
    </div>
  );
}

// =============================================================================
// Main App
// =============================================================================

export default function App() {
  // Hooks
  const graph = useGraph();
  const meters = useMeters({ enabled: true });
  const devices = useDevices();
  const audio = useAudio();

  // UI State
  const [selectedNodeHandle, setSelectedNodeHandle] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Canvas state
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, scale: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);

  // Wire drawing state
  const [drawingWire, setDrawingWire] = useState<{
    fromNode: number;
    fromPort: number;
    isOutput: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Node array for iteration (convert Map to array)
  const nodesArray = useMemo(() => Array.from(graph.nodes.values()), [graph.nodes]);
  const edgesArray = useMemo(() => Array.from(graph.edges.values()), [graph.edges]);

  // Node map for quick lookup
  const nodesById = useMemo(() => {
    return graph.nodes;
  }, [graph.nodes]);

  // Selected node
  const selectedNode = selectedNodeHandle !== null ? nodesById.get(selectedNodeHandle) : null;

  // Port mouse down handler
  const handlePortMouseDown = useCallback((nodeHandle: number, portIndex: number, isInput: boolean, e: React.MouseEvent) => {
    const node = nodesById.get(nodeHandle);
    if (!node) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // For outputs, we start drawing a wire
    // For inputs, we check if there's a wire being drawn
    if (!isInput) {
      setDrawingWire({
        fromNode: nodeHandle,
        fromPort: portIndex,
        isOutput: true,
        startX: node.x + 192, // Right side of node
        startY: node.y + 50 + portIndex * 16,
        currentX: (e.clientX - rect.left - canvasTransform.x) / canvasTransform.scale,
        currentY: (e.clientY - rect.top - canvasTransform.y) / canvasTransform.scale,
      });
    }
  }, [nodesById, canvasTransform]);

  // Canvas mouse move for wire drawing
  useEffect(() => {
    if (!drawingWire) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      setDrawingWire(prev => prev ? {
        ...prev,
        currentX: (e.clientX - rect.left - canvasTransform.x) / canvasTransform.scale,
        currentY: (e.clientY - rect.top - canvasTransform.y) / canvasTransform.scale,
      } : null);
    };

    const handleMouseUp = () => {
      setDrawingWire(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [drawingWire, canvasTransform]);

  // Handle canvas wheel for zoom
  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setCanvasTransform(prev => ({
      ...prev,
      scale: Math.max(0.25, Math.min(2, prev.scale * delta)),
    }));
  }, []);

  // Handle canvas pan
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);

  const handleCanvasPanStart = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        canvasX: canvasTransform.x,
        canvasY: canvasTransform.y,
      };
    }
  }, [canvasTransform]);

  useEffect(() => {
    if (!isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panStart.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setCanvasTransform(prev => ({
        ...prev,
        x: panStart.current!.canvasX + dx,
        y: panStart.current!.canvasY + dy,
      }));
    };

    const handleMouseUp = () => {
      setIsPanning(false);
      panStart.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning]);

  // Add source node handler
  const handleAddSource = useCallback(async (type: 'prism' | 'device', deviceId?: number, channel?: number) => {
    if (type === 'prism' && channel !== undefined) {
      await graph.addSource(
        { type: 'prism_channel', channel },
        `Prism Ch ${channel + 1}-${channel + 2}`
      );
    } else if (type === 'device' && deviceId !== undefined) {
      await graph.addSource(
        { type: 'input_device', device_id: deviceId, channel: channel || 0 },
        devices.inputDevices.find(d => d.deviceId === deviceId)?.name || 'Input'
      );
    }
  }, [graph, devices.inputDevices]);

  // Add bus handler
  const handleAddBus = useCallback(async () => {
    const busCount = nodesArray.filter(n => n.type === 'bus').length;
    await graph.addBus(`Bus ${busCount + 1}`, 2);
  }, [graph, nodesArray]);

  // Add sink handler
  const handleAddSink = useCallback(async (deviceId: number, channelOffset: number, channelCount: number) => {
    const device = devices.outputDevices.find(d => d.deviceId === deviceId);
    await graph.addSink(
      { device_id: deviceId, channel_offset: channelOffset, channel_count: channelCount },
      device?.name || 'Output'
    );
  }, [graph, devices.outputDevices]);

  // Get edges connected to selected node for mixer view
  const selectedNodeEdges = useMemo(() => {
    if (!selectedNode) return [];
    return edgesArray.filter(e =>
      e.sourceHandle === selectedNode.handle || e.targetHandle === selectedNode.handle
    );
  }, [selectedNode, edgesArray]);

  // prevent unused-local/type errors while V1 UI is displayed and v2 wiring proceeds
  ;(() => {
    void Settings; void Workflow; void Headphones; void Speaker; void LogOut; void Plus; void Trash2; void RefreshCw; void Volume2; void Mic;
    void NodeComponent; void EdgeFader; void meters; void audio; void graph; void nodesArray; void edgesArray; void nodesById; void selectedNode;
    void handlePortMouseDown; void handleCanvasWheel; void handleCanvasPanStart; void handleAddSource; void handleAddBus; void handleAddSink; void selectedNodeEdges;
    void setSelectedNodeHandle; void showSettings; void setShowSettings;
  })();

  return <SpectrumLayout />;
}
