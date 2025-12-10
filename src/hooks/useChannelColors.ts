import { useMemo } from 'react';

// Category base colors (matches prism-app V1 palette)
const CATEGORY_COLORS: Record<string, [number, number, number]> = {
  game: [255, 70, 85],      // Red
  browser: [255, 200, 0],   // Amber
  music: [29, 185, 84],     // Green
  voice: [88, 101, 242],    // Blue/Purple
  system: [200, 200, 200],  // White/Gray
};

// Screen blend channel
const blendScreenChannel = (b: number, s: number) => {
  return 255 - ((255 - b) * (255 - s) / 255);
};

const mixColors = (colors: [number, number, number][]) => {
  if (!colors || colors.length === 0) return 'transparent';

  let r = 0, g = 0, b = 0;
  colors.forEach(([cr, cg, cb]) => {
    r = blendScreenChannel(r, cr);
    g = blendScreenChannel(g, cg);
    b = blendScreenChannel(b, cb);
  });

  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
};

// Simple hash-based color fallback (if app name not in CATEGORY_COLORS)
function hashColor(name: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const saturation = 65;
  const lightness = 55;

  const c = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness / 100 - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function detectCategory(name: string) {
  const lower = (name || '').toLowerCase();
  if (/valorant|minecraft|steam|game|epic|battle\.net|origin|riot|apex|legends|fortnite/i.test(lower)) return 'game';
  if (/chrome|firefox|safari|edge|opera|brave|arc/i.test(lower)) return 'browser';
  if (/spotify|music|itunes|ableton|logic|fl studio|audacity|garageband|apple music/i.test(lower)) return 'music';
  if (/discord|slack|zoom|teams|facetime|skype|telegram|signal/i.test(lower)) return 'voice';
  return 'system';
}

// channelSources: array of channel entries with `.channelOffset` and `.apps` (each app has `name` and optional `clientCount`)
export function useChannelColors(channelSources: any[]) {
  return useMemo(() => {
    const colors: Record<number, string> = {};

    // Flatten all apps for MAIN channel aggregation
    const allApps = (channelSources || []).flatMap((cs: any) => (cs.apps || []).map((a: any) => ({ name: a.name, clientCount: a.clientCount || 1 })));

    for (const cs of (channelSources || [])) {
      const chId = cs.channelOffset ?? 0;
      let routingApps: { name: string; clientCount: number }[] = [];

      if (cs.isMain) {
        routingApps = allApps.filter(a => (a.clientCount || 0) > 0);
      } else {
        routingApps = (cs.apps || []).
          map((a: any) => ({ name: a.name, clientCount: a.clientCount || 1 })).
          filter((a: { name: string; clientCount: number }) => (a.clientCount || 0) > 0);
      }

      const activeColors: [number, number, number][] = routingApps.map(a => {
        const cat = detectCategory(a.name);
        return CATEGORY_COLORS[cat] || hashColor(a.name || '');
      });

      colors[chId] = mixColors(activeColors as [number, number, number][]);
    }

    return colors;
  }, [channelSources]);
}
