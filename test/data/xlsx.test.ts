import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { detectFormat, parseData } from '../../src/core/data/formats';
import { runQuery } from '../../src/core/data/query';
import { readXlsx, sheetsToValue, xlsxToJson } from '../../src/core/data/xlsx';
import { TOOLS } from '../../src/mcp/tools';
import { Workspace } from '../../src/node/workspace';

const inflate = async (d: Uint8Array) => new Uint8Array(inflateRawSync(d));

/** A minimal ZIP writer (stored or deflated entries; CRCs are not checked by the reader). */
function zip(files: Record<string, string>, deflate: boolean): Uint8Array {
  const enc = new TextEncoder();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(enc.encode(text));
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    local.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const WORKBOOK = {
  'xl/workbook.xml':
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><sheets>' +
    '<sheet name="People" sheetId="1" r:id="rId1"/><sheet name="Totals &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>Name</t></si><si><t>Joined</t></si><si><r><t>Ada </t></r><r><t>Lovelace</t></r></si>' +
    '<si><t>Active</t></si><si><t>Score</t></si><si><t xml:space="preserve">A &amp; B</t></si></sst>',
  'xl/styles.xml':
    '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>' +
    '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c><c r="D1" t="s"><v>4</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"><v>98.5</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Grace</t></is></c><c r="B4" s="2"><v>45000.5</v></c><c r="D4"><v>7</v></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>',
};

const EXPECTED = {
  People: [
    { Name: 'Ada Lovelace', Joined: '2023-03-15', Active: true, Score: 98.5 },
    { Name: 'Grace', Joined: '2023-03-15T12:00:00', Active: null, Score: 7 },
  ],
  'Totals & more': [['A & B']],
};

describe('xlsx', () => {
  it('reads stored and deflated workbooks: shared/inline/rich strings, booleans, dates, sparse rows', async () => {
    for (const deflate of [false, true]) {
      const sheets = await readXlsx(zip(WORKBOOK, deflate), inflate);
      expect(sheets.map((s) => s.name)).toEqual(['People', 'Totals & more']);
      expect(sheetsToValue(sheets)).toEqual(EXPECTED);
    }
  });

  it('dedupes and fills header names', () => {
    const value = sheetsToValue([{ name: 'S', rows: [['id', null, 'id'], [1, 2, 3]] }]);
    expect(value).toEqual({ S: [{ id: 1, column_2: 2, id_2: 3 }] });
  });

  it('converts sheets with hundreds of thousands of rows', () => {
    const rows: (string | number | null)[][] = [['n', 'label']];
    for (let i = 0; i < 200_000; i++) rows.push(i === 150_000 ? [i, 'x', 'extra'] : [i, 'x']);
    const sheet = sheetsToValue([{ name: 'Big', rows }]).Big as Record<string, unknown>[];
    expect(sheet).toHaveLength(200_000);
    expect(sheet[150_000]).toEqual({ n: 150_000, label: 'x', column_3: 'extra' });
  });

  it('is detected by extension and parses into a queryable tree', async () => {
    expect(detectFormat('Budget.XLSX')).toBe('xlsx');
    const tree = parseData(await xlsxToJson(zip(WORKBOOK, true), inflate), 'xlsx');
    expect(tree.format).toBe('xlsx');
    expect(tree.errors).toHaveLength(0);
    const r = runQuery(tree, '$.People[?(@.Active)].Name', 10);
    expect(r.ids.map((id) => tree.value(id))).toEqual(['Ada Lovelace']);
  });

  it('rejects files that are not workbooks', async () => {
    await expect(readXlsx(new TextEncoder().encode('{"not": "a zip"}'), inflate)).rejects.toThrow(/xlsx/);
  });

  describe('MCP tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'structlens-xlsx-'));
    writeFileSync(join(dir, 'book.xlsx'), zip(WORKBOOK, true));
    const ws = new Workspace([dir]);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('data_schema and data_query understand workbooks', async () => {
      const schema = await TOOLS.find((t) => t.name === 'data_schema')!.run(ws, { path: 'book.xlsx' }, {});
      expect(schema).toContain('People');
      expect(schema).toContain('Joined');
      const query = await TOOLS.find((t) => t.name === 'data_query')!.run(ws, { path: 'book.xlsx', query: '$.People[1].Score' }, {});
      expect(query).toContain('7');
    });
  });
});
