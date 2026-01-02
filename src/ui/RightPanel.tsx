// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Workflow, Plus, Trash2 } from 'lucide-react';
import { getIconForDevice } from '../hooks/useIcons';
import { getBusColor, getVirtualOutputDisplay } from '../hooks/useNodeDisplay';
import type { UseDevicesReturn } from '../hooks/useDevices';

interface BusInfo {
  id: string;
  label: string;
  busId?: string;
  channelCount: number;
  plugins?: any[];
}

interface Props {
  width: number;
  devices?: UseDevicesReturn | null;
  buses?: BusInfo[];
  selectedBusId?: string | null;
  isLibraryItemUsed?: (id: string) => boolean;
  handleLibraryMouseDown?: (e: React.MouseEvent, type: string, id: string) => void;
  onAddBus?: () => Promise<void>;
  onSelectBus?: (busId: string | null) => void;
  onDeleteBus?: (busId: string) => void;
}

export default function RightPanel({ width, devices, buses = [], selectedBusId, isLibraryItemUsed, handleLibraryMouseDown, onAddBus, onSelectBus, onDeleteBus }: Props) {
  const outputDevices = devices?.outputDevices || [];
  const startOutput = devices?.startOutput;
  const stopOutput = devices?.stopOutput;

  // Store latest functions in refs to avoid recreating effect
  const startOutputRef = React.useRef(startOutput);
  const stopOutputRef = React.useRef(stopOutput);
  startOutputRef.current = startOutput;
  stopOutputRef.current = stopOutput;

  const [selected, setSelected] = useState<number | ''>('');

  useEffect(() => {
    // debug: log device list to help diagnose empty pulldown
    try {
      // eslint-disable-next-line no-console
      console.log('RightPanel: devices', { outputDevices, activeOutputs: (devices as any)?.activeOutputs });
    } catch (e) {}
    // Prefer an active output from the devices hook if available
    const active = (devices as any)?.activeOutputs as number[] | undefined;
    if (active && active.length > 0) {
      setSelected(active[0]);
      return;
    }
    if (outputDevices.length > 0 && selected === '') {
      setSelected(outputDevices[0].deviceId);
    }
  }, [outputDevices, (devices as any)?.activeOutputs]);

  // When selection changes, stop previously selected output (if any) and start the new one.
  // Note: Initial audio start is now handled by backend, this only handles user-initiated switches
  const prevRef = React.useRef<number | ''>('');
  useEffect(() => {
    const prev = prevRef.current;
    const cur = selected;
    let mounted = true;
    (async () => {
      try {
        if (!mounted) return;
        // Get latest functions from refs
        const stopFn = stopOutputRef.current;
        const startFn = startOutputRef.current;

        // Debug: log transition and available control functions
        try { console.debug('RightPanel: output change', { prev, cur, activeOutputs: (devices as any)?.activeOutputs, hasStop: !!stopFn, hasStart: !!startFn }); } catch (e) {}

        // Only switch if user explicitly changed selection (prev !== '')
        if (prev !== '' && prev !== cur && stopFn) {
          try {
            console.debug('RightPanel: calling stopOutput', prev);
            await stopFn(Number(prev));
            console.debug('RightPanel: stopOutput resolved', prev);
          } catch (e) {
            console.error('RightPanel: stopOutput failed', e);
          }
        }

        // Start new output if user changed selection (prev !== '')
        if (prev !== '' && cur !== '' && startFn) {
          try {
            console.debug('RightPanel: calling startOutput', cur);
            await startFn(Number(cur));
            console.debug('RightPanel: startOutput resolved', cur);
          } catch (e) {
            console.error('RightPanel: startOutput failed', e);
          }
        }
      } catch (e) {
        console.error(e);
      }
    })();
    prevRef.current = selected;
    return () => { mounted = false; };
  }, [selected]);

  return (
    <div className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 z-10 shadow-xl relative" style={{ width }} onClick={e => e.stopPropagation()}>
      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-3">
          <Workflow className="w-3 h-3" /> Buses / Aux
        </div>
        <button
          onClick={onAddBus}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-dashed border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/20 hover:border-purple-400 text-purple-400 hover:text-purple-300 transition-all text-xs font-medium mb-3"
        >
          <Plus className="w-3.5 h-3.5" /> Add Bus
        </button>
        {buses.length > 0 && (
          <div className="space-y-2">
            {buses.map((bus, idx) => {
              const busNum = bus.busId ? parseInt(bus.busId.replace('bus_', ''), 10) || (idx + 1) : (idx + 1);
              const color = getBusColor(busNum);
              const isSelected = selectedBusId === bus.id;
              return (
                <div
                  key={bus.id}
                  onClick={() => onSelectBus?.(isSelected ? null : bus.id)}
                  className={`group flex items-center gap-3 p-2 rounded-lg border cursor-pointer transition-all ${isSelected ? 'border-purple-500 bg-purple-500/20' : 'border-slate-700 bg-slate-800/50 hover:border-purple-500/50'}`}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center bg-slate-950`}>
                    <Workflow className={`w-3.5 h-3.5 ${color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-200 truncate">{bus.label}</div>
                    <div className="text-[9px] text-slate-500">{bus.channelCount}ch • {bus.plugins?.length || 0} FX</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteBus?.(bus.id); }}
                    className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-3">
          {(() => {
              const phys = outputDevices.find(d => d.deviceId === Number(selected));
              const Icon = getIconForDevice(phys?.iconName, phys?.name);
              return <Icon className="w-3 h-3" />;
            })()}
          Output Device
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={String(selected)}
            onChange={(e) => setSelected(e.target.value === '' ? '' : Number(e.target.value))}
            className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none cursor-pointer"
          >
            <option value="">Select output device...</option>
            {outputDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.name}{d.isAggregate ? ' (Aggregate)' : ''} ({d.channelCount}ch)</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {!selected ? (
          <div className="text-center py-8 text-slate-600 text-xs">Select an output device above</div>
        ) : (() => {
          const virtuals = (devices as any)?.virtualOutputDevices?.filter((v: any) => Number(v.parentDeviceId) === Number(selected)) || [];
          const phys = outputDevices.find(d => d.deviceId === Number(selected));
          if (virtuals.length === 0) {
            // Show single entry representing full device
            const channels = phys ? phys.channelCount : 0;
            return (
              <div className="text-center py-8 text-slate-600 text-xs">{channels > 0 ? `${channels}ch available` : 'No channels available'}</div>
            );
          }

          return virtuals.map((v: any) => {
            const isUsed = isLibraryItemUsed ? isLibraryItemUsed(v.id) : false;
            const display = getVirtualOutputDisplay(v.name, v.channels || v.channelCount || 2, v.iconHint);
            const Icon = display.icon;
            const iconColor = display.iconColor || 'text-slate-500';
            const isCssColor = typeof iconColor === 'string' && (iconColor.startsWith('rgb') || iconColor.startsWith('#') || iconColor.startsWith('hsl'));
            return (
              <div key={v.id} onMouseDown={!isUsed && handleLibraryMouseDown ? (e) => handleLibraryMouseDown(e, 'lib_target', v.id) : undefined} className={`group flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-800/80 hover:border-pink-500/50 hover:bg-slate-800 ${isUsed ? 'cursor-default opacity-40' : 'cursor-grab active:cursor-grabbing'}`}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-950">
                  {isCssColor
                    ? <Icon className="w-4 h-4" style={{ color: iconColor }} />
                    : <Icon className={`w-4 h-4 ${iconColor}`} />}
                </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-slate-200 truncate">{v.name}</div>
                <div className="text-[9px] text-slate-500 uppercase">{v.channels}ch • {(v.transportType ? String(v.transportType) : 'Virtual')}</div>
              </div>
                <Plus className="w-4 h-4 text-slate-600 group-hover:text-pink-400 transition-colors" />
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}
