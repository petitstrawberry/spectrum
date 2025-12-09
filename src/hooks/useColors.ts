// Helper: map device names/icon hints to Tailwind color classes (match v1 heuristics)
export default function getColorForDevice(name?: string, iconHint?: string): string {
  const lower = (name || iconHint || '').toLowerCase();
  if (!lower) return 'text-slate-400';
  if (lower.includes('prism')) return 'text-cyan-400';
  if (lower.includes('virtual') || lower.includes('blackhole') || lower.includes('loopback') || lower.includes('soundflower')) return 'text-pink-400';
  if (lower.includes('built-in') || lower.includes('builtin') || lower.includes('internal') || lower.includes('macbook')) return 'text-green-400';
  return 'text-amber-400';
}
