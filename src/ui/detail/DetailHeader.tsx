// @ts-nocheck
import React from 'react';

export default function DetailHeader({
  icon: Icon,
  title,
  rightText,
  bgClass,
  barClass,
  iconClass,
}: {
  icon?: any;
  title: string;
  rightText?: string;
  bgClass?: string;
  barClass?: string;
  iconClass?: string;
}) {
  const bg = bgClass || 'bg-slate-900/30';
  const bar = barClass || 'text-slate-500';
  const iconColor = iconClass || 'text-slate-500';
  const isCssColor = typeof iconColor === 'string' && (
    iconColor.startsWith('rgb') ||
    iconColor.startsWith('#') ||
    iconColor.startsWith('hsl')
  );

  return (
    <div className={`h-8 ${bg} border-b border-slate-700/50 flex items-center px-3 justify-between shrink-0`}>
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-1.5 h-3 rounded-sm bg-current ${bar}`} />
        {Icon ? (
          isCssColor
            ? <Icon className="w-3 h-3" style={{ color: iconColor }} />
            : <Icon className={`w-3 h-3 ${iconColor}`} />
        ) : null}
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest truncate">
          {title}
        </span>
      </div>
      {rightText ? <span className="text-[9px] text-slate-500">{rightText}</span> : null}
    </div>
  );
}
