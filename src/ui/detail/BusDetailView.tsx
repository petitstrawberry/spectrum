// @ts-nocheck
import React from 'react';
import EffectChainView from './EffectChainView';
import type { BusInfo } from './types';

export default function BusDetailView({ bus, onPluginsChange }: { bus: BusInfo; onPluginsChange?: () => void }) {
  return <EffectChainView bus={bus} onPluginsChange={onPluginsChange} />;
}
