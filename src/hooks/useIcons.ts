import { Headphones, Speaker, Monitor, Radio, Cast, Video, Volume2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function getIconForDevice(iconHint?: string | null, name?: string): LucideIcon {
  const hint = (iconHint || '').toLowerCase();
  if (hint.includes('headphone') || hint.includes('headphones')) return Headphones;
  if (hint.includes('speaker')) return Speaker;
  if (hint.includes('airpods')) return Headphones;
  if (hint.includes('bluetooth') || hint.includes('bt')) return Headphones;
  if (hint.includes('usb')) return Volume2;
  if (hint.includes('display') || hint.includes('hdmi') || hint.includes('displayport')) return Monitor;
  if (hint.includes('aggregate') || hint.includes('virtual') || hint.includes('multi') || hint.includes('blackhole')) return Radio;
  if (hint.includes('airplay')) return Cast;

  // Fallback to name-based heuristics
  const lower = (name || '').toLowerCase();
  if (lower.includes('headphone') || lower.includes('airpods')) return Headphones;
  if (lower.includes('speaker') || lower.includes('built-in')) return Speaker;
  if (lower.includes('monitor') || lower.includes('display')) return Monitor;
  if (lower.includes('blackhole') || lower.includes('virtual')) return Radio;
  if (lower.includes('airplay')) return Cast;
  if (lower.includes('obs') || lower.includes('stream')) return Video;

  return Volume2;
}

export default getIconForDevice;
