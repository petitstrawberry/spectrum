// @ts-nocheck
import React from 'react';

interface Props {
  canvasRef: React.RefObject<HTMLDivElement>;
  isPanning: boolean;
  canvasTransform: { x: number; y: number; scale: number };
  nodes?: any[];
}

export default function CanvasView({ canvasRef, isPanning, canvasTransform, nodes = [] }: Props) {
  return (
    <div ref={canvasRef} className={`flex-1 bg-[#0b1120] relative overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}>
      <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})` }}>
        <div className="absolute pointer-events-none opacity-20" style={{ backgroundImage: 'radial-gradient(#475569 1px, transparent 1px)', backgroundSize: '24px 24px', width: '4000px', height: '4000px', left: '-2000px', top: '-2000px' }}></div>
        <svg className="absolute pointer-events-none z-0" style={{ width: '4000px', height: '4000px', left: '-2000px', top: '-2000px', overflow: 'visible' }}>
          <g transform="translate(2000, 2000)"></g>
        </svg>
        <div className="p-4 text-slate-500">Canvas area (v1 layout)</div>

        {nodes.map((n: any) => {
          const Icon = n.icon || (() => null);
          return (
            <div key={n.id} className="absolute w-36 p-2 bg-slate-800/70 backdrop-blur rounded border border-slate-700 text-sm text-slate-100 shadow" style={{ left: n.x, top: n.y }}>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 text-cyan-400">
                  <Icon />
                </div>
                <div className="truncate">{n.label}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
