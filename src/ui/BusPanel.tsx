// @ts-nocheck
import React, { useState } from 'react';
import { Workflow, Plus, Trash2, GripVertical, X, Search, Music } from 'lucide-react';
import { getBusColor } from '../hooks/useNodeDisplay';
import {
  getAvailablePlugins,
  addPluginToBus,
  removePluginFromBus,
  reorderPlugins,
  openPluginUI,
} from '../lib/api';

// =============================================================================
// Types
// =============================================================================

export interface PluginInstance {
  id: string;
  pluginId: string;
  name: string;
  manufacturer: string;
  enabled: boolean;
}

export interface BusInfo {
  id: string;
  handle: number;
  label: string;
  busId?: string;
  channelCount: number;
  plugins?: PluginInstance[];
}

interface PluginInfoDto {
  plugin_id: string;
  name: string;
  manufacturer: string;
  category: string;
}

interface Props {
  bus: BusInfo | null;
  onPluginsChange?: () => void;
}

// =============================================================================
// Component
// =============================================================================

export default function BusPanel({ bus, onPluginsChange }: Props) {
  const [showPluginBrowser, setShowPluginBrowser] = useState(false);
  const [availablePlugins, setAvailablePlugins] = useState<PluginInfoDto[]>([]);
  const [pluginSearchQuery, setPluginSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const plugins = bus?.plugins || [];
  const busNum = bus?.busId ? parseInt(bus.busId.replace('bus_', ''), 10) || 1 : 1;
  const busColor = bus ? getBusColor(busNum) : 'text-purple-400';

  // Open plugin browser
  const handleOpenPluginBrowser = async () => {
    setLoading(true);
    try {
      const plugins = await getAvailablePlugins();
      setAvailablePlugins(plugins);
      setShowPluginBrowser(true);
    } catch (error) {
      console.error('Failed to fetch plugins:', error);
    } finally {
      setLoading(false);
    }
  };

  // Add plugin to bus
  const handleAddPlugin = async (plugin: PluginInfoDto) => {
    if (!bus) return;
    try {
      await addPluginToBus(bus.handle, plugin.plugin_id);
      setShowPluginBrowser(false);
      setPluginSearchQuery('');
      onPluginsChange?.();
    } catch (error) {
      console.error('Failed to add plugin:', error);
    }
  };

  // Remove plugin from bus
  const handleRemovePlugin = async (instanceId: string) => {
    if (!bus) return;
    try {
      await removePluginFromBus(bus.handle, instanceId);
      onPluginsChange?.();
    } catch (error) {
      console.error('Failed to remove plugin:', error);
    }
  };

  // Open plugin UI
  const handleOpenPluginUI = async (instanceId: string) => {
    try {
      await openPluginUI(instanceId);
    } catch (error) {
      console.error('Failed to open plugin UI:', error);
    }
  };

  // Drag and drop reorder
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, toIdx: number) => {
    e.preventDefault();
    if (!bus || dragIdx === null || dragIdx === toIdx) {
      setDragIdx(null);
      return;
    }

    const newOrder = [...plugins];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(toIdx, 0, moved);

    try {
      await reorderPlugins(bus.handle, newOrder.map(p => p.id));
      onPluginsChange?.();
    } catch (error) {
      console.error('Failed to reorder plugins:', error);
    }

    setDragIdx(null);
  };

  // Filter plugins by search query
  const filteredPlugins = availablePlugins.filter(p => {
    if (!pluginSearchQuery) return true;
    const q = pluginSearchQuery.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.manufacturer.toLowerCase().includes(q);
  });

  // Group by manufacturer
  const byManufacturer: Record<string, PluginInfoDto[]> = {};
  for (const p of filteredPlugins) {
    if (!byManufacturer[p.manufacturer]) byManufacturer[p.manufacturer] = [];
    byManufacturer[p.manufacturer].push(p);
  }
  const manufacturers = Object.keys(byManufacturer).sort();

  return (
    <>
      {/* Bus Detail Section - rendered inline within MixerPanel */}
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="h-8 bg-purple-900/30 border-b border-purple-500/30 flex items-center px-3 justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Workflow className={`w-3 h-3 ${busColor}`} />
            <span className="text-[10px] font-bold text-purple-300 uppercase tracking-widest truncate">
              {bus ? bus.label : 'Bus Detail'}
            </span>
          </div>
          {bus && (
            <span className="text-[9px] text-purple-400">{bus.channelCount}ch</span>
          )}
        </div>

        {!bus ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-slate-600">
              <Workflow className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <div className="text-[10px]">Select a bus to view details</div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Effect Chain Header */}
            <div className="px-3 py-2 border-b border-slate-700/50">
              <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                Effect Chain
              </div>
            </div>

            {/* Plugin List */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
              {plugins.length === 0 ? (
                <div className="text-[10px] text-slate-600 text-center py-4">
                  No effects loaded
                </div>
              ) : (
                plugins.map((plugin, idx) => (
                  <div
                    key={plugin.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, idx)}
                    onClick={() => {
                      console.debug('BusPanel: opening plugin UI', plugin.id);
                      handleOpenPluginUI(plugin.id)
                    }}
                    className={`flex items-center gap-1.5 p-1.5 rounded border transition-all cursor-pointer hover:border-purple-400 ${
                      plugin.enabled
                        ? 'bg-purple-500/10 border-purple-500/30'
                        : 'bg-slate-800/50 border-slate-700 opacity-50'
                    } ${dragIdx === idx ? 'opacity-50' : ''}`}
                  >
                    <div className="cursor-grab active:cursor-grabbing text-slate-600 hover:text-slate-400">
                      <GripVertical className="w-2.5 h-2.5" />
                    </div>
                    <div className="w-3 text-[8px] text-slate-500 text-center">{idx + 1}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[9px] font-medium text-slate-200 truncate">{plugin.name}</div>
                      <div className="text-[7px] text-slate-500 truncate">{plugin.manufacturer}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemovePlugin(plugin.id);
                      }}
                      className="w-4 h-4 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Add Plugin Button */}
            <div className="px-2 py-2 border-t border-slate-700/50">
              <button
                onClick={handleOpenPluginBrowser}
                disabled={loading}
                className="w-full py-1.5 px-2 rounded border border-dashed border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10 text-purple-400 hover:text-purple-300 transition-all text-[9px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Plus className="w-2.5 h-2.5" />
                {loading ? 'Loading...' : 'Add AudioUnit'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Plugin Browser Modal */}
      {showPluginBrowser && bus && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="w-[480px] max-h-[600px] bg-slate-900 rounded-xl border border-slate-700 shadow-2xl flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-slate-700 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <Music className="w-4 h-4 text-purple-400" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-bold text-white">AudioUnit Plugins</div>
                <div className="text-[10px] text-slate-500">Select an effect to add to {bus.label}</div>
              </div>
              <button
                onClick={() => {
                  setShowPluginBrowser(false);
                  setPluginSearchQuery('');
                }}
                className="p-1.5 rounded hover:bg-slate-800 text-slate-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search */}
            <div className="p-3 border-b border-slate-700">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  value={pluginSearchQuery}
                  onChange={(e) => setPluginSearchQuery(e.target.value)}
                  placeholder="Search plugins..."
                  className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                  autoFocus
                />
              </div>
            </div>

            {/* Plugin List */}
            <div className="flex-1 overflow-y-auto p-3">
              {manufacturers.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
                  {pluginSearchQuery ? 'No plugins found' : 'Loading plugins...'}
                </div>
              ) : (
                <div className="space-y-4">
                  {manufacturers.map(manufacturer => (
                    <div key={manufacturer}>
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-2 py-1">
                        {manufacturer}
                      </div>
                      <div className="space-y-1">
                        {byManufacturer[manufacturer].map(plugin => (
                          <button
                            key={plugin.plugin_id}
                            onClick={() => handleAddPlugin(plugin)}
                            className="w-full flex items-center gap-3 p-3 rounded-lg bg-slate-800/50 hover:bg-purple-500/20 border border-transparent hover:border-purple-500/30 transition-all text-left group"
                          >
                            <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                              <Music className="w-4 h-4 text-purple-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-white truncate group-hover:text-purple-300">
                                {plugin.name}
                              </div>
                              <div className="text-[10px] text-slate-500 flex items-center gap-2">
                                <span>{plugin.category}</span>
                              </div>
                            </div>
                            <Plus className="w-4 h-4 text-slate-600 group-hover:text-purple-400 transition-colors" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-slate-700 bg-slate-900/50">
              <div className="text-[10px] text-slate-500 text-center">
                {availablePlugins.length} plugins available
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
