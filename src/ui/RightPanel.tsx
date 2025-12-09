// @ts-nocheck
import React from 'react';
import { Workflow, Plus, Speaker } from 'lucide-react';

interface Props {
  width: number;
}

export default function RightPanel({ width }: Props) {
  return (
    <div className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 z-10 shadow-xl relative" style={{ width }} onClick={e => e.stopPropagation()}>
      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-3">
          <Workflow className="w-3 h-3" /> Buses / Aux
        </div>
        <button className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-dashed border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/20 hover:border-purple-400 text-purple-400 hover:text-purple-300 transition-all text-xs font-medium">
          <Plus className="w-3.5 h-3.5" /> Add Bus
        </button>
      </div>
      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-3">
          <Speaker className="w-3 h-3" /> Output Device
        </div>
        <select className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none cursor-pointer">
          <option value="">Select output device...</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <div className="text-center py-8 text-slate-600 text-xs">Outputs preview</div>
      </div>
    </div>
  );
}
