/**
 * useNodeDisplay - 共通のノード表示情報決定ロジック
 *
 * LeftSidebar, CanvasView, その他のUIコンポーネントで
 * 統一されたノード表示を提供する
 */

import type { LucideIcon } from 'lucide-react';
import { Volume2, Music, Mic, Headphones, Speaker, Monitor, Radio, Cast, Video, Workflow } from 'lucide-react';
import { getIconForApp, getIconForDevice } from './useIcons';
import { getColorForDevice } from './useColors';

// =============================================================================
// Types
// =============================================================================

/** チャンネルソース情報（Prism） */
export interface ChannelSourceInfo {
  id: string;
  channelOffset: number;
  channelLabel: string;
  apps: Array<{ name: string; icon?: LucideIcon; color?: string; pid?: number; clientCount?: number }>;
  hasApps: boolean;
  isMain: boolean;
}

/** デバイス情報 */
export interface DeviceInfo {
  deviceId: number;
  name: string;
  channelCount: number;
  iconHint?: string;
}

/** ノード表示情報 */
export interface NodeDisplayInfo {
  label: string;
  subLabel: string;
  icon: LucideIcon;
  iconColor: string;
}

// =============================================================================
// Prism Channel Display
// =============================================================================

/**
 * Prismチャンネルの表示情報を取得
 * @param channel チャンネルソース情報
 * @param channelColor useChannelColorsから取得した色（オプション）
 */
export function getPrismChannelDisplay(
  channel: ChannelSourceInfo,
  channelColor?: string
): NodeDisplayInfo {
  const label = `Ch ${channel.channelLabel}`;

  if (channel.isMain) {
    return {
      label,
      subLabel: 'MAIN',
      icon: Volume2,
      iconColor: 'text-cyan-400',
    };
  }

  if (channel.hasApps && channel.apps.length > 0) {
    const firstApp = channel.apps[0];
    return {
      label,
      subLabel: firstApp.name,
      icon: firstApp.icon || getIconForApp(firstApp.name) || Music,
      iconColor: channelColor || firstApp.color || 'text-cyan-400',
    };
  }

  return {
    label,
    subLabel: 'Empty',
    icon: Music,
    iconColor: 'text-slate-500',
  };
}

// =============================================================================
// Input Device Display
// =============================================================================

/**
 * 入力デバイスの表示情報を取得
 */
export function getInputDeviceDisplay(device: DeviceInfo): NodeDisplayInfo {
  return {
    label: device.name,
    subLabel: `${device.channelCount}ch`,
    icon: device.iconHint ? getIconForDevice(device.iconHint, device.name) : Mic,
    iconColor: 'text-amber-400',
  };
}

// =============================================================================
// Output/Sink Device Display
// =============================================================================

/**
 * 出力デバイス（Sink）の表示情報を取得
 */
export function getSinkDeviceDisplay(name: string, channelCount: number): NodeDisplayInfo {
  const lower = name.toLowerCase();

  let icon: LucideIcon = Volume2;
  let iconColor = 'text-amber-400';

  // アイコン決定
  if (lower.includes('headphone') || lower.includes('airpods')) {
    icon = Headphones;
  } else if (lower.includes('speaker') || lower.includes('built-in')) {
    icon = Speaker;
  } else if (lower.includes('monitor') || lower.includes('display')) {
    icon = Monitor;
  } else if (lower.includes('blackhole') || lower.includes('virtual')) {
    icon = Radio;
  } else if (lower.includes('airplay')) {
    icon = Cast;
  } else if (lower.includes('obs') || lower.includes('stream')) {
    icon = Video;
  }

  // 色決定
  if (lower.includes('prism')) {
    iconColor = 'text-cyan-400';
  } else if (lower.includes('virtual') || lower.includes('blackhole')) {
    iconColor = 'text-pink-400';
  } else if (lower.includes('built-in')) {
    iconColor = 'text-green-400';
  }

  return {
    label: name,
    subLabel: `${channelCount}ch`,
    icon,
    iconColor,
  };
}

// =============================================================================
// Bus Display
// =============================================================================

const BUS_COLORS = [
  'text-purple-400',
  'text-violet-400',
  'text-indigo-400',
  'text-blue-400',
  'text-teal-400',
  'text-emerald-400',
  'text-lime-400',
  'text-yellow-400',
];

/**
 * Busノードの表示情報を取得
 */
export function getBusDisplay(busId: string, channelCount: number, pluginCount: number = 0): NodeDisplayInfo {
  const busNum = parseInt(busId.replace('bus_', ''), 10) || 1;
  const colorIndex = (busNum - 1) % BUS_COLORS.length;

  return {
    label: `Bus ${busNum}`,
    subLabel: `${channelCount}ch • ${pluginCount} FX`,
    icon: Workflow,
    iconColor: BUS_COLORS[colorIndex],
  };
}

/**
 * Bus番号から色を取得
 */
export function getBusColor(busNum: number): string {
  const colorIndex = (busNum - 1) % BUS_COLORS.length;
  return BUS_COLORS[colorIndex];
}

// =============================================================================
// Virtual Output Display
// =============================================================================

/**
 * 仮想出力（RightPanelで表示されるもの）の表示情報を取得
 */
export function getVirtualOutputDisplay(
  name: string,
  channelCount: number,
  iconHint?: string
): NodeDisplayInfo {
  const icon = iconHint ? getIconForDevice(iconHint, name) : Monitor;
  const iconColor = getColorForDevice(name, iconHint);

  return {
    label: name,
    subLabel: `${channelCount}ch Output`,
    icon,
    iconColor,
  };
}

// =============================================================================
// Port Display Utilities
// =============================================================================

export interface PortInfo {
  index: number;
  label: string;
  isInput: boolean;
  isOutput: boolean;
}

export interface NodePortConfig {
  type: 'source' | 'bus' | 'sink' | 'target';
  portCount: number;
  channelOffset?: number;
  sourceType?: 'prism' | 'prism-channel' | 'device';
}

/**
 * ノードのポート情報を取得
 */
export function getNodePorts(config: NodePortConfig): PortInfo[] {
  const { type, portCount, channelOffset, sourceType } = config;
  const ports: PortInfo[] = [];

  for (let i = 0; i < portCount; i++) {
    // ポートラベルの決定
    let label: string;
    if ((type === 'source' && sourceType !== 'device') && typeof channelOffset === 'number') {
      // Prismソース: 絶対チャンネル番号を表示
      label = `CH ${channelOffset + i + 1}`;
    } else {
      // その他: 相対チャンネル番号を表示
      label = `CH ${i + 1}`;
    }

    // 入出力の決定
    const isInput = type === 'sink' || type === 'target' || type === 'bus';
    const isOutput = type === 'source' || type === 'bus';

    ports.push({ index: i, label, isInput, isOutput });
  }

  return ports;
}

/**
 * ポートラベルを取得（単一ポート用）
 */
export function getPortLabel(
  portIndex: number,
  channelOffset?: number,
  isPrism: boolean = false
): string {
  if (isPrism && typeof channelOffset === 'number') {
    return `CH ${channelOffset + portIndex + 1}`;
  }
  return `CH ${portIndex + 1}`;
}
