// @ts-nocheck
import React from 'react';
import { Maximize2, Volume2, Monitor } from 'lucide-react';
import BusPanel, { BusInfo } from './BusPanel';

// =============================================================================
// Types
// =============================================================================

interface Props {
  mixerHeight: number;
  masterWidth: number;
  channelSources?: any[];
  selectedBus?: BusInfo | null;
  onPluginsChange?: () => void;
}

export default function MixerPanel({ mixerHeight, masterWidth, channelSources = [], selectedBus, onPluginsChange }: Props) {
  return (
    <div className="bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30" style={{ height: mixerHeight }}>
      {/* Bus Detail Section */}
      <div className="w-64 bg-[#1a1f2e] border-r border-slate-700 flex flex-col shrink-0">
        <BusPanel bus={selectedBus} onPluginsChange={onPluginsChange} />
      </div>

      {/* Mixer Channels */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#162032]">
        <div className="h-8 bg-slate-900/50 border-b border-slate-800 flex items-center px-4 justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Maximize2 className="w-3 h-3 text-slate-500" />
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Select Output or Bus on Canvas to Mix</span>
          </div>
        </div>
        <div className="flex-1 flex overflow-x-auto p-4 gap-2 items-stretch">
          <div className="w-32 bg-slate-900 border rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none">
            <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
              <div className="w-6 h-6 rounded-lg bg-slate-950 border border-slate-600 flex items-center justify-center shadow-lg text-cyan-400">
                <Volume2 className="w-3 h-3" />
              </div>
            </div>
            <div className="w-full px-1 text-center mb-2">
              <div className="text-[7px] font-mono text-slate-500">1-2</div>
              <div className="text-[9px] font-bold truncate text-slate-300">MAIN</div>
            </div>
            <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
              <div className="relative mr-2">
                <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none"></div>
                <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                  <div className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10" style={{ bottom: `calc(${50}% - 5px)` }}></div>
                </div>
              </div>
              <div className="flex gap-0.5 relative">
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950" />
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5" />
              </div>
            </div>
            <div className="text-[8px] font-mono text-slate-500 mt-1">0.0dB</div>
            <div className="flex gap-1 mt-1 w-full px-1">
              <button className="flex-1 h-4 rounded text-[8px] font-bold border bg-slate-800 border-slate-700 text-slate-500">M</button>
            </div>
          </div>
        </div>
      </div>

      <div className="w-1 bg-transparent hover:bg-amber-500/50 cursor-ew-resize z-40 shrink-0 transition-colors" />

      {/* Master Section */}
      <div className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 relative shadow-2xl min-h-0" style={{ width: masterWidth }}>
        <div className="p-2 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between shrink-0">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
            <Monitor className="w-3 h-3" /> Master & Monitor
          </div>
        </div>
        <div className="flex-1 flex gap-2 p-3 min-h-0">
          <div className="flex-1 flex flex-col gap-1 overflow-y-auto min-h-0">
            <div className="flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all shrink-0 bg-slate-800">
              <div className="w-5 h-5 rounded flex items-center justify-center bg-slate-950 text-slate-500">
                <Monitor className="w-3 h-3" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold truncate text-white">Output</div>
              </div>
            </div>
          </div>
          <div className="w-28 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none shadow-xl">
            <div className="text-[8px] font-bold text-slate-500 mb-2">MASTER</div>
            <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
              <div className="relative mr-2">
                <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none"></div>
                <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                  <div className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10" style={{ bottom: `calc(${40}% - 5px)` }}></div>
                </div>
              </div>
              <div className="flex gap-0.5 relative">
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950" />
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5" />
              </div>
            </div>
            <div className="text-[8px] font-mono text-slate-500 mt-1">-∞</div>
          </div>
        </div>
      </div>
    </div>
  );
}
