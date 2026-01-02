// @ts-nocheck
// Legacy file: effect chain + plugin browser UI.
// New architecture: DetailView -> BusDetailView -> EffectChainView.
import React, { useState } from 'react';
import { Workflow, Plus, Trash2, GripVertical, X, Search, Music, ChevronUp, ChevronDown, Power, PowerOff } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  DragOverlay,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getBusColor } from '../hooks/useNodeDisplay';
import {
  getAvailablePlugins,
  addPluginToBus,
  removePluginFromBus,
  reorderPlugins,
  openPluginUI,
  setPluginEnabled,
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
}

interface Props {
  bus: BusInfo | null;
  onPluginsChange?: () => void;
}

function SortablePluginRow({
  plugin,
  idx,
  dragDisabled,
  anyDragging,
  onOpen,
  onRemove,
  onToggleEnabled,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  plugin: PluginInstance;
  idx: number;
  dragDisabled: boolean;
  anyDragging: boolean;
  onOpen: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  onToggleEnabled: (instanceId: string, enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: plugin.id, disabled: dragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // Keep pointer-based dragging stable across trackpads.
      // Prevent the browser from interpreting the gesture as scroll while dragging.
      onPointerDownCapture={(e) => {
        // If user starts on a button, buttons will stopPropagation.
        // Otherwise allow drag.
        (e.currentTarget as any).style.touchAction = 'none';
      }}
      onClick={() => {
        // Avoid accidental open when the user was dragging.
        if (isDragging || anyDragging) return;
        console.debug('BusPanel: opening plugin UI', plugin.id);
        onOpen(plugin.id);
      }}
      className={`flex items-center gap-1.5 p-1.5 rounded border cursor-pointer hover:border-purple-400 transition-colors ${
        plugin.enabled
          ? 'bg-purple-500/10 border-purple-500/30'
          : 'bg-slate-800/50 border-slate-700 opacity-50'
      } ${isDragging ? 'opacity-50' : ''}`}
    >
      <div className="w-4 text-[8px] text-slate-500 text-center select-none">{idx + 1}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[9px] font-medium text-slate-200 truncate">{plugin.name}</div>
        <div className="text-[7px] text-slate-500 truncate">{plugin.manufacturer}</div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleEnabled(plugin.id, !plugin.enabled);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${
          plugin.enabled
            ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/40'
            : 'text-purple-300 hover:text-purple-200 hover:bg-purple-500/15'
        }`}
        aria-label={plugin.enabled ? 'Bypass plugin' : 'Enable plugin'}
        title={plugin.enabled ? 'Bypass' : 'Enable'}
      >
        {plugin.enabled ? (
          <Power className="w-2.5 h-2.5" />
        ) : (
          <PowerOff className="w-2.5 h-2.5" />
        )}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMoveUp();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!canMoveUp}
        className={`w-4 h-4 rounded flex items-center justify-center text-slate-500 transition-colors ${
          !canMoveUp
            ? 'opacity-30 cursor-not-allowed'
            : 'hover:text-slate-300 hover:bg-slate-700/40'
        }`}
        aria-label="Move plugin up"
        title="Move up"
      >
        <ChevronUp className="w-2.5 h-2.5" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMoveDown();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!canMoveDown}
        className={`w-4 h-4 rounded flex items-center justify-center text-slate-500 transition-colors ${
          !canMoveDown
            ? 'opacity-30 cursor-not-allowed'
            : 'hover:text-slate-300 hover:bg-slate-700/40'
        }`}
        aria-label="Move plugin down"
        title="Move down"
      >
        <ChevronDown className="w-2.5 h-2.5" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(plugin.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-red-500/20 transition-colors"
      >
        <Trash2 className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

function DragOverlayRow({ plugin, idx }: { plugin: PluginInstance; idx: number }) {
  return (
    <div
      className={`flex items-center gap-1.5 p-1.5 rounded border cursor-grabbing border-purple-400 bg-purple-500/10`}
      style={{
        boxShadow: 'none',
      }}
    >
      <div className="w-4 text-[8px] text-slate-300 text-center select-none">{idx + 1}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[9px] font-medium text-slate-100 truncate">{plugin.name}</div>
        <div className="text-[7px] text-slate-400 truncate">{plugin.manufacturer}</div>
      </div>
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export default function BusPanel({ bus, onPluginsChange }: Props) {
  const [showPluginBrowser, setShowPluginBrowser] = useState(false);
  const [availablePlugins, setAvailablePlugins] = useState<PluginInfoDto[]>([]);
  const [pluginSearchQuery, setPluginSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [localPlugins, setLocalPlugins] = useState<PluginInstance[]>([]);

  const plugins = bus?.plugins || [];
  const busNum = bus?.busId ? parseInt(bus.busId.replace('bus_', ''), 10) || 1 : 1;
  const busColor = bus ? getBusColor(busNum) : 'text-purple-400';

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Smaller distance makes it easier to start dragging (trackpad-friendly).
      activationConstraint: { distance: 3 },
    })
  );

  React.useEffect(() => {
    // Avoid resetting the list while dragging.
    if (activeDragId) return;
    setLocalPlugins(plugins);
  }, [activeDragId, plugins, bus?.handle]);

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

  const handleSetPluginEnabled = async (instanceId: string, enabled: boolean) => {
    if (!bus) return;

    // Optimistic UI
    const prev = localPlugins;
    setLocalPlugins((current) =>
      current.map((p) => (p.id === instanceId ? { ...p, enabled } : p))
    );

    try {
      await setPluginEnabled(bus.handle, instanceId, enabled);
      onPluginsChange?.();
    } catch (error) {
      console.error('Failed to set plugin enabled:', error);
      setLocalPlugins(prev);
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

  const handleReorder = async (newOrder: PluginInstance[]) => {
    if (!bus) return;
    const instanceIds = newOrder.map(p => p?.id).filter(Boolean);
    if (instanceIds.length !== newOrder.length) {
      console.error('Failed to reorder plugins: missing instance id(s)', { newOrder });
      return;
    }
    // Optimistic UI
    setLocalPlugins(newOrder);
    try {
      await reorderPlugins(bus.handle, instanceIds);
      onPluginsChange?.();
    } catch (error) {
      console.error('Failed to reorder plugins:', error);
      // Revert on failure
      setLocalPlugins(plugins);
    }
  };

  const handleMovePlugin = async (fromIdx: number, toIdx: number) => {
    if (!bus) return;
    if (fromIdx === toIdx) return;
    if (fromIdx < 0 || fromIdx >= localPlugins.length) return;
    if (toIdx < 0 || toIdx >= localPlugins.length) return;

    const newOrder = [...localPlugins];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);

    await handleReorder(newOrder);
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
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
              {localPlugins.length === 0 ? (
                <div className="text-[10px] text-slate-600 text-center py-4">
                  No effects loaded
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={(event) => {
                    const id = event?.active?.id;
                    setActiveDragId(typeof id === 'string' ? id : null);
                  }}
                  onDragCancel={() => setActiveDragId(null)}
                  onDragEnd={async (event) => {
                    const { active, over } = event;
                    setActiveDragId(null);
                    if (!active?.id || !over?.id) return;
                    if (active.id === over.id) return;
                    const oldIndex = localPlugins.findIndex(p => p.id === active.id);
                    const newIndex = localPlugins.findIndex(p => p.id === over.id);
                    if (oldIndex < 0 || newIndex < 0) return;
                    const newOrder = arrayMove(localPlugins, oldIndex, newIndex);
                    await handleReorder(newOrder);
                  }}
                >
                  <SortableContext
                    items={localPlugins.map(p => p.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {localPlugins.map((plugin, idx) => (
                      <SortablePluginRow
                        key={plugin.id}
                        plugin={plugin}
                        idx={idx}
                        dragDisabled={loading}
                        anyDragging={!!activeDragId}
                        onOpen={(id) => void handleOpenPluginUI(id)}
                        onRemove={(id) => void handleRemovePlugin(id)}
                        onToggleEnabled={(id, enabled) => void handleSetPluginEnabled(id, enabled)}
                        onMoveUp={() => void handleMovePlugin(idx, idx - 1)}
                        onMoveDown={() => void handleMovePlugin(idx, idx + 1)}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < localPlugins.length - 1}
                      />
                    ))}
                  </SortableContext>
                  <DragOverlay>
                    {activeDragId ? (() => {
                      const idx = localPlugins.findIndex(p => p.id === activeDragId);
                      const plugin = localPlugins.find(p => p.id === activeDragId);
                      if (!plugin || idx < 0) return null;
                      return <DragOverlayRow plugin={plugin} idx={idx} />;
                    })() : null}
                  </DragOverlay>
                </DndContext>
              )}
            </div>

            {/* Add Plugin Button */}
            <div className="px-3 py-3 pb-4 border-t border-slate-700/50">
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
                <div className="text-[10px] text-slate-500">Select a plugin to add to {bus.label}</div>
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
                                <span>{plugin.manufacturer}</span>
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
