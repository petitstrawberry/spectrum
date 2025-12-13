// @ts-nocheck
import React from 'react';
import { Maximize2, Volume2, Monitor } from 'lucide-react';
import DetailView from './detail/DetailView';
import type { BusInfo } from './detail/types';
import type { UINode } from '../types/graph';

// =============================================================================
// v1-inspired fader/meter scale helpers (UI-only)
// =============================================================================

// Logic Pro X fader scale (normalized: +6=100%, -∞=0%)
function dbToFader(db: number): number {
  if (!isFinite(db) || db <= -100) return 0;
  if (db >= 6) return 100;

  if (db >= 3) return 86.9 + ((db - 3) / 3) * 13.1; // +3 to +6: 86.9-100
  if (db >= 0) return 74.3 + (db / 3) * 12.6; // 0 to +3: 74.3-86.9
  if (db >= -3) return 61.2 + ((db + 3) / 3) * 13.1; // -3 to 0: 61.2-74.3
  if (db >= -6) return 48.5 + ((db + 6) / 3) * 12.7; // -6 to -3: 48.5-61.2
  if (db >= -10) return 39.9 + ((db + 10) / 4) * 8.6; // -10 to -6: 39.9-48.5
  if (db >= -15) return 29.1 + ((db + 15) / 5) * 10.8; // -15 to -10: 29.1-39.9
  if (db >= -20) return 20.9 + ((db + 20) / 5) * 8.2; // -20 to -15: 20.9-29.1
  if (db >= -30) return 12.3 + ((db + 30) / 10) * 8.6; // -30 to -20: 12.3-20.9
  if (db >= -40) return 8.2 + ((db + 40) / 10) * 4.1; // -40 to -30: 8.2-12.3
  // Below -40: 0-8.2
  return Math.max(0, 8.2 * (1 + (db + 40) / 60));
}

// Logic Pro X meter scale (normalized: 0dB=100%, -60dB=0%)
function dbToMeterPercent(db: number): number {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;

  const m = -db; // positive 0..60
  if (m <= 3) return 93.3 + ((3 - m) / 3) * 6.7;
  if (m <= 6) return 86.6 + ((6 - m) / 3) * 6.7;
  if (m <= 9) return 79.9 + ((9 - m) / 3) * 6.7;
  if (m <= 12) return 73.5 + ((12 - m) / 3) * 6.4;
  if (m <= 15) return 66.8 + ((15 - m) / 3) * 6.7;
  if (m <= 18) return 60.1 + ((18 - m) / 3) * 6.7;
  if (m <= 21) return 53.4 + ((21 - m) / 3) * 6.7;
  if (m <= 24) return 46.6 + ((24 - m) / 3) * 6.8;
  if (m <= 30) return 37.7 + ((30 - m) / 6) * 8.9;
  if (m <= 35) return 30.2 + ((35 - m) / 5) * 7.5;
  if (m <= 40) return 23.1 + ((40 - m) / 5) * 7.1;
  if (m <= 45) return 15.7 + ((45 - m) / 5) * 7.4;
  if (m <= 50) return 8.2 + ((50 - m) / 5) * 7.5;
  return ((60 - m) / 10) * 8.2;
}

// Convert meter label (0, 6, 12, ... 60) to % from bottom
function dbToMeterPosition(meterValue: number): number {
  return dbToMeterPercent(-meterValue);
}

function FaderScale() {
  return (
    <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none pointer-events-none">
      <div className="absolute right-0 flex items-center" style={{ top: '0', transform: 'translateY(-50%)' }}>
        <span className="mr-0.5">+6</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(3)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5">+3</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(0)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-white font-bold">0</span>
        <div className="w-2.5 h-px bg-white" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-3)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5">-3</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-6)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5">-6</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-10)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-[6px]">-10</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-15)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-[6px]">-15</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-20)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-[6px]">-20</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-30)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-[6px]">-30</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: `${dbToFader(-40)}%`, transform: 'translateY(50%)' }}>
        <span className="mr-0.5 text-[6px]">-40</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
      <div className="absolute right-0 flex items-center" style={{ bottom: '0', transform: 'translateY(50%)' }}>
        <span className="mr-0.5">-∞</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </div>
    </div>
  );
}

function MeterScale() {
  return (
    <div className="absolute -right-6 top-0 bottom-0 w-6 flex flex-col text-[7px] text-slate-400 font-mono pointer-events-none select-none">
      <div className="absolute left-0 flex items-center" style={{ top: '0', transform: 'translateY(-50%)' }}>
        <div className="w-2 h-px bg-red-400" />
        <span className="ml-0.5 text-red-400 font-bold">0</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(6)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5">6</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(12)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">12</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(18)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">18</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(24)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">24</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(30)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">30</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(40)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">40</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(50)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">50</span>
      </div>
      <div className="absolute left-0 flex items-center" style={{ bottom: `${dbToMeterPosition(60)}%`, transform: 'translateY(50%)' }}>
        <div className="w-1.5 h-px bg-slate-500" />
        <span className="ml-0.5 text-[6px]">60</span>
      </div>
    </div>
  );
}

// =============================================================================
// Types
// =============================================================================

interface Props {
  mixerHeight: number;
  masterWidth: number;
  channelSources?: any[];
  selectedBus?: BusInfo | null;
  selectedNode?: UINode | null;
  onPluginsChange?: () => void;
}

export default function MixerPanel({ mixerHeight, masterWidth, channelSources = [], selectedBus, selectedNode, onPluginsChange }: Props) {
  return (
    <div className="bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30" style={{ height: mixerHeight }}>
      {/* Bus Detail Section */}
      <div className="w-64 bg-[#1a1f2e] border-r border-slate-700 flex flex-col shrink-0">
        <DetailView selectedNode={selectedNode} selectedBus={selectedBus} onPluginsChange={onPluginsChange} />
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
                <FaderScale />
                <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                  <div className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10" style={{ bottom: `calc(${50}% - 5px)` }}></div>
                </div>
              </div>
              <div className="flex gap-0.5 relative">
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950" />
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5" />
                <MeterScale />
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
                <FaderScale />
                <div className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700">
                  <div className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10" style={{ bottom: `calc(${40}% - 5px)` }}></div>
                </div>
              </div>
              <div className="flex gap-0.5 relative">
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950" />
                <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5" />
                <MeterScale />
              </div>
            </div>
            <div className="text-[8px] font-mono text-slate-500 mt-1">-∞</div>
          </div>
        </div>
      </div>
    </div>
  );
}
