import { LogOut, RefreshCw, ExternalLink, Music, Volume2 } from 'lucide-react';

interface Props {
  width: number;
  isRefreshing: boolean;
  inputSourceMode: string;
  handleRefresh: () => void | Promise<void>;
  driverStatus?: { connected: boolean; sample_rate?: number; buffer_size?: number } | null;
  onChangeInputSourceMode?: (mode: 'prism' | 'devices') => void;
  channelSources?: Array<{
    id: string;
    channelOffset: number;
    channelLabel: string;
    apps: Array<{ name: string; icon?: any; color?: string; pid?: number; clientCount?: number }>;
    hasApps: boolean;
    isMain: boolean;
  }>;
  prismDevice?: { id?: string; name?: string } | null;
  isLibraryItemUsed?: (id: string) => boolean;
  handleLibraryMouseDown?: (e: React.MouseEvent, type: string, id: string) => void;
  onOpenPrismApp?: () => void;
}

export default function LeftSidebar({ width, isRefreshing, inputSourceMode, handleRefresh, driverStatus, onChangeInputSourceMode, channelSources = [], prismDevice = null, isLibraryItemUsed = () => false, handleLibraryMouseDown, onOpenPrismApp }: Props) {
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
          <button
            onClick={() => onChangeInputSourceMode?.('prism')}
            className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${inputSourceMode === 'prism' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
          >Prism</button>
          <button
            onClick={() => onChangeInputSourceMode?.('devices')}
            className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors ${inputSourceMode === 'devices' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
          >Devices</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {/* Prism mode: Show channel list */}
        {inputSourceMode === 'prism' && prismDevice ? (
          <>
            <button
              onClick={() => onOpenPrismApp?.()}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mb-2 rounded-md bg-slate-800/50 border border-slate-700/50 hover:border-slate-600 hover:bg-slate-800 text-slate-400 hover:text-slate-300 text-[10px] transition-all"
            >
              <ExternalLink className="w-3 h-3" />
              <span>Configure routing in Prism</span>
            </button>

            {channelSources.map(channel => {
              const isUsed = isLibraryItemUsed(channel.id);
              const hasApps = channel.hasApps;
              const FirstIcon = (channel.apps && channel.apps[0] && channel.apps[0].icon) || Music;

              return (
                <div
                  key={channel.id}
                  onMouseDown={!isUsed && handleLibraryMouseDown ? (e) => handleLibraryMouseDown(e, 'lib_source', channel.id) : undefined}
                  className={
                    `group flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-all relative overflow-hidden ` +
                    (isUsed
                      ? 'border-transparent bg-slate-900/30 opacity-40 cursor-default'
                      : hasApps
                        ? 'border-slate-700/50 bg-slate-800/60 hover:border-cyan-500/50 hover:bg-slate-800 cursor-grab active:cursor-grabbing'
                        : 'border-transparent bg-slate-900/20 hover:border-slate-700/50 hover:bg-slate-900/40 cursor-grab active:cursor-grabbing')
                  }
                >
                  <div className={`w-10 text-[10px] font-mono font-bold ${hasApps ? 'text-cyan-400' : 'text-slate-600'}`}>
                    {channel.channelLabel}
                  </div>

                  {channel.isMain ? (
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
                      <div className={`w-5 h-5 rounded flex items-center justify-center bg-slate-950 ${channel.apps[0]?.color || ''}`}>
                        <FirstIcon className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-slate-300 truncate">{channel.apps.map((a: any) => a.name).join(', ')}</div>
                        {channel.apps.length > 1 && (<div className="text-[8px] text-slate-500">{channel.apps.length} apps</div>)}
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center gap-2 min-w-0">
                      <div className="w-5 h-5 rounded flex items-center justify-center bg-slate-950 text-slate-500">
                        <Music className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-slate-400 truncate">Empty</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <div className="text-center py-8 text-slate-600 text-xs">Library preview</div>
        )}
      </div>
    </div>
  );
}
