/** Recognises values worth previewing: colors, images, links, dates, JWTs and JSON inside strings. */

import type { TypeName } from '../core/data/tree';

export type ValueHint =
  | { kind: 'color'; css: string }
  | { kind: 'image'; url: string }
  | { kind: 'link'; url: string }
  | { kind: 'email'; address: string }
  | { kind: 'date'; ms: number; from: 'iso' | 'seconds' | 'millis' }
  | { kind: 'jwt'; header: Record<string, unknown>; payload: Record<string, unknown> }
  | { kind: 'json'; value: unknown };

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgba?|hsla?)\(\s*-?[\d.]+(?:deg|turn|rad|%)?\s*(?:[,\s]\s*-?[\d.]+%?\s*){2}(?:[,/]\s*[\d.]+%?\s*)?\)$/i;
const COLOR_KEY = /colou?r|background|^bg|fill|stroke|tint|shade|accent|foreground|^fg/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:[?#]\S*)?$/i;
const IMAGE_KEY = /image|img|avatar|photo|picture|thumb|logo|icon|banner|cover|poster/i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;
const URL_RE = /^(?:https?|ftp):\/\/[^\s/$.?#][^\s]*$/i;
const EMAIL = /^[^\s@"<>]+@[^\s@"<>]+\.[a-z]{2,}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const TIME_KEY = /time|date|_at$|[a-z]At$|^ts$|stamp|created|updated|modified|expir|^exp$|^iat$|^nbf$|since|until|birth|deadline|seen|login/i;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

/** CSS color for a color-like string (`#7c8cff`, `rgb(…)`, `hsl(…)`), or null. */
export function colorOf(text: string, key?: string | number | null): string | null {
  if (text.length > 48) return null;
  const t = text.trim();
  if (t[0] === '#') {
    if (!HEX.test(t)) return null;
    // `#123` is as likely an issue number as a color: digits-only short forms need a hint.
    if (t.length <= 5 && !/[a-f]/i.test(t) && !(typeof key === 'string' && COLOR_KEY.test(key))) return null;
    return t;
  }
  return COLOR_FN.test(t) ? t : null;
}

/** Everything worth showing about a value beyond its text. `text` is the full (decoded) value. */
export function valueHints(type: TypeName, text: string, key?: string | number | null): ValueHint[] {
  const hints: ValueHint[] = [];
  const k = typeof key === 'string' ? key : '';
  if (type === 'number') {
    const n = Number(text);
    if (Number.isInteger(n) && TIME_KEY.test(k)) {
      if (n >= 1e8 && n < 1e10) hints.push({ kind: 'date', ms: n * 1000, from: 'seconds' });
      else if (n >= 1e11 && n < 1e13) hints.push({ kind: 'date', ms: n, from: 'millis' });
    }
    return hints;
  }
  if (type !== 'string' || !text) return hints;
  const t = text.trim();
  const color = colorOf(t, key);
  if (color) return [{ kind: 'color', css: color }];
  if (DATA_IMAGE.test(t)) return [{ kind: 'image', url: t.replace(/\s+/g, '') }];
  if (URL_RE.test(t) && isUrl(t)) {
    if (IMAGE_EXT.test(new URL(t).pathname) || IMAGE_KEY.test(k)) hints.push({ kind: 'image', url: t });
    hints.push({ kind: 'link', url: t });
    return hints;
  }
  if (EMAIL.test(t)) return [{ kind: 'email', address: t }];
  if (ISO_DATE.test(t)) {
    const ms = Date.parse(t.length > 10 ? t.replace(' ', 'T') : t);
    if (!Number.isNaN(ms)) return [{ kind: 'date', ms, from: 'iso' }];
  }
  if (JWT.test(t)) {
    const [h, p] = t.split('.');
    const header = decodeSegment(h);
    const payload = decodeSegment(p);
    if (header && payload && ('alg' in header || 'typ' in header)) return [{ kind: 'jwt', header, payload }];
  }
  if ((t[0] === '{' && t.endsWith('}')) || (t[0] === '[' && t.endsWith(']'))) {
    if (t.length <= 4_000_000) {
      try {
        const value: unknown = JSON.parse(t);
        if (value && typeof value === 'object') hints.push({ kind: 'json', value });
      } catch {
        // Not JSON after all.
      }
    }
  }
  return hints;
}

function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (seg.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** "3 days ago" / "in 2 hours". */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_557_600_000],
    ['month', 2_629_800_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (abs >= size) return fmt.format(Math.round(diff / size), unit);
  return fmt.format(Math.round(diff / 1000), 'second');
}

/** `#rgb[a]` / `#rrggbb[aa]` → [r, g, b, a] (a in 0..1), or null for other notations. */
export function hexToRgba(hex: string): [number, number, number, number] | null {
  if (!HEX.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}
