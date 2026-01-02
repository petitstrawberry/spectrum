import { Headphones, Speaker, Monitor, Radio, Cast, Volume2, Gamepad2, Globe, MessageSquare, Music } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function getIconForDevice(iconHint?: string | null, name?: string): LucideIcon {
  void name;
  // Use backend-provided `icon_hint` exclusively when present; do not perform
  // name-based heuristics in the UI. If `iconHint` is absent or unrecognized,
  // return a neutral generic icon.
  const hintRaw = iconHint ?? null;
  if (hintRaw) {
    const hint = String(hintRaw).toLowerCase().trim();
    // Exact token map first
    if (hint === 'music' || hint === 'main') return Music;
    if (hint === 'headphone' || hint === 'headphones' || hint === 'headset' || hint === 'headsets') return Headphones;
    if (hint === 'speaker' || hint === 'speakers') return Speaker;
    if (hint === 'airpods') return Headphones;
    if (hint === 'bluetooth' || hint === 'bt') return Headphones;
    if (hint === 'usb') return Volume2;
    if (hint === 'monitor' || hint === 'display' || hint === 'hdmi' || hint === 'displayport') return Monitor;
    if (hint === 'virtual' || hint === 'multi') return Radio;
    if (hint === 'airplay') return Cast;
    if (hint === 'cast') return Cast;

    // Substring fallback (still only using iconHint)
    if (hint.includes('headphone') || hint.includes('headphones')) return Headphones;
    if (hint.includes('speaker')) return Speaker;
    if (hint.includes('airpods')) return Headphones;
    if (hint.includes('bluetooth') || hint.includes('bt')) return Headphones;
    if (hint.includes('usb')) return Volume2;
    if (hint.includes('display') || hint.includes('hdmi') || hint.includes('displayport')) return Monitor;
    if (hint.includes('virtual') || hint.includes('multi')) return Radio;
    if (hint.includes('airplay')) return Cast;

    // Unrecognized iconHint: return neutral generic icon rather than guessing from name
    return Volume2;
  }

  // iconHint not provided — do NOT attempt name-based detection; return neutral
  return Volume2;
}

export default getIconForDevice;

export function getIconForApp(name?: string): LucideIcon {
  if (!name) return Music;
  const lower = name.toLowerCase();
  if (/valorant|minecraft|steam|game|epic|battle\.net|origin|riot|apex|fortnite/.test(lower)) return Gamepad2;
  if (/chrome|firefox|safari|edge|opera|brave|arc/.test(lower)) return Globe;
  if (/spotify|music|itunes|ableton|logic|fl studio|audacity|garageband|apple music/.test(lower)) return Music;
  if (/discord|slack|zoom|teams|facetime|skype|telegram|signal/.test(lower)) return MessageSquare;
  return Monitor;
}
