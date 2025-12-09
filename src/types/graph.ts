/**
 * Graph Types for Spectrum v2
 *
 * フロントエンド用の型定義（v2 API ベース）
 */

import type { LucideIcon } from 'lucide-react';

// =============================================================================
// UI Node Types (フロントエンド用)
// =============================================================================

/**
 * UI上のノード位置と表示情報
 */
export interface UINode {
  /** バックエンドのNodeHandle */
  handle: number;
  /** ノード種別 */
  type: 'source' | 'bus' | 'sink';
  /** 表示ラベル */
  label: string;
  /** サブラベル（チャンネル情報など） */
  subLabel?: string;
  /** アイコン */
  icon: LucideIcon;
  /** 色クラス */
  color: string;
  /** キャンバス上のX座標 */
  x: number;
  /** キャンバス上のY座標 */
  y: number;
  /** ポート数 */
  portCount: number;

  // Source固有
  sourceType?: 'prism' | 'device';
  deviceId?: number;
  channel?: number;

  // Sink固有
  sinkDeviceId?: number;
  channelOffset?: number;

  // Bus固有
  busId?: string;
  plugins?: PluginInstance[];
}

/** Helper: get position object from UINode */
export function getNodePosition(node: UINode): { x: number; y: number } {
  return { x: node.x, y: node.y };
}

/** Helper: get input port indices (buses and sinks have inputs) */
export function getInputPorts(node: UINode): number[] {
  if (node.type === 'source') return [];
  return Array.from({ length: node.portCount }, (_, i) => i);
}

/** Helper: get output port indices (sources and buses have outputs) */
export function getOutputPorts(node: UINode): number[] {
  if (node.type === 'sink') return [];
  return Array.from({ length: node.portCount }, (_, i) => i);
}

/**
 * UI上のエッジ（接続線）
 */
export interface UIEdge {
  /** バックエンドのEdgeId */
  id: number;
  /** ソースノードHandle */
  sourceHandle: number;
  /** ソースポート（0-based） */
  sourcePort: number;
  /** ターゲットノードHandle */
  targetHandle: number;
  /** ターゲットポート（0-based） */
  targetPort: number;
  /** ゲイン（リニア） */
  gain: number;
  /** ミュート */
  muted: boolean;
}

/**
 * プラグインインスタンス
 */
export interface PluginInstance {
  instanceId: string;
  pluginId: string;
  name: string;
  enabled: boolean;
}

// =============================================================================
// Graph State
// =============================================================================

export interface GraphState {
  nodes: Map<number, UINode>;
  edges: Map<number, UIEdge>;
  /** 処理順序 */
  processingOrder: number[];
}

// =============================================================================
// Selection State
// =============================================================================

export interface SelectionState {
  selectedNodeHandle: number | null;
  selectedEdgeId: number | null;
  focusedSinkHandle: number | null;
}

// =============================================================================
// UI State (for persistence)
// =============================================================================

export interface UIState {
  nodePositions: Record<number, { x: number; y: number }>;
  canvasTransform: { x: number; y: number; scale: number };
  panelSizes: {
    leftSidebar: number;
    rightSidebar: number;
    mixerHeight: number;
    masterWidth: number;
  };
}
