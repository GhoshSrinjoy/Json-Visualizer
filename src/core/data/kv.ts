/** Line-oriented key/value formats: INI (and .editorconfig/.gitconfig), .env, .properties. */

import { cellType } from './csv';
import { DataTree, F_ESCAPED, F_VAL_SYNTH, T_OBJECT, T_STRING, TreeBuilder } from './tree';

export type KeyValueFormat = 'ini' | 'env' | 'properties';

export function parseKeyValue(text: string, format: KeyValueFormat): DataTree {
  const started = now();
  const tree = format === 'ini' ? parseIni(text) : format === 'env' ? parseEnv(text) : parseProperties(text);
  tree.parseMs = now() - started;
  return tree;
}

interface Line {
  start: number;
  end: number; // excludes the newline
}

function* lines(text: string): Generator<Line> {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let e = end;
    if (e > pos && text.charCodeAt(e - 1) === 13) e--;
    yield { start: pos, end: e };
    pos = end + 1;
  }
}

function skipSpace(text: string, i: number, end: number): number {
  while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

function trimRight(text: string, start: number, end: number): number {
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return end;
}

/** Adds a typed leaf for an unquoted value; quoted values become strings. */
function addValue(b: TreeBuilder, keyPos: number, keyEnd: number, vs: number, ve: number, text: string): void {
  const c = text[vs];
  if ((c === '"' || c === "'") && ve - vs >= 2 && text[ve - 1] === c) {
    const id = b.leaf(T_STRING, F_ESCAPED, keyPos, keyEnd, vs, ve);
    b.setValue(id, c === '"' ? unescapeDouble(text.slice(vs + 1, ve - 1)) : text.slice(vs + 1, ve - 1));
    return;
  }
  b.leaf(cellType(text, vs, ve), 0, keyPos, keyEnd, vs, ve);
}

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\$])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch));
}

function parseIni(text: string): DataTree {
  const b = new TreeBuilder(text, 'ini', 256);
  b.open(T_OBJECT, 0, 0, 0, 0);
  let inSection = false;
  for (const { start, end } of lines(text)) {
    const i = skipSpace(text, start, end);
    if (i >= end) continue;
    const c = text[i];
    if (c === ';' || c === '#') continue;
    if (c === '[') {
      const close = text.indexOf(']', i);
      if (close < 0 || close > end) {
        b.error(i, 'Unterminated section header');
        continue;
      }
      if (inSection) b.close(start > 0 ? start - 1 : 0);
      const ks = skipSpace(text, i + 1, close);
      const ke = trimRight(text, ks, close);
      b.open(T_OBJECT, 0, ks, ke, i);
      inSection = true;
      continue;
    }
    let sep = -1;
    for (let j = i; j < end; j++) {
      if (text[j] === '=' || text[j] === ':') {
        sep = j;
        break;
      }
    }
    if (sep < 0) {
      // Bare key (e.g. a flag in .gitconfig-style files).
      const ke = trimRight(text, i, end);
      const id = b.leaf(T_STRING, F_VAL_SYNTH, i, ke, ke, ke);
      b.setValue(id, '');
      continue;
    }
    const ke = trimRight(text, i, sep);
    const vs = skipSpace(text, sep + 1, end);
    let ve = trimRight(text, vs, end);
    // Strip inline comments that follow whitespace.
    const m = /\s[;#]/.exec(text.slice(vs, ve));
    if (m && !/^["']/.test(text[vs])) ve = trimRight(text, vs, vs + m.index);
    addValue(b, i, ke, vs, ve, text);
  }
  return b.finish();
}

function parseEnv(text: string): DataTree {
  const b = new TreeBuilder(text, 'env', 128);
  b.open(T_OBJECT, 0, 0, 0, 0);
  const all = [...lines(text)];
  for (let li = 0; li < all.length; li++) {
    const { start, end } = all[li];
    let i = skipSpace(text, start, end);
    if (i >= end || text[i] === '#') continue;
    if (text.startsWith('export ', i)) i = skipSpace(text, i + 7, end);
    const eq = text.indexOf('=', i);
    if (eq < 0 || eq > end) {
      b.error(i, 'Expected KEY=value');
      continue;
    }
    const ke = trimRight(text, i, eq);
    const vs = skipSpace(text, eq + 1, end);
    let ve = trimRight(text, vs, end);
    const q = text[vs];
    if (q === '"' || q === "'" || q === '`') {
      // Quoted values may span lines.
      let close = text.indexOf(q, vs + 1);
      while (q === '"' && close > 0 && text[close - 1] === '\\') close = text.indexOf(q, close + 1);
      if (close < 0) {
        b.error(vs, 'Unterminated quoted value');
        close = end - 1;
      }
      ve = close + 1;
      while (li + 1 < all.length && all[li].end < ve) li++;
    } else {
      const hash = text.slice(vs, ve).search(/\s#/);
      if (hash >= 0) ve = trimRight(text, vs, vs + hash);
    }
    addValue(b, i, ke, vs, ve, text);
  }
  return b.finish();
}

function parseProperties(text: string): DataTree {
  const b = new TreeBuilder(text, 'properties', 128);
  b.open(T_OBJECT, 0, 0, 0, 0);
  const all = [...lines(text)];
  for (let li = 0; li < all.length; li++) {
    const { start } = all[li];
    let { end } = all[li];
    const i = skipSpace(text, start, end);
    if (i >= end || text[i] === '#' || text[i] === '!') continue;
    // Find the key end: first unescaped '=', ':' or whitespace.
    let j = i;
    while (j < end) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '=' || c === ':' || c === ' ' || c === '\t') break;
      j++;
    }
    const ke = j;
    j = skipSpace(text, j, end);
    if (text[j] === '=' || text[j] === ':') j = skipSpace(text, j + 1, end);
    const vs = j;
    // Continuation lines end with an odd number of backslashes.
    let value = '';
    let segStart = vs;
    for (;;) {
      let bs = 0;
      for (let k = end - 1; k >= segStart && text[k] === '\\'; k--) bs++;
      if (bs % 2 === 1 && li + 1 < all.length) {
        value += text.slice(segStart, end - 1);
        li++;
        segStart = skipSpace(text, all[li].start, all[li].end);
        end = all[li].end;
        continue;
      }
      value += text.slice(segStart, end);
      break;
    }
    const decoded = value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) =>
      e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e,
    );
    const id = b.leaf(T_STRING, F_VAL_SYNTH, i, ke, vs, end);
    b.setValue(id, decoded);
  }
  return b.finish();
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
