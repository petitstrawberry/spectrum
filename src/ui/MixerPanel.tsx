// @ts-nocheck
import React from 'react';
import { Maximize2, Volume2, Monitor } from 'lucide-react';
import DetailView from './detail/DetailView';
import type { BusInfo } from './detail/types';
import type { UINode } from '../types/graph';
import { dbToGain, gainToDb, setEdgeGainsBatch } from '../lib/api';

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

function faderToDb(percent: number): number {
  const p = Math.max(0, Math.min(100, percent));
  if (p <= 0) return -100;
  if (p >= 100) return 6;

  if (p >= 86.9) return 3 + ((p - 86.9) / 13.1) * 3;
  if (p >= 74.3) return ((p - 74.3) / 12.6) * 3;
  if (p >= 61.2) return -3 + ((p - 61.2) / 13.1) * 3;
  if (p >= 48.5) return -6 + ((p - 48.5) / 12.7) * 3;
  if (p >= 39.9) return -10 + ((p - 39.9) / 8.6) * 4;
  if (p >= 29.1) return -15 + ((p - 29.1) / 10.8) * 5;
  if (p >= 20.9) return -20 + ((p - 20.9) / 8.2) * 5;
  if (p >= 12.3) return -30 + ((p - 12.3) / 8.6) * 10;
  if (p >= 8.2) return -40 + ((p - 8.2) / 4.1) * 10;
  // Below -40dB region: p = 8.2*(1 + (db+40)/60)
  return (60 * p) / 8.2 - 100;
}

function parseEdgeId(edgeId: any): number | null {
  if (typeof edgeId === 'number' && Number.isFinite(edgeId)) return edgeId;
  if (typeof edgeId !== 'string') return null;
  const m = edgeId.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function formatDb(db: number): string {
  if (!isFinite(db) || db <= -99.5) return '-∞';
  const rounded = Math.round(db * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}dB`;
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

function FaderScale({ onSelectDb }: { onSelectDb?: (db: number) => void }) {
  const ticks = [
    { label: '+6', db: 6, size: 'w-1.5', labelClass: '' },
    { label: '+3', db: 3, size: 'w-1.5', labelClass: '' },
    { label: '0', db: 0, size: 'w-2.5', labelClass: 'text-white font-bold' },
    { label: '-3', db: -3, size: 'w-1.5', labelClass: '' },
    { label: '-6', db: -6, size: 'w-1.5', labelClass: '' },
    { label: '-10', db: -10, size: 'w-1.5', labelClass: 'text-[6px]' },
    { label: '-15', db: -15, size: 'w-1.5', labelClass: 'text-[6px]' },
    { label: '-20', db: -20, size: 'w-1.5', labelClass: 'text-[6px]' },
    { label: '-30', db: -30, size: 'w-1.5', labelClass: 'text-[6px]' },
    { label: '-40', db: -40, size: 'w-1.5', labelClass: 'text-[6px]' },
  ];

  return (
    <div className="absolute -left-7 top-0 bottom-0 w-7 flex flex-col text-[7px] text-slate-400 font-mono select-none">
      {/* +6 at top */}
      <button
        type="button"
        className="absolute right-0 flex items-center hover:text-slate-200"
        style={{ top: '0', transform: 'translateY(-50%)' }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSelectDb?.(6)}
        aria-label="Set fader to +6 dB"
      >
        <span className="mr-0.5">+6</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </button>

      {ticks.slice(1).map((t) => (
        <button
          key={t.db}
          type="button"
          className="absolute right-0 flex items-center hover:text-slate-200"
          style={{ bottom: `${dbToFader(t.db)}%`, transform: 'translateY(50%)' }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelectDb?.(t.db)}
          aria-label={`Set fader to ${t.label} dB`}
        >
          <span className={`mr-0.5 ${t.labelClass || ''}`}>{t.label}</span>
          <div className={`${t.size} h-px ${t.db === 0 ? 'bg-white' : 'bg-slate-500'}`} />
        </button>
      ))}

      <button
        type="button"
        className="absolute right-0 flex items-center hover:text-slate-200"
        style={{ bottom: '0', transform: 'translateY(50%)' }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSelectDb?.(-100)}
        aria-label="Set fader to -infinity"
      >
        <span className="mr-0.5">-∞</span>
        <div className="w-1.5 h-px bg-slate-500" />
      </button>
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
  mixerStrips?: any[];
  onPluginsChange?: () => void;
}

export default function MixerPanel({ mixerHeight, masterWidth, channelSources = [], selectedBus, selectedNode, mixerStrips = [], onPluginsChange }: Props) {
  const strips = Array.isArray(mixerStrips) ? mixerStrips : [];
  const showStrips = strips.length > 0 && (selectedNode?.type === 'target' || selectedNode?.type === 'bus');

  const [gainByStripId, setGainByStripId] = React.useState<Record<string, number>>({});
  const [editingStripId, setEditingStripId] = React.useState<string | null>(null);
  const [editingDbText, setEditingDbText] = React.useState<string>('');
  const editInputRef = React.useRef<HTMLInputElement | null>(null);
  const dragRef = React.useRef<{ stripId: string; pointerId: number } | null>(null);
  const lastSendMsRef = React.useRef<Record<string, number>>({});

  React.useEffect(() => {
    setGainByStripId((prev) => {
      const next = { ...prev };
      for (const s of strips) {
        if (!s?.id) continue;
        if (next[s.id] == null) {
          const g = typeof s.sendLevel === 'number' ? s.sendLevel : 1.0;
          next[s.id] = Number.isFinite(g) ? g : 1.0;
        }
      }
      return next;
    });
  }, [strips]);

  const setStripGain = (strip: any, gain: number, opts?: { commit?: boolean }) => {
    if (!strip?.id) return;
    const g = Math.max(0, Math.min(4, gain));
    setGainByStripId((prev) => ({ ...prev, [strip.id]: g }));

    const shouldCommit = opts?.commit ?? false;
    const now = performance.now();
    const last = lastSendMsRef.current[strip.id] || 0;
    if (!shouldCommit && now - last < 33) return;
    lastSendMsRef.current[strip.id] = now;

    const ids = (Array.isArray(strip.connectionIds) ? strip.connectionIds : [])
      .map(parseEdgeId)
      .filter((n: any) => typeof n === 'number' && Number.isFinite(n));
    if (ids.length === 0) return;

    void setEdgeGainsBatch(ids.map((id: number) => ({ id, gain: g }))).catch((err: any) => {
      console.warn('[mixer] setEdgeGainsBatch failed', err);
    });
  };

  const updateGainFromPointer = (strip: any, trackEl: HTMLElement, clientY: number, opts?: { commit?: boolean }) => {
    const rect = trackEl.getBoundingClientRect();
    const rel = (rect.bottom - clientY) / rect.height;
    const percent = Math.max(0, Math.min(1, rel)) * 100;
    const db = faderToDb(percent);
    const gain = dbToGain(db);
    setStripGain(strip, gain, opts);
  };

  React.useEffect(() => {
    if (!editingStripId) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingStripId]);

  const parseDbText = (raw: string): number | null => {
    const s0 = String(raw ?? '').trim();
    if (s0 === '') return null;
    const s = s0.toLowerCase();
    const isNegInf =
      s === '-inf' || s === '-infinity' || s === '−inf' || s === '−infinity' || s === '-∞' || s === 'inf' || s === '∞';
    if (isNegInf) return -100;

    const cleaned = s.replace(/db$/i, '').replace(/\s+/g, '');
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return Math.max(-100, Math.min(6, n));
  };

  const beginInlineDbEdit = (strip: any, currentDb: number) => {
    if (!strip?.id) return;
    setEditingStripId(strip.id);
    const initial = isFinite(currentDb) && currentDb > -99.5 ? String(Math.round(currentDb * 10) / 10) : '-inf';
    setEditingDbText(initial);
  };

  const commitInlineDbEdit = (strip: any) => {
    const db = parseDbText(editingDbText);
    setEditingStripId(null);
    if (db == null) return;
    setStripGain(strip, dbToGain(db), { commit: true });
  };

  const cancelInlineDbEdit = () => {
    setEditingStripId(null);
  };

  const getStripChannelLabel = (strip: any) => {
    const n = strip?.sourceNode;
    const from = Array.isArray(strip?.fromChannels) ? strip.fromChannels : [];
    // Prefer Prism channel offset when present.
    const off = Number(n?.channelOffset);
    if (!Number.isNaN(off) && (n?.sourceType === 'prism-channel' || n?.sourceType === 'prism')) {
      const abs = off <= 31 ? off * 2 : off;
      return `${abs + 1}-${abs + 2}`;
    }
    // Fallback: derive from source ports.
    if (from.length >= 2) return `${Number(from[0]) + 1}-${Number(from[1]) + 1}`;
    if (from.length === 1) return `${Number(from[0]) + 1}`;
    return '—';
  };

  const getStripTitle = (strip: any) => {
    const n = strip?.sourceNode;
    return n?.subLabel || n?.label || 'INPUT';
  };

  const getStripIcon = (strip: any) => {
    const n = strip?.sourceNode;
    return n?.icon || Volume2;
  };

  const getStripIconColor = (strip: any) => {
    const n = strip?.sourceNode;
    return n?.iconColor || n?.color || 'text-slate-500';
  };

  const renderIcon = (Icon: any, iconColor: string) => {
    const isCssColor = typeof iconColor === 'string' && (
      iconColor.startsWith('rgb') ||
      iconColor.startsWith('#') ||
      iconColor.startsWith('hsl')
    );
    if (!Icon) return null;
    return isCssColor
      ? <Icon className="w-3 h-3" style={{ color: iconColor }} />
      : <Icon className={`w-3 h-3 ${iconColor}`} />;
  };

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
          {showStrips ? (
            strips.map((strip: any) => {
              const Icon = getStripIcon(strip);
              const iconColor = getStripIconColor(strip);
              const chLabel = getStripChannelLabel(strip);
              const title = getStripTitle(strip);
              const isMuted = !!strip?.muted;
              const gain = typeof gainByStripId[strip.id] === 'number'
                ? gainByStripId[strip.id]
                : (typeof strip.sendLevel === 'number' ? strip.sendLevel : 1.0);
              const db = gainToDb(gain);
              const displayDbText = formatDb(db);
              const dbFieldWidthCh = Math.max(4, Math.max(displayDbText.length, editingDbText.length || 0));
              const level = dbToFader(isFinite(db) ? Math.max(-100, Math.min(6, db)) : -100);
              const isEditingDb = editingStripId === strip.id;

              return (
                <div key={strip.id} className="w-32 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none">
                  <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
                    <div className="w-6 h-6 rounded-lg bg-slate-950 border border-slate-600 flex items-center justify-center shadow-lg">
                      {renderIcon(Icon, iconColor)}
                    </div>
                  </div>
                  <div className="w-full px-1 text-center mb-2">
                    <div className="text-[7px] font-mono text-slate-500">{chLabel}</div>
                    <div className="text-[9px] font-bold truncate text-slate-300">{title}</div>
                  </div>
                  <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative">
                    <div className="relative mr-2">
                      <FaderScale onSelectDb={(dbSel) => setStripGain(strip, dbToGain(dbSel), { commit: true })} />
                      <div
                        className="w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700 cursor-ns-resize"
                        style={{ touchAction: 'none' }}
                        onPointerDown={(e: any) => {
                          e.preventDefault();
                          dragRef.current = { stripId: strip.id, pointerId: e.pointerId };
                          try { (e.currentTarget as any).setPointerCapture(e.pointerId); } catch {}
                          updateGainFromPointer(strip, e.currentTarget, e.clientY);
                        }}
                        onPointerMove={(e: any) => {
                          const d = dragRef.current;
                          if (!d || d.stripId !== strip.id || d.pointerId !== e.pointerId) return;
                          updateGainFromPointer(strip, e.currentTarget, e.clientY);
                        }}
                        onPointerUp={(e: any) => {
                          const d = dragRef.current;
                          if (!d || d.stripId !== strip.id || d.pointerId !== e.pointerId) return;
                          updateGainFromPointer(strip, e.currentTarget, e.clientY, { commit: true });
                          dragRef.current = null;
                        }}
                        onPointerCancel={() => {
                          dragRef.current = null;
                        }}
                      >
                        <div className={`absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow z-10 ${isMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${level}% - 5px)` }}></div>
                      </div>
                    </div>
                    <div className="flex gap-0.5 relative">
                      <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950" />
                      <div className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5" />
                      <MeterScale />
                    </div>
                  </div>
                  <div className="mt-1 h-4 flex items-center justify-center">
                    {isMuted ? (
                      <div className="text-[8px] font-mono text-slate-500" style={{ width: `${dbFieldWidthCh}ch` }}>MUTE</div>
                    ) : isEditingDb ? (
                      <input
                        ref={(el) => { editInputRef.current = el; }}
                        className="h-4 rounded bg-transparent border border-slate-700 text-[8px] font-mono text-slate-200 px-0 outline-none focus:border-slate-500 text-center box-border"
                        style={{ width: `${dbFieldWidthCh}ch` }}
                        value={editingDbText}
                        onChange={(e) => setEditingDbText(e.target.value)}
                        onBlur={() => commitInlineDbEdit(strip)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitInlineDbEdit(strip);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelInlineDbEdit();
                          }
                        }}
                        aria-label="Edit fader dB"
                      />
                    ) : (
                      <button
                        type="button"
                        className="text-[8px] font-mono text-slate-500 hover:text-slate-200 text-center"
                        style={{ width: `${dbFieldWidthCh}ch` }}
                        onClick={() => beginInlineDbEdit(strip, db)}
                        onMouseDown={(e) => e.preventDefault()}
                        aria-label="Edit fader dB"
                      >
                        {displayDbText}
                      </button>
                    )}
                  </div>
                  <div className="flex gap-1 mt-1 w-full px-1">
                    <button className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>M</button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex-1 flex items-center justify-center min-w-0">
              <div className="text-[10px] text-slate-600">No connected inputs for the selected output/bus</div>
            </div>
          )}
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
