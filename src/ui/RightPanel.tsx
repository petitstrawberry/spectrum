// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Workflow, Plus, Speaker } from 'lucide-react';
import type { UseDevicesReturn } from '../hooks/useDevices';

interface Props {
  width: number;
  devices?: UseDevicesReturn | null;
}

export default function RightPanel({ width, devices }: Props) {
  const outputDevices = devices?.outputDevices || [];
  const startOutput = devices?.startOutput;
  const stopOutput = devices?.stopOutput;

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
  const prevRef = React.useRef<number | ''>('');
  useEffect(() => {
    const prev = prevRef.current;
    const cur = selected;
    let mounted = true;
    (async () => {
      try {
        if (!mounted) return;
        if (prev !== '' && prev !== cur && stopOutput) {
          await stopOutput(Number(prev));
        }
        if (cur !== '' && startOutput) {
          await startOutput(Number(cur));
        }
      } catch (e) {
        console.error(e);
      }
    })();
    prevRef.current = selected;
    return () => { mounted = false; };
  }, [selected, startOutput, stopOutput]);

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
        <div className="mt-2 text-xs text-slate-400">
          <div className="mt-1 text-[11px] text-slate-400">Select an output device from the pulldown</div>
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

          return virtuals.map((v: any) => (
            <div key={v.id} className={`group flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-800/80 hover:border-pink-500/50 hover:bg-slate-800 cursor-pointer`}>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center bg-slate-950 text-slate-300`}>
                <Speaker className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-slate-200 truncate">{v.name}</div>
                <div className="text-[9px] text-slate-500 uppercase">{v.channels}ch • Virtual</div>
              </div>
              <Plus className="w-4 h-4 text-slate-600 group-hover:text-pink-400 transition-colors" />
            </div>
          ));
        })()}
      </div>
    </div>
  );
}
