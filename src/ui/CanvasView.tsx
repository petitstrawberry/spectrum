// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, Link as LinkIcon } from 'lucide-react';
import { getNodePorts } from '../hooks/useNodeDisplay';

type PatchConnection = {
  id: string;
  fromNodeId: string;
  fromChannel: number;
  toNodeId: string;
  toChannel: number;
  sendLevel?: number;
  muted?: boolean;
};

interface Props {
  canvasRef: React.RefObject<HTMLDivElement>;
  isPanning: boolean;
  canvasTransform: { x: number; y: number; scale: number };
  nodes?: any[];
  connections?: PatchConnection[];
  onConnect?: (fromNodeId: string, fromPortIdx: number, toNodeId: string, toPortIdx: number) => void | Promise<void>;
  onDisconnect?: (connectionId: string) => void | Promise<void>;
  selectedNodeId?: string | null;
  selectedBusId?: string | null;
  focusedOutputId?: string | null;
  onSelectNodeId?: (nodeId: string | null) => void;
  onSelectBusId?: (busNodeId: string | null) => void;
  onFocusOutputId?: (outputNodeId: string | null) => void;
  onMoveNode?: (id: string, x: number, y: number) => void;
  onDeleteNode?: (id: string) => void;
  systemActiveOutputs?: number[];
}

export default function CanvasView({
  canvasRef,
  isPanning,
  canvasTransform,
  nodes = [],
  connections = [],
  onConnect,
  onDisconnect,
  selectedNodeId = null,
  selectedBusId = null,
  focusedOutputId = null,
  onSelectNodeId,
  onSelectBusId,
  onFocusOutputId,
  onMoveNode,
  onDeleteNode,
  systemActiveOutputs = [],
}: Props) {
  const nodeLineMeterRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const [wireStart, setWireStart] = useState<null | { nodeId: string; portIdx: number }>(null);
  const [wirePos, setWirePos] = useState<null | { x: number; y: number }>(null);

  const getCanvasPointFromEvent = (ev: MouseEvent | React.MouseEvent) => {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = (canvasTransform && canvasTransform.scale) ? canvasTransform.scale : 1;
    const tx = (canvasTransform && canvasTransform.x) ? canvasTransform.x : 0;
    const ty = (canvasTransform && canvasTransform.y) ? canvasTransform.y : 0;
    const x = ((ev.clientX as number) - rect.left - tx) / scale;
    const y = ((ev.clientY as number) - rect.top - ty) / scale;
    return { x, y };
  };

  useEffect(() => {
    if (!wireStart) return;

    const onMove = (ev: MouseEvent) => {
      const p = getCanvasPointFromEvent(ev);
      if (p) setWirePos(p);
    };

    const onUp = () => {
      setWireStart(null);
      setWirePos(null);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wireStart]);

  const handleNodeMouseDown = (e: any, id: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const el = nodeRefs.current.get(id);
    if (!el || !canvasRef.current) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = (canvasTransform && canvasTransform.scale) ? canvasTransform.scale : 1;
    const tx = (canvasTransform && canvasTransform.x) ? canvasTransform.x : 0;
    const ty = (canvasTransform && canvasTransform.y) ? canvasTransform.y : 0;
    const startCanvasX = (e.clientX - rect.left - tx) / scale;
    const startCanvasY = (e.clientY - rect.top - ty) / scale;
    // find node's current position from DOM or nodes prop
    const node = nodes.find((n: any) => n.id === id);
    if (!node) return;

    // v1 parity: node selection drives cable highlighting
    try {
      if (typeof onSelectNodeId === 'function') onSelectNodeId(id);
      if (node?.type === 'target') {
        if (typeof onFocusOutputId === 'function') onFocusOutputId(id);
        if (typeof onSelectBusId === 'function') onSelectBusId(null);
      }
      if (node?.type === 'bus') {
        if (typeof onSelectBusId === 'function') onSelectBusId(id);
        // do not clear focusedOutputId (v1 keeps it)
      }
      if (node?.type !== 'bus') {
        if (typeof onSelectBusId === 'function') onSelectBusId(null);
      }
    } catch {
      // ignore
    }

    const offsetX = startCanvasX - node.x;
    const offsetY = startCanvasY - node.y;

    const onMove = (ev: MouseEvent) => {
      const curCanvasX = (ev.clientX - rect.left - tx) / scale;
      const curCanvasY = (ev.clientY - rect.top - ty) / scale;
      const newX = curCanvasX - offsetX;
      const newY = curCanvasY - offsetY;
      if (typeof onMoveNode === 'function') onMoveNode(id, newX, newY);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const deleteNode = (id: string) => {
    if (typeof onDeleteNode === 'function') onDeleteNode(id);
  };

  const startWire = (e: any, nodeId: string, portIdx: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    try {
      console.log('[CanvasView] startWire', { nodeId, portIdx });
    } catch {
      // ignore
    }
    setWireStart({ nodeId, portIdx });
    const p = getCanvasPointFromEvent(e);
    if (p) setWirePos(p);
  };

  const endWire = async (e: any, nodeId: string, portIdx: number) => {
    e.stopPropagation();
    if (!wireStart) return;
    if (typeof onConnect !== 'function') {
      setWireStart(null);
      setWirePos(null);
      return;
    }

    const from = wireStart;
    setWireStart(null);
    setWirePos(null);

    if (!from?.nodeId || !nodeId) return;
    if (from.nodeId === nodeId) return;

    const fromNode = findNode(from.nodeId);
    const toNode = findNode(nodeId);
    if (!fromNode || !toNode) return;

    const srcPortCount = Math.max(1, Number(fromNode.channelCount || 2));
    const tgtPortCount = Math.max(1, Number(toNode.channelCount || 2));

    const channelsToConnect: Array<{ srcPort: number; tgtPort: number }> = [];
    const isStereoPair = !!e?.shiftKey;
    try {
      console.log('[CanvasView] endWire', { from: from, to: { nodeId, portIdx }, isStereoPair });
    } catch {
      // ignore
    }
    if (isStereoPair) {
      const srcBase = Math.floor(from.portIdx / 2) * 2;
      const tgtBase = Math.floor(portIdx / 2) * 2;
      if (srcBase < srcPortCount && tgtBase < tgtPortCount) {
        channelsToConnect.push({ srcPort: srcBase, tgtPort: tgtBase });
      }
      if (srcBase + 1 < srcPortCount && tgtBase + 1 < tgtPortCount) {
        channelsToConnect.push({ srcPort: srcBase + 1, tgtPort: tgtBase + 1 });
      }
    } else {
      channelsToConnect.push({ srcPort: from.portIdx, tgtPort: portIdx });
    }


    try {
      for (const c of channelsToConnect) {
        const exists = connections.some((x) =>
          x.fromNodeId === from.nodeId &&
          x.fromChannel === c.srcPort &&
          x.toNodeId === nodeId &&
          x.toChannel === c.tgtPort
        );
        if (exists) continue;
        await onConnect(from.nodeId, c.srcPort, nodeId, c.tgtPort);
      }
    } catch (err) {
      console.error('connect failed', err);
    }
  };

  const findNode = (id: string) => nodes.find((n: any) => n.id === id);

  const getPortCenter = (node: any, portIdx: number, dir: 'in' | 'out') => {
    // v1 parity: match getPortPosition() geometry exactly
    // x is anchored on the node edge (not the center of the dot)
    const x = dir === 'in' ? node.x : (node.x + 180);
    const y = node.y + 36 + 8 + (portIdx * 24) + 4 + 6 + 2;
    return { x, y };
  };

  const bezierPath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    // v1 parity: fixed control points
    return `M ${a.x} ${a.y} C ${a.x + 50} ${a.y}, ${b.x - 50} ${b.y}, ${b.x} ${b.y}`;
  };

  const renderedConnections = useMemo(() => {
    const out: Array<{ id: string; d: string; isDisconnected: boolean; isActive: boolean; strokeColor: string; strokeWidth: number; dash: string | undefined; opacity: number }>= [];
    for (const c of connections) {
      const fromNode = findNode(c.fromNodeId);
      const toNode = findNode(c.toNodeId);
      if (!fromNode || !toNode) continue;
      const a = getPortCenter(fromNode, c.fromChannel, 'out');
      const b = getPortCenter(toNode, c.toChannel, 'in');

      const isDisconnected = fromNode.available === false || toNode.available === false;
      const isBusConnection = fromNode.type === 'bus' || toNode.type === 'bus';
      const isActive = !isDisconnected && (
        (toNode.id === focusedOutputId) ||
        (isBusConnection && selectedBusId && (fromNode.id === selectedBusId || toNode.id === selectedBusId))
      );

      // v1 parity colors
      let strokeColor = '#475569';
      if (isDisconnected) {
        strokeColor = '#64748b';
      } else if (isActive) {
        if (isBusConnection) {
          strokeColor = '#a855f7';
        } else if (String(toNode.color || '').includes('cyan')) {
          strokeColor = '#22d3ee';
        } else {
          strokeColor = '#f472b6';
        }
      }

      out.push({
        id: c.id,
        d: bezierPath(a, b),
        isDisconnected,
        isActive,
        strokeColor,
        strokeWidth: isActive ? 2 : 1,
        dash: isDisconnected ? '4,4' : undefined,
        opacity: isDisconnected ? 0.5 : 1,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, nodes, focusedOutputId, selectedBusId]);
  return (
    <div
      ref={canvasRef}
      className={`flex-1 bg-[#0b1120] relative overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}
      onMouseDown={(e) => {
        // v1 parity: click background clears selection
        if (e.button !== 0) return;
        try {
          if (typeof onSelectNodeId === 'function') onSelectNodeId(null);
          if (typeof onSelectBusId === 'function') onSelectBusId(null);
        } catch {
          // ignore
        }
      }}
    >
      <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})` }}>
        <div className="absolute pointer-events-none opacity-20" style={{ backgroundImage: 'radial-gradient(#475569 1px, transparent 1px)', backgroundSize: '24px 24px', width: '4000px', height: '4000px', left: '-2000px', top: '-2000px' }}></div>
        <svg className="absolute pointer-events-none z-0" style={{ width: '4000px', height: '4000px', left: '-2000px', top: '-2000px', overflow: 'visible' }}>
          <g transform="translate(2000, 2000)">
            {renderedConnections.map((c) => (
              <g
                key={c.id}
                className="pointer-events-auto group cursor-pointer"
                onMouseDown={(e) => {
                  // Keep current selection/focus when clicking a cable.
                  e.stopPropagation();
                }}
                onPointerDown={(e) => {
                  // Same for pointer events (trackpads/stylus).
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (typeof onDisconnect !== 'function') return;
                  try {
                    console.log('[CanvasView] disconnect click', { connectionId: c.id });
                  } catch {
                    // ignore
                  }
                  try {
                    const r = onDisconnect(c.id);
                    if (r && typeof (r as any).catch === 'function') (r as any).catch((err: any) => console.error('disconnect failed', err));
                  } catch (err) {
                    console.error('disconnect failed', err);
                  }
                }}
              >
                <path d={c.d} fill="none" stroke="transparent" strokeWidth={10} />
                <path
                  d={c.d}
                  fill="none"
                  stroke={c.strokeColor}
                  strokeWidth={c.strokeWidth}
                  strokeDasharray={c.dash || 'none'}
                  opacity={c.opacity}
                  className="group-hover:stroke-red-400"
                />
                {c.isActive && !c.isDisconnected && (
                  <circle r="3" fill="#fff" opacity="0.8">
                    <animateMotion dur="2s" repeatCount="indefinite" path={c.d} />
                  </circle>
                )}
              </g>
            ))}

            {wireStart && wirePos && (() => {
              const fromNode = findNode(wireStart.nodeId);
              if (!fromNode) return null;
              const a = getPortCenter(fromNode, wireStart.portIdx, 'out');
              const b = wirePos;
              return (
                <>
                  <path
                    d={`M ${a.x} ${a.y} C ${a.x + 50} ${a.y}, ${b.x - 50} ${b.y}, ${b.x} ${b.y}`}
                    fill="none"
                    stroke="#fff"
                    strokeWidth={2}
                    strokeDasharray="4,4"
                  />
                  {/* Stereo hint tooltip near cursor (v1 parity) */}
                  <g transform={`translate(${b.x - 50}, ${b.y - 18})`}>
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
        <div className="p-4 text-slate-500">Canvas area (v1 layout)</div>

        {nodes.map((node: any) => {
          const NodeIcon = node.icon || (() => null);
          const isDeviceNode = node.sourceType === 'device' || (node.libraryId && node.libraryId.startsWith('dev_'));
          const isUnavailable = node.available === false;
          // If this node corresponds to a virtual output (libraryId like 'vout_<device>_<offset>'),
          // and the system has an active output that doesn't match the parent device, mark disabled.
          let isSystemDisabled = false;
          if (node.libraryId && typeof node.libraryId === 'string' && node.libraryId.startsWith('vout_')) {
            const m = node.libraryId.match(/^vout_(\d+)_(\d+)$/);
            if (m) {
              const parentId = Number(m[1]);
              // systemActiveOutputs may be numbers or strings; normalize to numbers
              const activeNums = Array.isArray(systemActiveOutputs) ? systemActiveOutputs.map((v: any) => Number(v)).filter((n: any) => !Number.isNaN(n)) : [];
              if (activeNums.length > 0 && !activeNums.includes(parentId)) {
                isSystemDisabled = true;
              }
            }
          }
          const portCount = node.channelCount || 2;
          const nodeHeight = 36 + 16 + (portCount * 24);
          // アイコンの色はnode.iconColorを優先、なければcolorにフォールバック
          const iconColor = node.iconColor || node.color || 'text-cyan-400';
          const dynamicLabel = node.label;
          const dynamicSubLabel = node.subLabel;

          const isSelected = selectedNodeId === node.id;
          const isFocused = focusedOutputId === node.id;
          const isBusSelected = selectedBusId === node.id;

          const disabled = isUnavailable || isSystemDisabled;

          let borderClass = 'border-slate-700';
          if (disabled) {
            borderClass = 'border-slate-600/50';
          } else if (node.type === 'source') {
            borderClass = isDeviceNode ? 'border-amber-500/30 hover:border-amber-500' : 'border-cyan-500/30 hover:border-cyan-500';
          } else if (node.type === 'bus') {
            borderClass = isBusSelected ? 'border-purple-500 ring-2 ring-purple-500/20' : 'border-purple-500/30 hover:border-purple-500';
          }
          if (node.type === 'target' && !disabled) {
            borderClass = isFocused ? 'border-pink-500 ring-2 ring-pink-500/20' : 'border-pink-500/30 hover:border-pink-500';
          }
          if (isSelected && !disabled) {
            if (node.type === 'bus') {
              borderClass = 'border-purple-500 ring-2 ring-purple-500/30';
            } else if (node.type === 'target') {
              borderClass = 'border-pink-500 ring-2 ring-pink-500/30';
            } else if (node.type === 'source') {
              borderClass = isDeviceNode ? 'border-amber-500 ring-2 ring-amber-500/25' : 'border-cyan-500 ring-2 ring-cyan-500/25';
            } else {
              borderClass = 'border-slate-200 ring-2 ring-slate-200/20';
            }
          }

          const style: React.CSSProperties = { left: node.x, top: node.y, height: nodeHeight };

          // Allow dragging of output nodes even when visually disabled (greyed out).
          const allowDragWhenDisabled = node.type === 'target';
          return (
            <div
              key={node.id}
              ref={el => { if (el) nodeRefs.current.set(node.id, el); }}
              onMouseDown={(e) => { if (!disabled || allowDragWhenDisabled) handleNodeMouseDown(e, node.id); }}
              onClick={(e) => { e.stopPropagation(); }}
              className={`canvas-node absolute w-[180px] ${disabled ? 'bg-slate-900/30' : (isUnavailable ? 'bg-slate-900/50' : 'bg-slate-800')} rounded-lg shadow-xl border-2 group z-10 will-change-transform ${borderClass} ${disabled ? (allowDragWhenDisabled ? 'opacity-40' : 'opacity-40 pointer-events-none') : ''}`}
              style={style}
            >
              <div className="h-9 bg-slate-900/50 rounded-t-lg border-b border-slate-700/50 flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing">
                <div className="w-3 h-3 flex items-center justify-center shrink-0">
                  {node.type === 'target' && node.channelMode === 'stereo' ? (
                    <LinkIcon className="w-3 h-3 text-cyan-400" />
                  ) : (
                    // Indicator stays neutral (no coloring)
                    <div className="w-2 h-2 rounded-full bg-slate-500" />
                  )}
                </div>
                {/* Icon: iconColorを使用、rgb(...)形式とCSSクラスの両方をサポート */}
                {(() => {
                  if (!isUnavailable && typeof iconColor === 'string' && iconColor.startsWith && iconColor.startsWith('rgb')) {
                    return <NodeIcon className="w-4 h-4" style={{ color: iconColor, filter: `drop-shadow(0 0 8px ${iconColor})` }} />;
                  }
                  return <NodeIcon className={`w-4 h-4 ${isUnavailable ? 'text-slate-500' : iconColor}`} />;
                })()}
                <div className="flex-1 min-w-0">
                  {isUnavailable ? (
                    <>
                      <span className="text-xs font-bold text-slate-500 truncate block">{node.label}</span>
                      <span className="text-[9px] text-red-400 truncate block">Disconnected</span>
                    </>
                  ) : isDeviceNode ? (
                    <>
                      <span className="text-xs font-bold text-amber-200 truncate block">{node.deviceName || node.label}</span>
                      <span className="text-[9px] text-slate-500 truncate block">{node.channelCount}ch Input</span>
                    </>
                  ) : node.type === 'source' ? (
                    <>
                      <span className="text-xs font-bold text-slate-200 truncate block">{dynamicSubLabel}</span>
                      <span className="text-[9px] text-slate-500 truncate block">{dynamicLabel}</span>
                    </>
                  ) : node.type === 'bus' ? (
                    <>
                      <span className="text-xs font-bold text-purple-200 truncate block">{node.label}</span>
                      <span className="text-[9px] text-slate-500 truncate block">{node.channelMode === 'stereo' ? 'Stereo' : 'Mono'} • {node.plugins?.length || 0} FX</span>
                    </>
                  ) : (
                    <span className="text-xs font-bold text-slate-200 truncate block">{node.label}</span>
                  )}
                </div>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    // Background clears selection on pointer/mouse down; prevent that when deleting.
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNode(node.id);
                  }}
                  className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Delete node ${node.label}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              <div className="h-[2px] bg-slate-800 relative overflow-hidden">
                <div
                  ref={(el) => {
                    if (el) nodeLineMeterRefs.current.set(node.id, el);
                    else nodeLineMeterRefs.current.delete(node.id);
                  }}
                  className="absolute left-0 top-0 h-full bg-gradient-to-r from-emerald-500 via-yellow-400 to-red-500"
                  style={{ width: '0%' }}
                />
              </div>

              <div className="p-2 space-y-1 relative">
                {(() => {
                  // 共通関数を使用してポート情報を取得
                  const nodeType = node.type === 'target' ? 'sink' : node.type;
                  const ports = getNodePorts({
                    type: nodeType,
                    portCount,
                    channelOffset: node.channelOffset,
                    sourceType: node.sourceType,
                  });
                  return ports.map((port) => {
                    const busBorder = node.type === 'bus' ? 'border-purple-400' : '';
                    return (
                      <div key={port.index} className="flex items-center justify-between h-5 relative">
                        <div className="w-3 relative h-full flex items-center">
                          {port.isInput && (
                            <div
                              className={`absolute -left-[15px] w-3 h-3 rounded-full border border-slate-400 bg-slate-500 hover:scale-125 cursor-crosshair z-20 top-[4px] ${busBorder}`}
                              onMouseUp={(e) => endWire(e, node.id, port.index)}
                            ></div>
                          )}
                        </div>
                        <div className="text-[9px] font-mono flex-1 text-center text-slate-400">{port.label}</div>
                        <div className="w-3 relative h-full flex items-center">
                          {port.isOutput && (
                            <div
                              className={`absolute -right-[15px] w-3 h-3 rounded-full border border-slate-400 bg-slate-500 hover:scale-125 hover:bg-white cursor-crosshair z-20 top-[4px] ${busBorder}`}
                              onMouseDown={(e) => startWire(e, node.id, port.index)}
                            ></div>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
