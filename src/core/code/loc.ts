/** Line counting shared by grammar-backed and fallback outlines. */

import type { LanguageSpec } from './spec';

export function countLines(text: string, spec?: Pick<LanguageSpec, 'lineComment' | 'blockComment'>): { lines: number; loc: number } {
  let lines = 0;
  let loc = 0;
  let inBlock = false;
  const lc = spec?.lineComment ?? [];
  const [bs, be] = spec?.blockComment ?? ['', ''];
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    lines++;
    if (!line) continue;
    if (inBlock) {
      if (be && line.includes(be)) inBlock = false;
      continue;
    }
    if (bs && line.startsWith(bs)) {
      if (!line.includes(be, bs.length)) inBlock = true;
      continue;
    }
    if (lc.some((p) => line.startsWith(p))) continue;
    loc++;
  }
  if (text.endsWith('\n')) lines--;
  return { lines: Math.max(lines, 0), loc };
}
