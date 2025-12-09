import { LogOut, RefreshCw } from 'lucide-react';

interface Props {
  width: number;
  isRefreshing: boolean;
  inputSourceMode: string;
  handleRefresh: () => void | Promise<void>;
  driverStatus?: { connected: boolean; sample_rate?: number; buffer_size?: number } | null;
}

export default function LeftSidebar({ width, isRefreshing, inputSourceMode, handleRefresh, driverStatus }: Props) {
  return (
    <div className="bg-[#111827] border-r border-slate-800 flex flex-col shrink-0 z-10 shadow-xl relative" style={{ width }} onClick={e => e.stopPropagation()}>
      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2">
          <LogOut className="w-3 h-3" /> Input Sources
          {/* Connection status indicator - placed above the tabs (v1 parity) */}
          {driverStatus && (
            <span className={`ml-auto flex items-center gap-1 ${driverStatus.connected ? 'text-green-400' : 'text-red-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${driverStatus.connected ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-[9px]">{driverStatus.connected ? 'Connected' : 'Disconnected'}</span>
            </span>
          )}
          <button onClick={handleRefresh} className="ml-1 p-1 hover:bg-slate-700 rounded transition-colors" title="Refresh">
            <RefreshCw className={`w-3 h-3 text-slate-400 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="flex gap-1 mb-2">
          <button className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${inputSourceMode === 'prism' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>Prism</button>
          <button className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${inputSourceMode === 'devices' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>Devices</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <div className="text-center py-8 text-slate-600 text-xs">Library preview</div>
      </div>
    </div>
  );
}
