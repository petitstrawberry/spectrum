// @ts-nocheck
import { Workflow } from 'lucide-react';
import type { UINode } from '../../types/graph';
import type { BusInfo } from './types';

function channelTextToHeaderBg(textClass: string | undefined): string {
  // Keep this mapping explicit so Tailwind can see all classes.
  switch (textClass) {
    // Main 3 patterns
    case 'text-cyan-400': return 'bg-cyan-500/20';
    case 'text-cyan-500': return 'bg-cyan-500/20';
    case 'text-pink-400': return 'bg-pink-500/20';
    case 'text-pink-500': return 'bg-pink-500/20';
    // Bus: match RightPanel active bus background.
    case 'text-purple-400': return 'bg-purple-500/20';
    case 'text-purple-500': return 'bg-purple-500/20';
    // Extra fallbacks (in case upstream starts emitting different hues)
    case 'text-amber-400': return 'bg-amber-500/20';
    case 'text-amber-500': return 'bg-amber-500/20';
    case 'text-fuchsia-400': return 'bg-fuchsia-500/20';
    case 'text-fuchsia-500': return 'bg-fuchsia-500/20';
    case 'text-violet-400': return 'bg-violet-500/20';
    case 'text-indigo-400': return 'bg-indigo-500/20';
    case 'text-blue-400': return 'bg-blue-500/20';
    case 'text-teal-400': return 'bg-teal-500/20';
    case 'text-emerald-400': return 'bg-emerald-500/20';
    case 'text-lime-400': return 'bg-lime-500/20';
    case 'text-yellow-400': return 'bg-yellow-500/20';
    case 'text-green-400': return 'bg-green-500/20';
    default: return 'bg-slate-900/30';
  }
}

function getChannelTextClass(node: any): string {
  const type = node?.type;
  if (type === 'bus') return 'text-purple-400';
  // v2 graph uses 'sink', Canvas nodes use 'target' for outputs
  if (type === 'sink' || type === 'target') return 'text-pink-400';
  if (type === 'source') {
    const isDevice = node?.sourceType === 'device' || (typeof node?.libraryId === 'string' && node.libraryId.startsWith('dev_'));
    return isDevice ? 'text-amber-400' : 'text-cyan-400';
  }
  // Fallback: if upstream provides a valid tailwind text color, keep it.
  if (typeof node?.color === 'string' && node.color.startsWith('text-')) return node.color;
  return 'text-slate-500';
}

export function getDetailHeaderInfo(
  selectedNode?: UINode | null,
  selectedBus?: BusInfo | null
): {
  title: string;
  rightText?: string;
  icon?: any;
  bgClass: string;
  barClass: string;
  iconClass: string;
} {
  if (!selectedNode) {
    return {
      title: 'Detail',
      icon: undefined,
      bgClass: 'bg-slate-900/30',
      barClass: 'text-slate-500',
      iconClass: 'text-slate-500',
    };
  }

  // Prism nodes: use app name as title (subLabel), not channel label like "Ch 3-4".
  // getPrismChannelDisplay returns label="Ch X-Y" and subLabel="<App>".
  const isPrismSource = selectedNode.type === 'source' && selectedNode.sourceType && selectedNode.sourceType !== 'device';
  const title = (isPrismSource && selectedNode.subLabel && selectedNode.subLabel !== 'Empty')
    ? selectedNode.subLabel
    : (selectedNode.label || 'Detail');

  const rightText = selectedNode.channelCount ? `${selectedNode.channelCount}ch` : undefined;

  // Prefer node-provided display info (keeps consistent with CanvasView / useGraph output).
  // Fallbacks cover edge cases where a node doesn't have icon/iconColor yet.
  const icon = selectedNode.icon || (selectedNode.type === 'bus' ? Workflow : undefined);

  // Accent bar uses channel-level color (prism/device/output/bus).
  const channelTextClass = getChannelTextClass(selectedNode);
  const barClass = channelTextClass;

  // Background is a fixed neutral tint for consistency/readability.
  const bgClass = 'bg-slate-900/30';

  // Icon uses the node's actual/icon color when present (rgb or Tailwind), otherwise fall back to channel color.
  let iconClass = (selectedNode as any).iconColor || channelTextClass;

  if (!iconClass || iconClass === 'text-slate-500') iconClass = channelTextClass;

  // For bus, title/icon/color should still match the node; selectedBus is only used by bus subviews.
  void selectedBus;

  return { title, rightText, icon, bgClass, barClass, iconClass };
}
