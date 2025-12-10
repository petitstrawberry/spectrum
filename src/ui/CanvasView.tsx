// @ts-nocheck
import React, { useRef } from 'react';
import { Trash2, Link as LinkIcon } from 'lucide-react';

interface Props {
  canvasRef: React.RefObject<HTMLDivElement>;
  isPanning: boolean;
  canvasTransform: { x: number; y: number; scale: number };
  nodes?: any[];
  onMoveNode?: (id: string, x: number, y: number) => void;
  onDeleteNode?: (id: string) => void;
}

export default function CanvasView({ canvasRef, isPanning, canvasTransform, nodes = [], onMoveNode, onDeleteNode }: Props) {
  const nodeLineMeterRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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
  const endWire = (_e: any, _nodeId: string, _portIdx: number) => {};
  const startWire = (_e: any, _nodeId: string, _portIdx: number) => {};

  // Port helpers (mirrors v1)
  const getPortCount = (n: any) => {
    return n.channelCount || 2;
  };
  const getPortLabel = (n: any, portIndex: number) => {
    // Prism source nodes with channelOffset show absolute channel numbers
    if (n.type === 'source' && n.sourceType !== 'device' && typeof n.channelOffset === 'number') {
      return `${n.channelOffset + portIndex + 1}`;
    }
    return `${portIndex + 1}`;
  };
  const isPortMono = (_n: any, _portIndex: number) => true; // UI treats ports as mono for now
  return (
    <div ref={canvasRef} className={`flex-1 bg-[#0b1120] relative overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}>
      <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})` }}>
        <div className="absolute pointer-events-none opacity-20" style={{ backgroundImage: 'radial-gradient(#475569 1px, transparent 1px)', backgroundSize: '24px 24px', width: '4000px', height: '4000px', left: '-2000px', top: '-2000px' }}></div>
        <svg className="absolute pointer-events-none z-0" style={{ width: '4000px', height: '4000px', left: '-2000px', top: '-2000px', overflow: 'visible' }}>
          <g transform="translate(2000, 2000)"></g>
        </svg>
        <div className="p-4 text-slate-500">Canvas area (v1 layout)</div>

        {nodes.map((node: any) => {
          const NodeIcon = node.icon || (() => null);
          const isDeviceNode = node.sourceType === 'device' || (node.libraryId && node.libraryId.startsWith('dev_'));
          const isUnavailable = node.available === false;
          const portCount = node.channelCount || 2;
          const nodeHeight = 36 + 16 + (portCount * 24);
          const dynamicColor = node.color || 'text-cyan-400';
          const dynamicLabel = node.label;
          const dynamicSubLabel = node.subLabel;

          let borderClass = 'border-slate-700';
          if (isUnavailable) borderClass = 'border-slate-600/50';
          else if (node.type === 'source') borderClass = isDeviceNode ? 'border-amber-500/30 hover:border-amber-500' : 'border-cyan-500/30 hover:border-cyan-500';

          const style: React.CSSProperties = { left: node.x, top: node.y, height: nodeHeight };

          return (
            <div
              key={node.id}
              ref={el => { if (el) nodeRefs.current.set(node.id, el); }}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              className={`canvas-node absolute w-[180px] ${isUnavailable ? 'bg-slate-900/50' : 'bg-slate-800'} rounded-lg shadow-xl border-2 group z-10 will-change-transform ${borderClass} ${isUnavailable ? 'opacity-50' : ''}`}
              style={style}
            >
              <div className="h-9 bg-slate-900/50 rounded-t-lg border-b border-slate-700/50 flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing">
                <div className="w-3 h-3 flex items-center justify-center shrink-0">
                  {node.type === 'target' && node.channelMode === 'stereo' ? (
                    <LinkIcon className="w-3 h-3 text-cyan-400" />
                  ) : (
                    <div className={`w-2 h-2 rounded-full ${dynamicColor} shadow-[0_0_8px_currentColor]`}></div>
                  )}
                </div>
                {/* Icon: use inline style if node.color is rgb(...), otherwise use className */}
                {(() => {
                  if (!isUnavailable && typeof node.color === 'string' && node.color.startsWith('rgb')) {
                    return <NodeIcon className="w-4 h-4" style={{ color: node.color, filter: `drop-shadow(0 0 8px ${node.color})` }} />;
                  }
                  return <NodeIcon className={`w-4 h-4 ${isUnavailable ? 'text-slate-500' : dynamicColor}`} />;
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
                      <button onClick={(e) => {e.stopPropagation(); deleteNode(node.id)}} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-3 h-3"/></button>
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
                {Array.from({length: portCount}).map((_, portIdx) => {
                  const label = `CH ${getPortLabel(node, portIdx)}`;
                  return (
                    <div key={portIdx} className="flex items-center justify-between h-5 relative">
                      <div className="w-3 relative h-full flex items-center">
                        {(node.type === 'target' || node.type === 'bus') && (() => {
                          const mono = isPortMono(node, portIdx);
                          const bgClass = mono ? 'bg-slate-500' : 'bg-slate-600';
                          const busBorder = node.type === 'bus' ? 'border-purple-400' : '';
                          return (
                            <div
                              className={`absolute -left-[15px] w-3 h-3 rounded-full border border-slate-400 hover:scale-125 cursor-crosshair z-20 top-[4px] ${bgClass} ${busBorder}`}
                              onMouseUp={(e) => endWire(e, node.id, portIdx)}
                            ></div>
                          );
                        })()}
                      </div>
                      <div className={`text-[9px] font-mono flex-1 text-center ${isPortMono(node, portIdx) ? 'text-slate-400' : 'text-slate-500'}`}>{label}</div>
                      <div className="w-3 relative h-full flex items-center">
                        {(node.type === 'source' || node.type === 'bus') && (
                          (() => {
                            const mono = isPortMono(node, portIdx);
                            const bgClass = mono ? 'bg-slate-500' : 'bg-slate-600';
                            const busBorder = node.type === 'bus' ? 'border-purple-400' : '';
                            return (
                              <div
                                className={`absolute -right-[15px] w-3 h-3 rounded-full border border-slate-400 hover:scale-125 hover:bg-white cursor-crosshair z-20 top-[4px] ${bgClass} ${busBorder}`}
                                onMouseDown={(e) => startWire(e, node.id, portIdx)}
                              ></div>
                            );
                          })()
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
  );
}
