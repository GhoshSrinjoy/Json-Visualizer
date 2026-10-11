/** Pure helpers over code outlines (safe to use in the browser: no parser dependency). */

import { CALLABLE_KINDS, type CodeSymbol } from './model';

/** Pseudo-symbol for a file's top-level statements (scripts). */
export const MODULE_SYMBOL = '<module>';

export function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const visit = (s: CodeSymbol) => {
    out.push(s);
    s.children?.forEach(visit);
  };
  symbols.forEach(visit);
  return out;
}

export function findById(symbols: CodeSymbol[], id: string): CodeSymbol | undefined {
  return flattenSymbols(symbols).find((s) => s.id === id);
}

/** Innermost callable whose range contains `line`. */
export function findAtLine(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const s of flattenSymbols(symbols)) {
    if (!CALLABLE_KINDS.has(s.kind) || !s.hasBody) continue;
    if (s.range.start.line <= line && line <= s.range.end.line) {
      if (!best || s.range.start.line >= best.range.start.line) best = s;
    }
  }
  return best;
}

/** Callables matching a user-supplied name (`load`, `User.load`, `loadUsers`), best match first. */
export function findByName(symbols: CodeSymbol[], name: string): CodeSymbol[] {
  const all = flattenSymbols(symbols).filter((s) => CALLABLE_KINDS.has(s.kind));
  const lower = name.toLowerCase();
  const score = (s: CodeSymbol) =>
    s.id === name ? 0 : s.name === name ? 1 : s.id.toLowerCase() === lower ? 2 : s.name.toLowerCase() === lower ? 3 : s.id.toLowerCase().endsWith('.' + lower) ? 4 : s.name.toLowerCase().includes(lower) ? 5 : 9;
  return all.filter((s) => score(s) < 9).sort((a, b) => score(a) - score(b));
}
