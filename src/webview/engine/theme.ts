/**
 * Canvas palette resolved from CSS custom properties, so the canvas always
 * matches the surrounding UI (and the active VS Code theme).
 */

import type { ColorName } from './scene';

export interface Palette {
  bg: string;
  card: string;
  cardHover: string;
  header: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  edge: string;
  edgeHi: string;
  selection: string;
  match: string;
  shadow: string;
  dark: boolean;
  colors: Record<ColorName, string>;
  monoFont: string;
  uiFont: string;
}

const COLOR_VARS: Record<ColorName, string> = {
  accent: '--accent', muted: '--text-muted', faint: '--text-faint', text: '--text', key: '--t-key',
  string: '--t-string', number: '--t-number', boolean: '--t-boolean', null: '--t-null', object: '--t-object', array: '--t-array',
  class: '--k-class', function: '--k-function', method: '--k-method', interface: '--k-interface', variable: '--k-variable',
  module: '--k-module', type: '--k-type', enum: '--k-enum', field: '--k-field',
  decision: '--f-decision', loop: '--f-loop', return: '--f-return', throw: '--f-throw', start: '--f-start', jump: '--f-jump',
  try: '--f-try', block: '--f-block', param: '--d-param', local: '--d-local', call: '--d-call', external: '--d-external',
  danger: '--danger', warn: '--warn', ok: '--ok', dir: '--r-dir', file: '--r-file',
};

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = v('--canvas-bg', '#0b0e14');
  const colors = {} as Record<ColorName, string>;
  for (const [k, name] of Object.entries(COLOR_VARS)) colors[k as ColorName] = v(name, '#888');
  return {
    bg,
    card: v('--card', '#141922'),
    cardHover: v('--card-hover', '#1a202b'),
    header: v('--card-header', '#181e29'),
    border: v('--card-border', '#262e3b'),
    borderStrong: v('--border-strong', '#36404f'),
    text: v('--text', '#e6e9ef'),
    muted: v('--text-muted', '#8b93a3'),
    faint: v('--text-faint', '#5c6576'),
    edge: v('--edge', '#3a4456'),
    edgeHi: v('--accent', '#7c8cff'),
    selection: v('--focus', '#8ea0ff'),
    match: v('--match', '#ffcf5c'),
    shadow: v('--card-shadow', 'rgba(0,0,0,0.35)'),
    dark: luminance(bg) < 0.4,
    colors,
    monoFont: v('--font-mono', 'Consolas, monospace'),
    uiFont: v('--font-ui', 'system-ui, sans-serif'),
  };
}

export function resolveColor(p: Palette, c: ColorName | string | undefined, fallback = p.muted): string {
  if (!c) return fallback;
  return (p.colors as Record<string, string>)[c] ?? c;
}

/** `#rrggbb` / `rgb()` → rgba with alpha. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

function luminance(color: string): number {
  const rgba = withAlpha(color, 1);
  const m = /rgba\(([^)]+)\)/.exec(rgba);
  if (!m) return 0;
  const [r, g, b] = m[1].split(',').map((s) => parseFloat(s) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
