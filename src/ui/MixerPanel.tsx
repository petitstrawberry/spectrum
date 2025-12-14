// @ts-nocheck
import React from 'react';
import { Maximize2, Volume2, Monitor } from 'lucide-react';
import DetailView from './detail/DetailView';
import type { BusInfo } from './detail/types';
import type { UINode } from '../types/graph';
import { dbToGain, gainToDb, setEdgeGainsBatch, setEdgeMuted, getEdgeMeters, getNodeMeters } from '../lib/api';

// =============================================================================
// Canvas meter helpers (v1-style)
// =============================================================================

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, Math.min(w / 2, h / 2)));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function parseNodeHandleFromId(nodeId: any): number | null {
  if (typeof nodeId !== 'string') return null;
  const m = nodeId.match(/^node_(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

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
  mixerChannelMode?: 'stereo' | 'mono';
  onToggleMixerChannelMode?: () => void;
  mixerTargetPortCount?: number;
  mixerSelectedChannel?: number;
  onMixerSelectedChannel?: (ch: number) => void;
  outputTargets?: Array<{
    id: string;
    label: string;
    subLabel?: string;
    icon?: any;
    iconColor?: string;
    disabled?: boolean;
  }>;
  focusedOutputId?: string | null;
  onFocusOutputId?: (outputNodeId: string | null) => void | Promise<void>;
  focusedOutputChannel?: number;
  onFocusOutputChannel?: (ch: number) => void;
  focusedOutputPortCount?: number;
  masterChannelMode?: 'stereo' | 'mono';
  onToggleMasterChannelMode?: () => void;
  masterGain?: number;
  masterGains?: number[];
  onMasterGainChange?: (gain: number, opts?: { commit?: boolean }) => void;
  onMasterChannelGainChange?: (channel: number, gain: number, opts?: { commit?: boolean }) => void;
  onPluginsChange?: () => void;
  onMasterResizeStart?: (e: React.MouseEvent) => void;
}

export default function MixerPanel({
  mixerHeight,
  masterWidth,
  channelSources = [],
  selectedBus,
  selectedNode,
  mixerStrips = [],
  mixerChannelMode = 'stereo',
  onToggleMixerChannelMode,
  mixerTargetPortCount = 0,
  mixerSelectedChannel = 0,
  onMixerSelectedChannel,
  outputTargets = [],
  focusedOutputId = null,
  onFocusOutputId,
  focusedOutputChannel = 0,
  onFocusOutputChannel,
  focusedOutputPortCount = 0,
  masterChannelMode = 'stereo',
  onToggleMasterChannelMode,
  masterGain: masterGainProp,
  masterGains: masterGainsProp,
  onMasterGainChange,
  onMasterChannelGainChange,
  onPluginsChange,
  onMasterResizeStart,
}: Props) {
  const strips = Array.isArray(mixerStrips) ? mixerStrips : [];
  const hasMixerTarget = selectedNode?.type === 'target' || selectedNode?.type === 'bus';

  const selectedCh = Math.max(0, Number(focusedOutputChannel) || 0);
  const selectedBase = masterChannelMode === 'stereo' ? Math.floor(selectedCh / 2) * 2 : selectedCh;
  const masterPortCount = Math.max(
    0,
    Number(focusedOutputPortCount) || 0,
    Array.isArray(masterGainsProp) ? masterGainsProp.length : 0,
  );

  const masterGainsRef = React.useRef<number[]>([1.0, 1.0]);
  React.useEffect(() => {
    if (Array.isArray(masterGainsProp) && masterGainsProp.length > 0) {
      masterGainsRef.current = masterGainsProp.map((v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 1.0;
      });
    } else {
      const g = typeof masterGainProp === 'number' && Number.isFinite(masterGainProp) ? masterGainProp : 1.0;
      if (masterPortCount > 0) {
        masterGainsRef.current = Array.from({ length: masterPortCount }, () => g);
      } else {
        masterGainsRef.current = [g, g];
      }
    }
  }, [masterGainsProp, masterGainProp, masterPortCount]);

  // ---------------------------------------------------------------------------
  // Meters (canvas, v1-style): poll into refs + draw via rAF, no React re-render
  // ---------------------------------------------------------------------------

  const meterPaletteRef = React.useRef<HTMLDivElement | null>(null);
  const meterColorsRef = React.useRef<{ bg: string; green: string; yellow: string; red: string } | null>(null);

  const ensureMeterColors = React.useCallback(() => {
    if (meterColorsRef.current) return meterColorsRef.current;
    const root = meterPaletteRef.current;
    if (!root) return null;

    const pick = (name: string) => {
      const el = root.querySelector(`[data-meter-color="${name}"]`) as HTMLElement | null;
      if (!el) return '';
      return window.getComputedStyle(el).backgroundColor || '';
    };

    meterColorsRef.current = {
      bg: pick('bg'),
      green: pick('green'),
      yellow: pick('yellow'),
      red: pick('red'),
    };
    return meterColorsRef.current;
  }, []);

  const edgePeakByIdRef = React.useRef<Map<number, number>>(new Map());
  const nodeOutputPeaksByHandleRef = React.useRef<Map<number, number[]>>(new Map());
  const isFetchingMetersRef = React.useRef<boolean>(false);

  // canvas refs/cache
  const meterCanvasCache = React.useRef<
    Map<string, { ctx: CanvasRenderingContext2D; cssW: number; cssH: number; dpr: number; gradient?: CanvasGradient }>
  >(new Map());
  const meterROs = React.useRef<Map<string, ResizeObserver>>(new Map());
  const smoothedLevels = React.useRef<Map<string, number>>(new Map());

  // key -> meter source mapping
  const meterSourceRef = React.useRef<
    Map<
      string,
      | { kind: 'edge'; ids: number[]; channel: number }
      | { kind: 'node'; id: number; channel: number }
    >
  >(new Map());

  const setMeterCanvasRef = React.useCallback((el: HTMLCanvasElement | null, key: string) => {
    const existingRO = meterROs.current.get(key);
    if (!el) {
      meterCanvasCache.current.delete(key);
      if (existingRO) {
        existingRO.disconnect();
        meterROs.current.delete(key);
      }
      return;
    }

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, el.clientWidth);
      const cssH = Math.max(1, el.clientHeight);
      const backingW = Math.max(1, Math.floor(cssW * dpr));
      const backingH = Math.max(1, Math.floor(cssH * dpr));
      if (el.width !== backingW || el.height !== backingH) {
        el.width = backingW;
        el.height = backingH;
      }
      const ctx = el.getContext('2d', { alpha: true });
      if (!ctx) return;

      // Create/refresh vertical gradient (colors are taken from Tailwind tokens via computed styles)
      const colors = ensureMeterColors();
      if (!colors || !colors.green || !colors.yellow || !colors.red) {
        meterCanvasCache.current.set(key, { ctx, cssW, cssH, dpr });
        return;
      }

      const gradient = ctx.createLinearGradient(0, cssH, 0, 0);
      gradient.addColorStop(0, colors.green);
      gradient.addColorStop(0.6, colors.green);
      gradient.addColorStop(0.82, colors.yellow);
      gradient.addColorStop(1, colors.red);

      meterCanvasCache.current.set(key, { ctx, cssW, cssH, dpr, gradient });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    if (existingRO) existingRO.disconnect();
    meterROs.current.set(key, ro);
  }, [ensureMeterColors]);

  // Prime palette colors once mounted (drawing also lazily reads them).
  React.useEffect(() => {
    ensureMeterColors();
  }, [ensureMeterColors]);

  // Update which meters we need when strips/focus changes.
  React.useEffect(() => {
    const next = new Map<
      string,
      | { kind: 'edge'; ids: number[]; channel: number }
      | { kind: 'node'; id: number; channel: number }
    >();

    for (const s of strips) {
      if (!s?.id) continue;

      // Prefer explicit lane mapping when provided (lets ST show proper L/R even if only one lane is connected).
      const lane = Array.isArray((s as any).laneEdgeIds) ? (s as any).laneEdgeIds : null;
      if (lane && lane.length >= 2) {
        const laneLRaw = Array.isArray(lane[0]) ? lane[0] : [];
        const laneRRaw = Array.isArray(lane[1]) ? lane[1] : [];
        const laneLIds = laneLRaw.map(parseEdgeId).filter((n: any) => typeof n === 'number' && Number.isFinite(n));
        const laneRIds = laneRRaw.map(parseEdgeId).filter((n: any) => typeof n === 'number' && Number.isFinite(n));
        if (laneLIds.length) next.set(`${s.id}:L`, { kind: 'edge', ids: laneLIds });
        if (laneRIds.length) next.set(`${s.id}:R`, { kind: 'edge', ids: laneRIds });
        continue;
      }

      const ids = (Array.isArray(s.connectionIds) ? s.connectionIds : [])
        .map(parseEdgeId)
        .filter((n: any) => typeof n === 'number' && Number.isFinite(n));
      if (!ids.length) continue;
      next.set(`${s.id}:L`, { kind: 'edge', ids, channel: 0 });
      if (ids.length >= 2) next.set(`${s.id}:R`, { kind: 'edge', ids, channel: 1 });
    }

    const handle = parseNodeHandleFromId(focusedOutputId);
    if (handle != null) {
      // Master meters should follow selected channel/pair.
      next.set('master:L', { kind: 'node', id: handle, channel: selectedBase });
      if (masterChannelMode === 'stereo' && (masterPortCount === 0 || masterPortCount > 1)) {
        next.set('master:R', { kind: 'node', id: handle, channel: selectedBase + 1 });
      }
    }

    meterSourceRef.current = next;

    // Prune smoothing cache for keys that are no longer active.
    for (const k of smoothedLevels.current.keys()) {
      if (!next.has(k)) smoothedLevels.current.delete(k);
    }
  }, [strips, focusedOutputId, selectedBase, masterChannelMode, masterPortCount]);

  // Poll meters into refs (no setState). Use edge/node scoped APIs to keep payload small.
  React.useEffect(() => {
    let raf = 0;
    let lastFetch = 0;
    const intervalMs = 33;

    const loop = (t: number) => {
      const shouldFetch = t - lastFetch >= intervalMs && !isFetchingMetersRef.current;
      if (shouldFetch) {
        lastFetch = t;
        isFetchingMetersRef.current = true;

        const edgeIds: number[] = [];
        const nodeHandles: number[] = [];
        const sources = meterSourceRef.current;
        for (const s of sources.values()) {
          if (s.kind === 'edge') edgeIds.push(...s.ids);
          else nodeHandles.push(s.id);
        }

        const unique = (arr: number[]) => Array.from(new Set(arr)).filter((n) => Number.isFinite(n));
        const edgeIdsUniq = unique(edgeIds);
        const nodeHandlesUniq = unique(nodeHandles);

        Promise.all([
          edgeIdsUniq.length ? getEdgeMeters(edgeIdsUniq) : Promise.resolve([]),
          nodeHandlesUniq.length ? getNodeMeters(nodeHandlesUniq) : Promise.resolve([]),
        ])
          .then(([edgeMeters, nodeMeters]) => {
            // Edge meters: store peak only
            const edgeMap = new Map<number, number>();
            for (const em of edgeMeters as any[]) {
              if (em?.edge_id == null) continue;
              edgeMap.set(Number(em.edge_id), Number(em.post_gain?.peak ?? 0));
            }
            edgePeakByIdRef.current = edgeMap;

            // Node meters: store output peaks array
            const nodeMap = new Map<number, number[]>();
            for (const nm of nodeMeters as any[]) {
              if (nm?.handle == null) continue;
              // NOTE: sink/target nodes often have no `outputs` meters, so fall back to `inputs`.
              const outPeaks = Array.isArray(nm.outputs) ? nm.outputs.map((p: any) => Number(p?.peak ?? 0)) : [];
              const inPeaks = Array.isArray(nm.inputs) ? nm.inputs.map((p: any) => Number(p?.peak ?? 0)) : [];
              const peaks = outPeaks.length ? outPeaks : inPeaks;
              nodeMap.set(Number(nm.handle), peaks);
            }
            nodeOutputPeaksByHandleRef.current = nodeMap;
          })
          .catch(() => {
            // ignore
          })
          .finally(() => {
            isFetchingMetersRef.current = false;
          });
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Draw meters every frame (cheap: canvas only). Uses smoothing like v1.
  React.useEffect(() => {
    let raf = 0;
    const draw = () => {
      const colors = ensureMeterColors();
      if (!colors || !colors.bg || !colors.green || !colors.yellow || !colors.red) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const bg = colors.bg;
      const sources = meterSourceRef.current;

      for (const [key, cache] of meterCanvasCache.current.entries()) {
        const src = sources.get(key);
        if (!src) {
          const { ctx, cssW, cssH, dpr } = cache;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, cssW, cssH);
          roundRect(ctx, 0, 0, cssW, cssH, 2);
          ctx.fillStyle = bg;
          ctx.fill();
          continue;
        }

        let peak = 0;
        if (src.kind === 'edge') {
          if (src.ids.length === 1) {
            peak = edgePeakByIdRef.current.get(src.ids[0]) ?? 0;
          } else if (src.channel != null && src.channel < src.ids.length) {
            peak = edgePeakByIdRef.current.get(src.ids[src.channel]) ?? 0;
          } else {
            let maxPeak = 0;
            for (const id of src.ids) {
              const p = edgePeakByIdRef.current.get(id) ?? 0;
              if (p > maxPeak) maxPeak = p;
            }
            peak = maxPeak;
          }
        } else {
          const peaks = nodeOutputPeaksByHandleRef.current.get(src.id) ?? [];
          peak = peaks[src.channel] ?? 0;
          // Output meters should reflect post-master-gain level for the selected channel(s).
          if (key === 'master:L' || key === 'master:R') {
            const g = Number(masterGainsRef.current?.[src.channel]);
            peak *= Number.isFinite(g) ? g : 1.0;
          }
        }

        // Convert to dB (meter is -60..0dB)
        const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(0.00001, Math.abs(peak)))));
        const targetPct = dbToMeterPercent(db);
        const prev = smoothedLevels.current.get(key) ?? 0;
        const next = prev + (targetPct - prev) * 0.35;
        smoothedLevels.current.set(key, next);

        let { ctx, cssW, cssH, dpr, gradient } = cache;

        if (!gradient) {
          const g = ctx.createLinearGradient(0, cssH, 0, 0);
          g.addColorStop(0, colors.green);
          g.addColorStop(0.6, colors.green);
          g.addColorStop(0.82, colors.yellow);
          g.addColorStop(1, colors.red);
          gradient = g;
          meterCanvasCache.current.set(key, { ...cache, gradient: g });
        }

        // Set transform so drawing uses CSS pixels.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        // Background (rounded)
        roundRect(ctx, 0, 0, cssW, cssH, 2);
        ctx.fillStyle = bg;
        ctx.fill();

        // Level fill
        const h = (cssH * next) / 100;
        if (h > 0.5) {
          const y = cssH - h;
          ctx.save();
          roundRect(ctx, 0, 0, cssW, cssH, 2);
          ctx.clip();
          ctx.fillStyle = gradient || colors.green;
          ctx.fillRect(0, y, cssW, h);
          ctx.restore();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [ensureMeterColors]);

  const masterGains: number[] = Array.isArray(masterGainsProp) && masterGainsProp.length > 0
    ? masterGainsProp.map((v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 1.0;
      })
    : (() => {
        const g = typeof masterGainProp === 'number' && Number.isFinite(masterGainProp) ? masterGainProp : 1.0;
        if (masterPortCount > 0) return Array.from({ length: masterPortCount }, () => g);
        return [g, g];
      })();
  const activeMasterGain = Number(masterGains[selectedBase]);
  const activeMasterGainSafe = Number.isFinite(activeMasterGain) ? activeMasterGain : 1.0;

  const masterMuteKey = `${String(focusedOutputId || 'none')}:${masterChannelMode}:${masterChannelMode === 'stereo' ? Math.floor(selectedBase / 2) : selectedBase}`;
  const [masterMutedByKey, setMasterMutedByKey] = React.useState<Record<string, boolean>>({});
  const [masterSavedGainByKey, setMasterSavedGainByKey] = React.useState<Record<string, number>>({});
  const isMasterMuted = !!masterMutedByKey[masterMuteKey];

  const masterDb = gainToDb(activeMasterGainSafe);
  const masterLevel = dbToFader(isFinite(masterDb) ? Math.max(-100, Math.min(6, masterDb)) : -100);
  const masterDragRef = React.useRef<{ pointerId: number } | null>(null);
  const [editingMasterDb, setEditingMasterDb] = React.useState<boolean>(false);
  const [editingMasterDbText, setEditingMasterDbText] = React.useState<string>('');
  const masterEditInputRef = React.useRef<HTMLInputElement | null>(null);

  const [gainByStripId, setGainByStripId] = React.useState<Record<string, number>>({});
  const [mutedByStripId, setMutedByStripId] = React.useState<Record<string, boolean>>({});
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

  React.useEffect(() => {
    setMutedByStripId((prev) => {
      const next = { ...prev };
      for (const s of strips) {
        if (!s?.id) continue;
        if (next[s.id] == null) {
          next[s.id] = !!s.muted;
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

  const toggleStripMute = (strip: any) => {
    if (!strip?.id) return;
    const currentMuted = mutedByStripId[strip.id] ?? !!strip?.muted;
    const nextMuted = !currentMuted;

    const ids = (Array.isArray(strip.connectionIds) ? strip.connectionIds : [])
      .map(parseEdgeId)
      .filter((n: any) => typeof n === 'number' && Number.isFinite(n));
    if (ids.length === 0) return;

    setMutedByStripId((prev) => ({ ...prev, [strip.id]: nextMuted }));
    void Promise.all(ids.map((id: number) => setEdgeMuted(id, nextMuted))).catch((err: any) => {
      console.warn('[mixer] setEdgeMuted failed', err);
      setMutedByStripId((prev) => ({ ...prev, [strip.id]: currentMuted }));
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

  const updateMasterFromPointer = (trackEl: HTMLElement, clientY: number, opts?: { commit?: boolean }) => {
    const rect = trackEl.getBoundingClientRect();
    const rel = (rect.bottom - clientY) / rect.height;
    const percent = Math.max(0, Math.min(1, rel)) * 100;
    const db = faderToDb(percent);
    const gain = dbToGain(db);

    if (masterChannelMode === 'mono') {
      if (!onMasterChannelGainChange) return;
      onMasterChannelGainChange(selectedBase, gain, opts);
      return;
    }

    if (!onMasterGainChange) return;
    onMasterGainChange(gain, opts);
  };

  const toggleMasterMute = () => {
    if (!masterEnabled) return;
    if (!focusedOutputId) return;

    if (!isMasterMuted) {
      setMasterSavedGainByKey((prev) => ({ ...prev, [masterMuteKey]: activeMasterGainSafe }));
      setMasterMutedByKey((prev) => ({ ...prev, [masterMuteKey]: true }));
      if (masterChannelMode === 'mono') {
        onMasterChannelGainChange?.(selectedBase, 0, { commit: true });
      } else {
        onMasterGainChange?.(0, { commit: true });
      }
      return;
    }

    const restore = masterSavedGainByKey[masterMuteKey];
    const g = Number.isFinite(Number(restore)) ? Math.max(0, Math.min(4, Number(restore))) : 1.0;
    setMasterMutedByKey((prev) => ({ ...prev, [masterMuteKey]: false }));
    if (masterChannelMode === 'mono') {
      onMasterChannelGainChange?.(selectedBase, g, { commit: true });
    } else {
      onMasterGainChange?.(g, { commit: true });
    }
  };

  React.useEffect(() => {
    if (!editingStripId) return;
    const el = editInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingStripId]);

  React.useEffect(() => {
    if (!editingMasterDb) return;
    const el = masterEditInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingMasterDb]);

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

  const beginInlineMasterDbEdit = (currentDb: number) => {
    setEditingMasterDb(true);
    const initial = isFinite(currentDb) && currentDb > -99.5 ? String(Math.round(currentDb * 10) / 10) : '-inf';
    setEditingMasterDbText(initial);
  };

  const commitInlineMasterDbEdit = () => {
    const db = parseDbText(editingMasterDbText);
    setEditingMasterDb(false);
    if (db == null) return;
    const gain = dbToGain(db);
    if (masterChannelMode === 'mono') {
      onMasterChannelGainChange?.(selectedBase, gain, { commit: true });
    } else {
      onMasterGainChange?.(gain, { commit: true });
    }
  };

  const cancelInlineMasterDbEdit = () => {
    setEditingMasterDb(false);
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

  // Match CanvasView header semantics:
  // - Device source: title = device name, subtitle = "{N}ch Input"
  // - Prism source:  title = subLabel (app / MAIN / Empty), subtitle = label ("Ch X-Y")
  const getStripChannelLabel = (strip: any) => {
    const n = strip?.sourceNode;
    if (!n) return '—';

    const fromRaw = Array.isArray(strip?.fromChannels) ? strip.fromChannels : [];
    const fromChannels = fromRaw
      .map((v: any) => Number(v))
      .filter((v: any) => Number.isFinite(v));
    if (fromChannels.length === 0) return '—';

    // Prism sources: show absolute channel numbers using channelOffset.
    const isPrismSource = n.sourceType !== 'device' && typeof n.channelOffset === 'number' && Number.isFinite(n.channelOffset);
    const offset = isPrismSource ? Number(n.channelOffset) : 0;

    if (mixerChannelMode === 'stereo') {
      const a = offset + fromChannels[0] + 1;
      const b = offset + (fromChannels[1] ?? (fromChannels[0] + 1)) + 1;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return lo === hi ? `${lo}` : `${lo}-${hi}`;
    }

    const ch = offset + fromChannels[0] + 1;
    const side = (ch % 2 === 1) ? 'L' : 'R';
    return `${ch}${side}`;
  };

  const getStripTitle = (strip: any) => {
    const n = strip?.sourceNode;
    if (!n) return 'INPUT';

    if (typeof n.displayTitle === 'string' && n.displayTitle.trim() !== '') return n.displayTitle;

    const isDeviceNode = n.sourceType === 'device' || (typeof n.libraryId === 'string' && n.libraryId.startsWith('dev_'));
    if (isDeviceNode) {
      if (typeof n.deviceName === 'string' && n.deviceName.trim() !== '') return n.deviceName;
      if (typeof n.label === 'string' && n.label.trim() !== '') return n.label;
      return 'Device';
    }

    if (typeof n.subLabel === 'string' && n.subLabel.trim() !== '') return n.subLabel;
    if (typeof n.label === 'string' && n.label.trim() !== '') return n.label;
    if (typeof n.name === 'string' && n.name.trim() !== '') return n.name;
    return 'INPUT';
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

  const masterEnabled = masterChannelMode === 'mono' ? !!onMasterChannelGainChange : !!onMasterGainChange;
  const masterControlEnabled = masterEnabled && !isMasterMuted;

  return (
    <div className="bg-[#0f172a] border-t border-slate-800 flex shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.3)] z-30" style={{ height: mixerHeight }}>
      {/* Tailwind palette sampler for canvas gradients (no hard-coded colors) */}
      <div ref={meterPaletteRef} className="hidden" aria-hidden="true">
        <div data-meter-color="bg" className="bg-slate-950" />
        <div data-meter-color="green" className="bg-green-500" />
        <div data-meter-color="yellow" className="bg-yellow-500" />
        <div data-meter-color="red" className="bg-red-500" />
      </div>

      {/* Bus Detail Section */}
      <div className="w-64 bg-[#1a1f2e] border-r border-slate-700 flex flex-col shrink-0">
        <DetailView selectedNode={selectedNode} selectedBus={selectedBus} onPluginsChange={onPluginsChange} />
      </div>

      {/* Mixer Channels */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#162032]">
        <div className="h-8 bg-slate-900/50 border-b border-slate-800 flex items-center px-4 justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Maximize2 className="w-3 h-3 text-slate-500" />
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              {hasMixerTarget ? (
                selectedNode?.type === 'bus' ? (
                  <>
                    Mixing for
                    <span className={`text-white ml-1 ${((selectedNode as any)?.color || '')}`.trim()}>
                      {selectedBus?.label || selectedNode?.label || 'Bus'}
                    </span>
                    <span
                      className={
                        `ml-2 px-1.5 py-0.5 rounded text-[8px] ` +
                        (mixerChannelMode === 'stereo'
                          ? 'bg-cyan-500/20 text-cyan-400'
                          : 'bg-slate-600/50 text-slate-400')
                      }
                    >
                      {mixerChannelMode === 'stereo' ? 'STEREO' : 'MONO'}
                    </span>
                  </>
                ) : (
                  <>
                    Mixing for
                    <span
                      className={
                        `text-white ml-1 ` +
                        ((selectedNode as any)?.available === false || (selectedNode as any)?.disabled === true
                          ? 'text-slate-500'
                          : ((selectedNode as any)?.color || 'text-white'))
                      }
                    >
                      {selectedNode?.label || 'Output'}
                    </span>

                    {(((selectedNode as any)?.available === false) || ((selectedNode as any)?.disabled === true)) && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[8px] bg-red-500/20 text-red-400">
                        DISCONNECTED
                      </span>
                    )}

                    {!(((selectedNode as any)?.available === false) || ((selectedNode as any)?.disabled === true)) && mixerTargetPortCount > 1 && (
                      <span className="text-slate-400 ml-1">
                        {mixerChannelMode === 'stereo'
                          ? (() => {
                              const base = Math.floor(Number(mixerSelectedChannel) / 2) * 2;
                              return `Ch ${base + 1}-${base + 2}`;
                            })()
                          : `Ch ${Number(mixerSelectedChannel) + 1}`}
                      </span>
                    )}

                    {!(((selectedNode as any)?.available === false) || ((selectedNode as any)?.disabled === true)) && (
                      <span
                        className={
                          `ml-2 px-1.5 py-0.5 rounded text-[8px] ` +
                          (mixerChannelMode === 'stereo'
                            ? 'bg-cyan-500/20 text-cyan-400'
                            : 'bg-slate-600/50 text-slate-400')
                        }
                      >
                        {mixerChannelMode === 'stereo' ? 'STEREO' : 'MONO'}
                      </span>
                    )}
                  </>
                )
              ) : (
                'Select Output or Bus on Canvas to Mix'
              )}
            </span>
          </div>
        </div>
        <div className="flex-1 flex min-h-0 overflow-x-auto overflow-y-hidden p-4 gap-2 items-stretch">
          {hasMixerTarget ? (
            <>
              {/* Mixer channel selector (applies to output or bus) */}
              <div className="w-14 flex flex-col gap-1 overflow-y-auto border-r border-slate-800 pr-2 min-h-0 shrink-0">
                <div className="text-[8px] font-bold text-slate-600 mb-1 text-center shrink-0">
                  {mixerChannelMode === 'stereo' ? 'PAIR' : 'CH'}
                </div>

                <button
                  type="button"
                  disabled={mixerTargetPortCount <= 0 || typeof onToggleMixerChannelMode !== 'function'}
                  onClick={() => onToggleMixerChannelMode?.()}
                  className={
                    `w-full py-1 rounded text-[9px] font-bold border transition-colors text-center shrink-0 ` +
                    (mixerTargetPortCount <= 0 || typeof onToggleMixerChannelMode !== 'function'
                      ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-not-allowed'
                      : mixerChannelMode === 'stereo'
                        ? 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'
                        : 'border-pink-500 bg-pink-500/15 text-white')
                  }
                  aria-label="Toggle mixer stereo/mono"
                >
                  {mixerChannelMode === 'stereo' ? 'ST' : 'MONO'}
                </button>

                <div className="flex flex-col gap-1 min-h-0">
                  {(() => {
                    const pc = Math.max(0, Number(mixerTargetPortCount) | 0);
                    if (pc <= 0) return null;

                    if (mixerChannelMode === 'stereo') {
                      const selectedPairBase = Math.floor(Number(mixerSelectedChannel) / 2) * 2;
                      const rows: any[] = [];
                      for (let base = 0; base < pc; base += 2) {
                        const label = base + 1 < pc ? `${base + 1}-${base + 2}` : `${base + 1}`;
                        const isSel = base === selectedPairBase;
                        rows.push(
                          <button
                            key={`pair_${base}`}
                            type="button"
                            onClick={() => onMixerSelectedChannel?.(base)}
                            className={
                              `w-full py-1.5 rounded text-[9px] font-bold border transition-colors text-center shrink-0 ` +
                              (isSel
                                ? 'border-pink-500 bg-pink-500/15 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300')
                            }
                            aria-label={`Select channels ${label}`}
                          >
                            {label}
                          </button>
                        );
                      }
                      return rows;
                    }

                    const rows: any[] = [];
                    for (let ch = 0; ch < pc; ch++) {
                      const isSel = ch === Number(mixerSelectedChannel);
                      rows.push(
                        <button
                          key={`ch_${ch}`}
                          type="button"
                          onClick={() => onMixerSelectedChannel?.(ch)}
                          className={
                            `w-full py-1.5 rounded text-[9px] font-bold border transition-colors text-center shrink-0 ` +
                            (isSel
                              ? 'border-pink-500 bg-pink-500/15 text-white'
                              : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300')
                          }
                          aria-label={`Select channel ${ch + 1}`}
                        >
                          {ch + 1}
                        </button>
                      );
                    }
                    return rows;
                  })()}
                </div>
              </div>

              {strips.length > 0 ? (
                strips.map((strip: any) => {
              const Icon = getStripIcon(strip);
              const iconColor = getStripIconColor(strip);
              const chLabel = getStripChannelLabel(strip);
              const title = getStripTitle(strip);
              const isMuted = mutedByStripId[strip.id] ?? !!strip?.muted;
              const hasStereoMeter = mixerChannelMode === 'stereo' && Array.isArray(strip?.fromChannels) && strip.fromChannels.length >= 2;
              const gain = typeof gainByStripId[strip.id] === 'number'
                ? gainByStripId[strip.id]
                : (typeof strip.sendLevel === 'number' ? strip.sendLevel : 1.0);
              const db = gainToDb(gain);
              const displayDbText = formatDb(db);
              const dbFieldWidthCh = Math.max(4, Math.max(displayDbText.length, editingDbText.length || 0));
              const level = dbToFader(isFinite(db) ? Math.max(-100, Math.min(6, db)) : -100);
              const isEditingDb = editingStripId === strip.id;

              return (
                <div key={strip.id} className="w-32 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none min-h-0">
                  <div className="h-8 w-full flex flex-col items-center justify-center mb-1">
                    <div className="w-6 h-6 rounded-lg bg-slate-950 border border-slate-600 flex items-center justify-center shadow-lg">
                      {renderIcon(Icon, iconColor)}
                    </div>
                  </div>
                  <div className="w-full px-1 text-center mb-2">
                    <div className="text-[7px] font-mono text-slate-500">{chLabel}</div>
                    <div className="text-[9px] font-bold truncate text-slate-300">{title}</div>
                  </div>
                  <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative min-h-0">
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
                      <canvas
                        ref={(el) => setMeterCanvasRef(el as any, `${strip.id}:L`)}
                        className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 pointer-events-none"
                      />
                      {hasStereoMeter ? (
                        <canvas
                          ref={(el) => setMeterCanvasRef(el as any, `${strip.id}:R`)}
                          className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5 pointer-events-none"
                        />
                      ) : null}
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
                      <button
                        type="button"
                        className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500'}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleStripMute(strip)}
                        aria-label={isMuted ? 'Unmute' : 'Mute'}
                      >
                        M
                      </button>
                  </div>
                </div>
              );
                })
              ) : (
                <div className="flex-1 flex items-center justify-center min-w-0">
                  <div className="text-[10px] text-slate-600">No connected inputs for the selected output/bus</div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      <div
        className="w-1 bg-transparent hover:bg-amber-500/50 cursor-ew-resize z-40 shrink-0 transition-colors"
        onMouseDown={(e) => {
          if (typeof onMasterResizeStart === 'function') onMasterResizeStart(e);
        }}
      />

      {/* Master Section */}
      <div className="bg-[#111827] border-l border-slate-800 flex flex-col shrink-0 relative shadow-2xl min-h-0" style={{ width: masterWidth }}>
        <div className="p-2 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between shrink-0">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
            <Monitor className="w-3 h-3" /> Master & Monitor
          </div>
        </div>
        <div className="flex-1 flex gap-2 p-3 min-h-0">
          <div className="flex-1 flex flex-col gap-1 overflow-y-auto min-h-0">
            {Array.isArray(outputTargets) && outputTargets.length > 0 ? (
              outputTargets.map((t) => {
                const isSelected = focusedOutputId != null && t.id === focusedOutputId;
                const isDisabled = !!t.disabled;
                const Icon = t.icon || Monitor;
                const iconColor = t.iconColor || 'text-slate-500';

                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      if (!onFocusOutputId) return;
                      void onFocusOutputId(t.id);
                    }}
                    className={
                      `flex items-center gap-2 p-2 rounded-lg border transition-all shrink-0 text-left ` +
                      (isDisabled
                        ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-not-allowed'
                        : isSelected
                          ? 'border-pink-500 bg-pink-500/15'
                          : 'border-slate-700 bg-slate-800 hover:border-pink-500/50 hover:bg-slate-800/90')
                    }
                  >
                    <div className="w-5 h-5 rounded flex items-center justify-center bg-slate-950">
                      {renderIcon(Icon, iconColor)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[10px] font-bold truncate ${isSelected ? 'text-white' : 'text-slate-200'}`}>{t.label || 'Output'}</div>
                      {t.subLabel ? (
                        <div className="text-[8px] text-slate-500 truncate">{t.subLabel}</div>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="text-[10px] text-slate-600 p-2">No outputs</div>
            )}
          </div>
          <div className="w-28 bg-slate-900 border border-slate-700 rounded-lg flex flex-col items-center py-2 relative group shrink-0 select-none shadow-xl min-h-0">
            <div className="text-[8px] font-bold text-slate-500 mb-2">MASTER</div>
            <div className="flex-1 w-full px-2 flex gap-0.5 justify-center relative min-h-0">
              <div className="relative mr-2">
                <FaderScale
                  onSelectDb={(dbSel) => {
                    if (!masterControlEnabled) return;
                    const g = dbToGain(dbSel);
                    if (masterChannelMode === 'mono') {
                      onMasterChannelGainChange?.(selectedBase, g, { commit: true });
                    } else {
                      onMasterGainChange?.(g, { commit: true });
                    }
                  }}
                />
                <div
                  className={`w-2 h-full bg-slate-950 rounded-sm relative group/fader border border-slate-700 ${masterControlEnabled ? 'cursor-ns-resize' : 'cursor-default opacity-50'}`}
                  style={{ touchAction: 'none' }}
                  onPointerDown={(e: any) => {
                    if (!masterControlEnabled) return;
                    e.preventDefault();
                    masterDragRef.current = { pointerId: e.pointerId };
                    try { (e.currentTarget as any).setPointerCapture(e.pointerId); } catch {}
                    updateMasterFromPointer(e.currentTarget, e.clientY);
                  }}
                  onPointerMove={(e: any) => {
                    const d = masterDragRef.current;
                    if (!d || d.pointerId !== e.pointerId) return;
                    if (!masterControlEnabled) return;
                    updateMasterFromPointer(e.currentTarget, e.clientY);
                  }}
                  onPointerUp={(e: any) => {
                    const d = masterDragRef.current;
                    if (!d || d.pointerId !== e.pointerId) return;
                    if (!masterControlEnabled) return;
                    updateMasterFromPointer(e.currentTarget, e.clientY, { commit: true });
                    masterDragRef.current = null;
                  }}
                  onPointerCancel={() => {
                    masterDragRef.current = null;
                  }}
                >
                  <div className={`absolute left-1/2 -translate-x-1/2 w-5 h-2.5 bg-slate-600 border border-slate-400 rounded-sm shadow pointer-events-none z-10 ${isMasterMuted ? 'grayscale opacity-50' : ''}`} style={{ bottom: `calc(${masterLevel}% - 5px)` }}></div>
                </div>
              </div>
              <div className="flex gap-0.5 relative">
                <canvas
                  ref={(el) => setMeterCanvasRef(el as any, 'master:L')}
                  className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 pointer-events-none"
                />
                {masterChannelMode === 'stereo' ? (
                  <canvas
                    ref={(el) => setMeterCanvasRef(el as any, 'master:R')}
                    className="w-2 h-full rounded-sm border border-slate-800 bg-slate-950 ml-0.5 pointer-events-none"
                  />
                ) : null}
                <MeterScale />
              </div>
            </div>
            {(() => {
              const displayDbText = formatDb(masterDb);
              const dbFieldWidthCh = Math.max(4, Math.max(displayDbText.length, editingMasterDbText.length || 0));
              const isDisabled = !masterControlEnabled;

              return (
                <div className="mt-1 h-4 flex items-center justify-center">
                  {isMasterMuted ? (
                    <div className="text-[8px] font-mono text-slate-500" style={{ width: `${dbFieldWidthCh}ch` }}>MUTE</div>
                  ) : editingMasterDb ? (
                    <input
                      ref={(el) => { masterEditInputRef.current = el; }}
                      className="h-4 rounded bg-transparent border border-slate-700 text-[8px] font-mono text-slate-200 px-0 outline-none focus:border-slate-500 text-center box-border"
                      style={{ width: `${dbFieldWidthCh}ch` }}
                      value={editingMasterDbText}
                      onChange={(e) => setEditingMasterDbText(e.target.value)}
                      onBlur={() => commitInlineMasterDbEdit()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitInlineMasterDbEdit();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelInlineMasterDbEdit();
                        }
                      }}
                      aria-label="Edit master dB"
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={isDisabled}
                      className={`text-[8px] font-mono text-slate-500 text-center ${isDisabled ? 'cursor-default opacity-60' : 'hover:text-slate-200'}`}
                      style={{ width: `${dbFieldWidthCh}ch` }}
                      onClick={() => {
                        if (isDisabled) return;
                        beginInlineMasterDbEdit(masterDb);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      aria-label="Edit master dB"
                    >
                      {displayDbText}
                    </button>
                  )}
                </div>
              );
            })()}

            <div className="flex gap-1 mt-1 w-full px-2">
              <button
                type="button"
                disabled={!masterEnabled}
                className={`flex-1 h-4 rounded text-[8px] font-bold border ${isMasterMuted ? 'bg-red-500/20 border-red-500 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500'} ${!masterEnabled ? 'opacity-50 cursor-default' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleMasterMute()}
                aria-label={isMasterMuted ? 'Unmute master' : 'Mute master'}
              >
                M
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
