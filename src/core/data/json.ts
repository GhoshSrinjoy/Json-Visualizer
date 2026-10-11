/**
 * Single-pass, iterative JSON scanner that writes straight into a DataTree.
 *
 * - No recursion: arbitrarily deep documents cannot overflow the stack.
 * - Strings are skipped with native indexOf, which is what makes this fast on
 *   multi-hundred-megabyte inputs; values are never materialised.
 * - Tolerant by design: comments, trailing commas, single quotes, unquoted
 *   keys, NaN/Infinity/hex (JSONC/JSON5), several top-level values (JSON
 *   Lines) and malformed input all produce a usable tree plus error records.
 */

import {
  DataTree,
  F_ERROR,
  F_ESCAPED,
  F_SYNTHETIC,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
  type DataFormat,
} from './tree';

export interface JsonParseOptions {
  format?: Extract<DataFormat, 'json' | 'jsonc' | 'json5' | 'jsonl' | 'xlsx'>;
  /** Stop after this many errors (the input is probably not JSON). */
  maxErrors?: number;
}

const S_TOP = 0; // between top-level values
const S_VALUE = 1; // after ':' or ',' in an array
const S_VALUE_OR_CLOSE = 2; // right after '['
const S_KEY_OR_CLOSE = 3; // right after '{' or ','
const S_COLON = 4; // after a key
const S_AFTER = 5; // after a value inside a container

const BACKSLASH = 92;

export function parseJson(text: string, options: JsonParseOptions = {}): DataTree {
  const started = now();
  const format = options.format ?? 'json';
  const maxErrors = options.maxErrors ?? 200;
  const n = text.length;
  const b = new TreeBuilder(text, format, (n >>> 4) + 16);
  const tree = b.tree;
  b.open(T_ARRAY, F_SYNTHETIC, 0, 0, 0);

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let state = S_TOP;
  let keyPos = 0;
  let keyEnd = 0;
  let errorCount = 0;
  // Lazily maintained positions of the next '\\' and '\n' at/after the scan
  // position; -1 means "none left". Keeps escape/newline detection O(n).
  let nextBackslash = -2;
  let nextNewline = -2;

  const error = (at: number, message: string) => {
    errorCount++;
    b.error(at, message);
  };

  const afterValue = () => (b.depth <= 1 ? S_TOP : S_AFTER);
  const topIsObject = () => tree.type[b.top] === T_OBJECT;

  /**
   * Returns the index just past the closing quote of the literal starting at
   * `start`; sets `escaped` when the literal contains a backslash.
   */
  let escaped = false;
  const scanQuoted = (start: number, quote: string): number => {
    let q = text.indexOf(quote, start + 1);
    while (q > 0 && text.charCodeAt(q - 1) === BACKSLASH) {
      let k = q - 1;
      while (text.charCodeAt(k) === BACKSLASH) k--;
      if ((q - 1 - k) % 2 === 0) break; // even run of backslashes: quote is real
      q = text.indexOf(quote, q + 1);
    }
    if (nextNewline !== -1 && nextNewline <= start) nextNewline = text.indexOf('\n', start + 1);
    // A raw newline before the closing quote means the literal is unterminated
    // (unless it is a JSON5 line continuation).
    while (nextNewline !== -1 && (q < 0 || nextNewline < q)) {
      const prev = text.charCodeAt(nextNewline - 1);
      const cont = prev === BACKSLASH || (prev === 13 && text.charCodeAt(nextNewline - 2) === BACKSLASH);
      if (!cont) {
        error(start, 'Unterminated string');
        let e = nextNewline;
        if (text.charCodeAt(e - 1) === 13) e--;
        escaped = true;
        return e;
      }
      nextNewline = text.indexOf('\n', nextNewline + 1);
    }
    if (q < 0) {
      error(start, 'Unterminated string');
      escaped = true;
      return n;
    }
    if (nextBackslash !== -1 && nextBackslash <= start) nextBackslash = text.indexOf('\\', start + 1);
    escaped = nextBackslash !== -1 && nextBackslash < q;
    return q + 1;
  };

  const isDelimiter = (c: number) =>
    c !== c /* NaN: end of input */ ||
    c === 44 || c === 125 || c === 93 || c === 58 || c === 32 || c === 10 || c === 13 || c === 9 || c === 47;

  /** Skips an invalid token and records it as an error leaf. */
  const garbage = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 44 || c === 125 || c === 93 || c === 10 || c === 13) break;
      j++;
    }
    if (j === start) j++;
    error(start, `Unexpected ${describe(text, start)}`);
    b.leaf(T_STRING, F_ERROR, keyPos, keyEnd, start, j);
    return j;
  };

  /** Number or JSON5 numeric literal (hex, Infinity, NaN, leading +/.). */
  const scanNumber = (start: number): number => {
    let j = start;
    let c = text.charCodeAt(j);
    if (c === 45 || c === 43) c = text.charCodeAt(++j);
    if (c === 48 && (text.charCodeAt(j + 1) | 32) === 120) {
      j += 2;
      while (j < n && /[0-9a-fA-F_]/.test(text[j])) j++;
      return j;
    }
    if (c === 73 && text.startsWith('Infinity', j)) return j + 8;
    if (c === 78 && text.startsWith('NaN', j)) return j + 3;
    while (j < n) {
      c = text.charCodeAt(j);
      if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || c === 43 || c === 45 || c === 95) j++;
      else break;
    }
    return j;
  };

  const isIdentChar = (c: number) =>
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;

  outer: while (errorCount < maxErrors) {
    // Whitespace and comments.
    let c = 0;
    while (i < n) {
      c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        i++;
        continue;
      }
      if (c === 47) {
        const d = text.charCodeAt(i + 1);
        if (d === 47) {
          const e = text.indexOf('\n', i + 2);
          i = e < 0 ? n : e + 1;
          continue;
        }
        if (d === 42) {
          const e = text.indexOf('*/', i + 2);
          if (e < 0) error(i, 'Unterminated comment');
          i = e < 0 ? n : e + 2;
          continue;
        }
      }
      if (c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 11 || c === 12) {
        i++;
        continue;
      }
      break;
    }
    if (i >= n) break;

    switch (state) {
      case S_TOP:
      case S_VALUE:
      case S_VALUE_OR_CLOSE: {
        if (c === 93 && state !== S_VALUE && b.depth > 1) {
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        if (c === 44 && state === S_TOP) {
          i++; // commas between top-level values: `{...},{...}`
          continue outer;
        }
        if (c === 93 || c === 125) {
          // Closing bracket where a value is required (`[1,]` handled above).
          if (state === S_TOP) {
            error(i, `Unexpected ${describe(text, i)}`);
            i++;
            continue outer;
          }
          // `{"a": }` — record a missing value and let S_AFTER close.
          error(i, 'Missing value');
          b.leaf(T_NULL, F_ERROR, keyPos, keyEnd, i, i);
          state = S_AFTER;
          continue outer;
        }
        switch (c) {
          case 123:
            b.open(T_OBJECT, 0, keyPos, keyEnd, i);
            i++;
            state = S_KEY_OR_CLOSE;
            continue outer;
          case 91:
            b.open(T_ARRAY, 0, keyPos, keyEnd, i);
            i++;
            state = S_VALUE_OR_CLOSE;
            continue outer;
          case 34: {
            const end = scanQuoted(i, '"');
            b.leaf(T_STRING, escaped ? F_ESCAPED : 0, keyPos, keyEnd, i, end);
            i = end;
            state = afterValue();
            continue outer;
          }
          case 39: {
            const end = scanQuoted(i, "'");
            b.leaf(T_STRING, F_ESCAPED, keyPos, keyEnd, i, end);
            i = end;
            state = afterValue();
            continue outer;
          }
          case 116:
            if (text.startsWith('true', i) && isDelimiter(text.charCodeAt(i + 4))) {
              b.leaf(T_BOOLEAN, 0, keyPos, keyEnd, i, i + 4);
              i += 4;
              state = afterValue();
              continue outer;
            }
            break;
          case 102:
            if (text.startsWith('false', i) && isDelimiter(text.charCodeAt(i + 5))) {
              b.leaf(T_BOOLEAN, 0, keyPos, keyEnd, i, i + 5);
              i += 5;
              state = afterValue();
              continue outer;
            }
            break;
          case 110:
            if (text.startsWith('null', i) && isDelimiter(text.charCodeAt(i + 4))) {
              b.leaf(T_NULL, 0, keyPos, keyEnd, i, i + 4);
              i += 4;
              state = afterValue();
              continue outer;
            }
            break;
          default:
            if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 73 || c === 78) {
              const end = scanNumber(i);
              if (end > i && isDelimiter(text.charCodeAt(end))) {
                b.leaf(T_NUMBER, 0, keyPos, keyEnd, i, end);
                i = end;
                state = afterValue();
                continue outer;
              }
            }
        }
        i = garbage(i);
        state = afterValue();
        continue outer;
      }

      case S_KEY_OR_CLOSE: {
        if (c === 125) {
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        if (c === 34 || c === 39) {
          keyPos = i;
          keyEnd = scanQuoted(i, c === 34 ? '"' : "'");
          i = keyEnd;
          state = S_COLON;
          continue outer;
        }
        if (isIdentChar(c)) {
          let j = i + 1;
          while (j < n && isIdentChar(text.charCodeAt(j))) j++;
          keyPos = i;
          keyEnd = j;
          i = j;
          state = S_COLON;
          continue outer;
        }
        if (c === 44) {
          error(i, 'Unexpected ","');
          i++;
          continue outer;
        }
        if (c === 93) {
          error(i, 'Mismatched "]"');
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        // Something like `{ : 1 }` or `{ - }`: treat the token as an unquoted key.
        error(i, `Unexpected ${describe(text, i)} in object`);
        keyPos = i;
        let j = i + 1;
        while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
        keyEnd = j;
        i = j;
        state = S_COLON;
        continue outer;
      }

      case S_COLON:
        if (c === 58) {
          i++;
          state = S_VALUE;
          continue outer;
        }
        if (c === 61) {
          error(i, 'Expected ":" but found "="');
          i++;
          state = S_VALUE;
          continue outer;
        }
        error(i, 'Expected ":"');
        if (c === 44 || c === 125) {
          // `{"a", ...}` / `{"a"}`: a key without a value.
          b.leaf(T_NULL, F_ERROR, keyPos, keyEnd, i, i);
          state = S_AFTER;
        } else {
          state = S_VALUE; // `{"a" 1}`: assume the colon and parse the value
        }
        continue outer;

      case S_AFTER: {
        if (c === 44) {
          i++;
          state = topIsObject() ? S_KEY_OR_CLOSE : S_VALUE_OR_CLOSE;
          continue outer;
        }
        if (c === 125 || c === 93) {
          if ((c === 125) !== topIsObject()) error(i, `Mismatched "${text[i]}"`);
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        error(i, 'Expected "," or closing bracket');
        state = topIsObject() ? S_KEY_OR_CLOSE : S_VALUE;
        continue outer;
      }
    }
  }

  if (errorCount >= maxErrors) b.error(i, 'Too many errors; stopped parsing');
  else if (b.depth > 1) error(n, 'Unexpected end of input (unclosed bracket)');
  b.closeAll(n);
  const result = b.finish();
  result.parseMs = now() - started;
  return result;
}

/** True when the text holds several newline-separated top-level JSON values. */
export function looksLikeJsonLines(text: string): boolean {
  let lines = 0;
  let start = 0;
  for (let k = 0; k < 5 && start < text.length; k++) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const f = line[0];
    const l = line[line.length - 1];
    if (!((f === '{' && l === '}') || (f === '[' && l === ']'))) return false;
    lines++;
  }
  return lines >= 2;
}

function describe(text: string, i: number): string {
  if (i >= text.length) return 'end of input';
  const ch = text[i];
  if (/[A-Za-z0-9_]/.test(ch)) {
    const m = /^[A-Za-z0-9_$.+-]{1,20}/.exec(text.slice(i, i + 20));
    return `token "${m ? m[0] : ch}"`;
  }
  return `character ${JSON.stringify(ch)}`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
