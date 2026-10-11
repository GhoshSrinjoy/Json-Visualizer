/** Data-format detection and the single entry point for parsing data files. */

import { parseCsv } from './csv';
import { parseJson, looksLikeJsonLines } from './json';
import { parseKeyValue } from './kv';
import { parseToml } from './toml';
import type { DataFormat, DataTree } from './tree';
import { parseXml } from './xml';
import { parseYaml } from './yaml';

export const FORMAT_LABELS: Record<DataFormat, string> = {
  json: 'JSON',
  jsonc: 'JSON with Comments',
  json5: 'JSON5',
  jsonl: 'JSON Lines',
  yaml: 'YAML',
  xml: 'XML',
  html: 'HTML',
  toml: 'TOML',
  csv: 'CSV',
  tsv: 'TSV',
  ini: 'INI',
  env: '.env',
  properties: 'Properties',
  xlsx: 'Excel',
};

/** Formats read from bytes rather than text (see xlsx.ts); their trees are built from converted JSON. */
export function isBinaryFormat(format: DataFormat | undefined): boolean {
  return format === 'xlsx';
}

const EXTENSIONS: Record<string, DataFormat> = {
  json: 'json', geojson: 'json', topojson: 'json', har: 'json', ipynb: 'json', webmanifest: 'json', map: 'json',
  jsonc: 'jsonc', code_workspace: 'jsonc', 'code-workspace': 'jsonc', 'code-snippets': 'jsonc',
  json5: 'json5',
  jsonl: 'jsonl', ndjson: 'jsonl', jsonlines: 'jsonl',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', csproj: 'xml', vbproj: 'xml',
  fsproj: 'xml', vcxproj: 'xml', props: 'xml', targets: 'xml', nuspec: 'xml', resx: 'xml', xaml: 'xml',
  axaml: 'xml', kml: 'xml', gpx: 'xml', rss: 'xml', atom: 'xml', wsdl: 'xml', xlf: 'xml', xliff: 'xml',
  storyboard: 'xml', xib: 'xml', drawio: 'xml', dtsx: 'xml', pom: 'xml', iml: 'xml',
  html: 'html', htm: 'html', xhtml: 'xml',
  toml: 'toml',
  csv: 'csv', tsv: 'tsv', tab: 'tsv', psv: 'csv',
  ini: 'ini', cfg: 'ini', editorconfig: 'ini', gitconfig: 'ini', npmrc: 'ini', inf: 'ini', desktop: 'ini',
  env: 'env',
  properties: 'properties',
  xlsx: 'xlsx', xlsm: 'xlsx',
};

const FILE_NAMES: Record<string, DataFormat> = {
  '.env': 'env',
  '.babelrc': 'json',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.swcrc': 'json',
  '.jshintrc': 'json',
  '.stylelintrc': 'json',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  'settings.json': 'jsonc',
  'launch.json': 'jsonc',
  'tasks.json': 'jsonc',
  'extensions.json': 'jsonc',
  'devcontainer.json': 'jsonc',
  '.devcontainer.json': 'jsonc',
  'keybindings.json': 'jsonc',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  'pipfile': 'toml',
  'uv.lock': 'toml',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitmodules': 'ini',
  'setup.cfg': 'ini',
  'tox.ini': 'ini',
  '.flake8': 'ini',
  '.pylintrc': 'ini',
  'pom.xml': 'xml',
  '.clang-format': 'yaml',
  '.clang-tidy': 'yaml',
};

/** VS Code language ids that map to a data format. */
const LANGUAGE_IDS: Record<string, DataFormat> = {
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  jsonl: 'jsonl',
  yaml: 'yaml',
  'github-actions-workflow': 'yaml',
  'dockercompose': 'yaml',
  xml: 'xml',
  xsl: 'xml',
  svg: 'xml',
  html: 'html',
  toml: 'toml',
  csv: 'csv',
  tsv: 'tsv',
  'csv (semicolon)': 'csv',
  'csv (pipe)': 'csv',
  ini: 'ini',
  properties: 'properties',
  dotenv: 'env',
  'java-properties': 'properties',
};

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Detects a data format from a file name, an optional VS Code language id and
 * (as a last resort) the content. Returns undefined for non-data files.
 */
export function detectFormat(fileName: string, languageId?: string, text?: string): DataFormat | undefined {
  const name = baseName(fileName).toLowerCase();
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  if (name.startsWith('.env')) return 'env';
  if (/^\.?(eslint|prettier|babel|stylelint|lint-staged|commitlint)rc$/.test(name)) return 'json';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (EXTENSIONS[ext]) {
    const f = EXTENSIONS[ext];
    if (f === 'json' && text !== undefined && looksLikeJsonLines(text)) return 'jsonl';
    return f;
  }
  if (languageId && LANGUAGE_IDS[languageId]) return LANGUAGE_IDS[languageId];
  if (text !== undefined) return sniffFormat(text);
  return undefined;
}

/** Content-based guess for extensionless or unknown files. */
export function sniffFormat(text: string): DataFormat | undefined {
  const head = text.slice(0, 4096).replace(/^﻿/, '').trimStart();
  if (!head) return undefined;
  const c = head[0];
  if (c === '{' || c === '[') return looksLikeJsonLines(text) ? 'jsonl' : 'json';
  if (c === '<') return /^<!doctype html|^<html/i.test(head) ? 'html' : 'xml';
  if (/^---\s*$/m.test(head.split('\n')[0]) || /^[\w"'-][^\n:]*:\s/m.test(head)) return 'yaml';
  if (/^\[[^\]]+\]\s*$/m.test(head) && /^\s*[\w.-]+\s*=/m.test(head)) return /=\s*["'[{\d]/.test(head) ? 'toml' : 'ini';
  if (/^[A-Z_][A-Z0-9_]*=/m.test(head)) return 'env';
  return undefined;
}

export interface ParseOptions {
  /** CSV/TSV: override delimiter or header detection. */
  delimiter?: string;
  header?: boolean | 'auto';
}

/** Parses text in the given format into a DataTree (never throws). */
export function parseData(text: string, format: DataFormat, options: ParseOptions = {}): DataTree {
  switch (format) {
    case 'xlsx':
      // Text is the workbook converted by xlsxToJson().
      return parseJson(text, { format: 'xlsx' });
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'jsonl':
      return parseJson(text, { format });
    case 'yaml':
      return parseYaml(text);
    case 'xml':
      return parseXml(text);
    case 'html':
      return parseXml(text, { html: true });
    case 'toml':
      return parseToml(text);
    case 'csv':
    case 'tsv':
      return parseCsv(text, { format, delimiter: options.delimiter, header: options.header });
    case 'ini':
    case 'env':
    case 'properties':
      return parseKeyValue(text, format);
  }
}

/** Decodes bytes as UTF-8 (BOM-aware), falling back to UTF-16 when a UTF-16 BOM is present. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}
