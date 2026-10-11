/** Small string helpers shared by parsers, renderers and the UI. */

const QUOTE = 34; // "
const APOS = 39; // '

/**
 * Decodes a quoted JSON (or JSON5 single-quoted) string literal including its
 * quotes. Falls back to a lenient manual decoder for literals that strict
 * JSON.parse rejects (raw control characters, invalid escapes, ' quotes).
 */
export function decodeQuoted(raw: string): string {
  const q = raw.charCodeAt(0);
  if (q !== QUOTE && q !== APOS) return raw;
  const closed = raw.length >= 2 && raw.charCodeAt(raw.length - 1) === q;
  const body = closed ? raw.slice(1, -1) : raw.slice(1);
  if (body.indexOf('\\') < 0) return body;
  if (q === QUOTE && closed) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      // fall through to the lenient decoder
    }
  }
  return unescapeLenient(body);
}

function unescapeLenient(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i === s.length - 1) {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += 'u';
        break;
      }
      case 'x': {
        const hex = s.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else out += 'x';
        break;
      }
      case '\n': break; // JSON5 line continuation
      case '\r': if (s[i + 1] === '\n') i++; break;
      default: out += n;
    }
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ',
};

/** Decodes XML/HTML character and the five predefined (plus nbsp) entities. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/** Truncates to `max` UTF-16 units, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '…' : s.slice(0, max - 1) + '…';
}

/** Makes a single-line, display-safe preview of arbitrary text. */
export function oneLine(s: string, max: number): string {
  let t = s.length > max * 2 ? s.slice(0, max * 2) : s;
  if (/[\n\r\t]/.test(t)) t = t.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '  ');
  return truncate(t, max);
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Formats one path segment in JSONPath bracket/dot notation. */
export function pathSegment(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  if (IDENT_RE.test(key)) return `.${key}`;
  return `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

export function formatPath(path: ReadonlyArray<string | number>): string {
  let s = '$';
  for (const k of path) s += pathSegment(k);
  return s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

/** Adds thousands separators: 1234567 -> "1,234,567". */
export function withCommas(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${withCommas(n)} ${n === 1 ? one : many}`;
}
