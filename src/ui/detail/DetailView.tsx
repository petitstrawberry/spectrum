// @ts-nocheck
import React from 'react';
import DetailHeader from './DetailHeader';
import BusDetailView from './BusDetailView';
import { getDetailHeaderInfo } from './getDetailHeaderInfo';
import type { UINode } from '../../types/graph';
import type { BusInfo } from './types';

export default function DetailView({
  selectedNode,
  selectedBus,
  onPluginsChange,
}: {
  selectedNode?: UINode | null;
  selectedBus?: BusInfo | null;
  onPluginsChange?: () => void;
}) {
  const isBus = selectedNode?.type === 'bus';
  const header = getDetailHeaderInfo(selectedNode, selectedBus);

  return (
    <div className="flex flex-col h-full">
      <DetailHeader
        icon={header.icon}
        title={header.title}
        rightText={header.rightText}
        bgClass={header.bgClass}
        barClass={header.barClass}
        iconClass={header.iconClass}
      />

      {!selectedNode ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-slate-600">
            <div className="text-[10px]">Select a node to view details</div>
          </div>
        </div>
      ) : isBus ? (
        selectedBus ? (
          <BusDetailView bus={selectedBus} onPluginsChange={onPluginsChange} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-slate-600">
              <div className="text-[10px]">Select a bus to view details</div>
            </div>
          </div>
        )
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {selectedNode.subLabel ? <div className="text-[9px] text-slate-500 mb-2">{selectedNode.subLabel}</div> : null}
          <div className="text-[10px] text-slate-600">
            {selectedNode.type === 'source'
              ? 'No input controls here yet'
              : selectedNode.type === 'target'
                ? 'No output controls here yet'
                : 'No details available'}
          </div>
        </div>
      )}
    </div>
  );
}
