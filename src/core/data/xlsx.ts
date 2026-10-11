/**
 * Minimal, dependency-free Excel (.xlsx / .xlsm) reader. Every worksheet
 * becomes an array of records keyed by its header row, so spreadsheets get the
 * same graph/table/schema/query views as CSV and JSON.
 *
 * The ZIP container is read directly; deflate is delegated to `inflateRaw`
 * (DecompressionStream in browsers and workers, zlib in Node), which keeps the
 * core free of platform APIs.
 */

export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array>;

export interface XlsxSheet {
  name: string;
  /** Rows of cell values; missing cells are null. */
  rows: (string | number | boolean | null)[][];
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // End of central directory: the last 0x06054b50 within the trailing 64 KiB.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (no ZIP directory found)');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name.replace(/^\/+/, ''), { name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(b: Uint8Array, e: ZipEntry, inflateRaw: InflateRaw): Promise<string> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`Corrupt .xlsx entry ${e.name}`);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = b.subarray(start, start + e.compressedSize);
  const data = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
  if (!data) throw new Error(`Unsupported compression in ${e.name}`);
  return new TextDecoder().decode(data);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
        e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
      );
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Text of <t> runs inside an <si> or <is> element (rich text concatenated, phonetic runs skipped). */
function runsText(xml: string): string {
  let out = '';
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return unescapeXml(out);
}

/** Built-in number formats that are dates/times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = unescapeXml(attr(m[0], 'formatCode') ?? '')
      .replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
      .toLowerCase();
    if (/[dmyhs]/.test(code) && !/^[#0.,%e+-]*$/.test(code)) custom.add(id);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (DATE_FORMAT_IDS.has(id) || custom.has(id)) out.add(i);
    i++;
  }
  return out;
}

/** Excel serial date (1900 system) → ISO string. */
function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  if (serial % 1 === 0) return iso.slice(0, 10);
  return serial < 1 ? iso.slice(11, 19) : iso.slice(0, 19);
}

function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export async function readXlsx(bytes: Uint8Array, inflateRaw: InflateRaw): Promise<XlsxSheet[]> {
  const entries = zipEntries(bytes);
  const read = async (path: string) => {
    const e = entries.get(path);
    return e ? readEntry(bytes, e, inflateRaw) : undefined;
  };
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('Not an .xlsx workbook (xl/workbook.xml is missing)');
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const shared: string[] = [];
  const sst = await read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] === undefined ? '' : runsText(m[1]));
  const dates = dateStyles(await read('xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  const sheets: XlsxSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`);
    const rid = attr(m[0], 'r:id') ?? /\s[\w]+:id="([^"]*)"/.exec(m[0])?.[1];
    const xml = await read((rid && targets.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`);
    if (xml === undefined) continue;
    const rows: XlsxSheet['rows'] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIndex = Number(attr(r[1], 'r') ?? rows.length + 1) - 1;
      const row: XlsxSheet['rows'][number] = [];
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        const type = attr(c[1], 't') ?? 'n';
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | number | boolean | null = null;
        if (type === 's') value = v === undefined ? null : (shared[Number(v)] ?? null);
        else if (type === 'inlineStr') value = runsText(body);
        else if (type === 'b') value = v === undefined ? null : v === '1';
        else if (type === 'str' || type === 'e' || type === 'd') value = v === undefined ? null : unescapeXml(v);
        else if (v !== undefined) {
          const num = Number(v);
          value = Number.isFinite(num) ? (dates.has(Number(attr(c[1], 's') ?? -1)) ? serialToIso(num, date1904) : num) : unescapeXml(v);
        }
        while (row.length < col) row.push(null);
        row[col] = value;
      }
      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = row;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

/** Sheets as `{ [sheet]: records[] }`: the first non-empty row is the header. */
export function sheetsToValue(sheets: XlsxSheet[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sheets) {
    const rows = s.rows.filter((r) => r.some((v) => v !== null && v !== ''));
    if (rows.length < 2) {
      out[s.name] = rows;
      continue;
    }
    const width = Math.max(...rows.map((r) => r.length));
    const seen = new Map<string, number>();
    const header = Array.from({ length: width }, (_, i) => {
      const raw = rows[0][i];
      let key = raw === null || raw === '' ? `column_${i + 1}` : String(raw).trim();
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) key = `${key}_${n}`;
      return key;
    });
    out[s.name] = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  }
  return out;
}

/** The workbook as pretty JSON text (what the data views parse and show). */
export async function xlsxToJson(bytes: Uint8Array, inflateRaw: InflateRaw): Promise<string> {
  return JSON.stringify(sheetsToValue(await readXlsx(bytes, inflateRaw)), null, 2);
}
