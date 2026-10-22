/**
 * Tools that compare, validate, type and convert data files (part of TOOLS, so
 * they are MCP tools, CLI commands and Copilot tools alike).
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { convertTree } from '../core/data/convert';
import { diffToText, diffTrees } from '../core/data/diff';
import { QueryError, runQuery } from '../core/data/query';
import { inferSchema } from '../core/data/schema';
import { CONVERT_TARGETS, TYPE_TARGETS, type ConvertTarget, type TypeTarget } from '../core/data/targets';
import type { DataTree } from '../core/data/tree';
import { generateTypes } from '../core/data/typegen';
import { schemaUriOf, validateTree, type ValidationResult } from '../core/data/validate';
import { plural } from '../core/util/strings';
import type { Workspace } from '../node/workspace';
import type { ToolDef } from './tools';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);

function subtree(tree: DataTree, at: string | undefined): number {
  if (!at) return tree.root;
  const r = runQuery(tree, at, 1);
  if (!r.ids.length) throw new QueryError(`Nothing matches ${at}`, 0);
  return r.ids[0];
}

/** `users.json`, `$.orders[0]` → `Users`, `Orders` (the top-level type name). */
function typeName(source: string): string {
  const words = source.replace(/\.[^./\\]+$/, '').split(/[/\\]/).pop()!.match(/[A-Za-z0-9]+/g) ?? [];
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(name) ? name : 'Root';
}

const parseDoc = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
};

/** A schema document by URL, file URL or path (relative to `dir`); local files stay inside the workspace. */
async function loadSchema(ws: Workspace, ref: string, dir: string): Promise<{ uri: string; value: unknown }> {
  const clean = ref.replace(/#.*$/, '');
  if (/^https?:/i.test(clean)) {
    const res = await fetch(clean, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/schema+json, application/json, */*' } });
    if (!res.ok) throw new Error(`Could not download ${clean}: HTTP ${res.status}`);
    return { uri: clean, value: parseDoc(await res.text()) };
  }
  const path = /^file:/i.test(clean) ? fileURLToPath(clean) : isAbsolute(clean) ? clean : resolve(dir, clean);
  const { abs, text } = await ws.readText(path);
  return { uri: pathToFileURL(abs).href, value: parseDoc(text) };
}

/** Validates, fetching `$ref`'d documents the schema needs (in rounds); unloadable ones accept anything. */
async function validateWithRefs(ws: Workspace, tree: DataTree, root: { uri: string; value: unknown }, dir: string): Promise<{ result: ValidationResult; unresolved: string[] }> {
  const docs = new Map<string, unknown>();
  const unresolved: string[] = [];
  for (let round = 0; ; round++) {
    const missing: string[] = [];
    const result = validateTree(tree, root.value, {
      resolve: (uri) => {
        const key = uri.replace(/#.*$/, '');
        if (docs.has(key)) return docs.get(key);
        missing.push(key);
        return undefined;
      },
    });
    if (!missing.length || round === 4) return { result, unresolved };
    for (const m of missing) {
      let target = m;
      try {
        target = new URL(m, root.uri).href;
      } catch {
        // not URL-like: treat as a path
      }
      docs.set(
        m,
        await loadSchema(ws, target, dir).then(
          (d) => d.value,
          () => (unresolved.push(m), {}),
        ),
      );
    }
  }
}

const typeIds = TYPE_TARGETS.map((t) => t.id) as [TypeTarget, ...TypeTarget[]];
const convertIds = CONVERT_TARGETS.map((t) => t.id) as [ConvertTarget, ...ConvertTarget[]];

export const DATA_TOOLS: ToolDef[] = [
  {
    name: 'data_validate',
    title: 'Validate against a JSON Schema',
    description:
      "Checks a JSON/YAML/TOML/CSV/XML/Excel file against a JSON Schema (drafts 4, 6, 7, 2019-09, 2020-12, with $ref across files): the document's own $schema, or the schema you name (a workspace path or an http(s) URL). Lists each error with its JSONPath, line and message, or says the file is valid.",
    inputSchema: {
      path: z.string().describe('Data file path'),
      schema: z.string().optional().describe("Schema: a path (relative to the data file) or URL. Default: the document's $schema"),
      maxErrors: z.number().int().min(1).max(5000).optional().describe('Errors to list (default 200)'),
    },
    cli: { command: 'validate', positional: ['path'], summary: 'Check against a JSON Schema (--schema <file or URL>)' },
    async run(ws, a) {
      const path = str(a.path) ?? '';
      const { abs, tree } = await ws.data(path);
      const ref = str(a.schema) ?? schemaUriOf(tree);
      if (!ref) return `${ws.rel(abs)} has no $schema. Pass schema (a path or URL) to say which schema to check it against.`;
      // A schema named in the call is workspace-relative, like every tool path; the document's own $schema is relative to the document.
      const dir = dirname(abs);
      const given = str(a.schema);
      const root = await loadSchema(ws, given && !/^[a-z][\w+.-]+:/i.test(given) && !isAbsolute(given) ? ws.resolvePath(given) : ref, dir);
      const { result, unresolved } = await validateWithRefs(ws, tree, root, dir);
      const out: string[] = [];
      const name = ref.split(/[/\\]/).pop();
      if (result.valid) out.push(`${ws.rel(abs)} is valid against ${name}.`);
      else {
        const max = num(a.maxErrors) ?? 200;
        out.push(`${ws.rel(abs)}: ${plural(result.errors.length, 'error')}${result.truncated ? '+' : ''} against ${name}`);
        for (const e of result.errors.slice(0, max)) {
          const line = tree.hasPosition(e.id) ? ` (line ${tree.lineCol(tree.start(e.id)).line + 1})` : '';
          out.push(`- ${e.path}${line}: ${e.message}`);
        }
        if (result.errors.length > max) out.push(`… ${plural(result.errors.length - max, 'more error')}`);
      }
      if (unresolved.length) out.push(`Not loaded (treated as accepting anything): ${unresolved.join(', ')}`);
      if (result.unsupported.length) out.push(`Not checked: ${result.unsupported.join(', ')}`);
      return out.join('\n');
    },
  },
  {
    name: 'data_diff',
    title: 'Compare two data files',
    description:
      'Structural diff of two data files, in any formats (JSON against YAML works): what was added, removed, changed (old → new) or moved, with JSONPaths. Key order and formatting are ignored and arrays of records are matched by their ids. Use it to review config, fixture or API-response changes.',
    inputSchema: {
      left: z.string().describe('The original file'),
      right: z.string().describe('The changed file'),
      arrays: z.enum(['auto', 'index', 'lcs']).optional().describe('Array matching: auto (by id, else by content; default), lcs (by content), index (by position)'),
      ignoreOrder: z.boolean().optional().describe('Treat arrays as unordered'),
      maxLines: z.number().int().min(10).max(10000).optional().describe('Change lines to list (default 400)'),
    },
    cli: { command: 'diff', positional: ['left', 'right'], summary: 'Structural differences between two data files' },
    async run(ws, a) {
      const [l, r] = await Promise.all([ws.data(str(a.left) ?? ''), ws.data(str(a.right) ?? '')]);
      const arrays = str(a.arrays) as 'auto' | 'index' | 'lcs' | undefined;
      const result = diffTrees(l.tree, r.tree, { arrays, ignoreOrder: bool(a.ignoreOrder) });
      return `${ws.rel(l.abs)} → ${ws.rel(r.abs)}\n${diffToText(result, l.tree, r.tree, { maxLines: num(a.maxLines) })}`;
    },
  },
  {
    name: 'data_types',
    title: 'Generate types from data',
    description:
      'Type declarations inferred from a data file (or the subtree at a JSONPath) for TypeScript, Zod, Python (Pydantic), Go, Rust (serde), C#, Kotlin, Swift or Java (Jackson): nested types named after their keys, optional and nullable fields, maps for dynamic keys, integer sizes from the observed values, and renames for keys that are not identifiers.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      language: z.enum(typeIds).optional().describe('Target language (default typescript)'),
      at: z.string().optional().describe('JSONPath of the subtree to type, e.g. $.data'),
      name: z.string().optional().describe('Name of the top-level type (default: from the file name)'),
    },
    cli: { command: 'types', positional: ['path'], summary: 'Type declarations (--language typescript | zod | python | go | rust | csharp | kotlin | swift | java)' },
    async run(ws, a) {
      const path = str(a.path) ?? '';
      const { tree } = await ws.data(path);
      const at = str(a.at);
      const language = (str(a.language) ?? 'typescript') as TypeTarget;
      return generateTypes(inferSchema(tree, subtree(tree, at)), language, { rootName: str(a.name) ?? typeName(at ?? path) });
    },
  },
  {
    name: 'data_convert',
    title: 'Convert a data file',
    description:
      'A data file (or the subtree at a JSONPath) as YAML, TOML, CSV, TSV, XML or JSON Lines. Arrays of records become CSV rows, with nested objects flattened into dotted columns. Large integers keep all their digits.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      to: z.enum(convertIds).describe('Target format'),
      at: z.string().optional().describe('JSONPath of the part to convert'),
      maxChars: z.number().int().min(0).optional().describe('Truncate longer output (default 200000 for agents; 0 = no limit)'),
    },
    cli: { command: 'convert', positional: ['path'], summary: 'Convert (--to yaml | toml | csv | tsv | xml | jsonl)' },
    async run(ws, a, ctx) {
      const { tree } = await ws.data(str(a.path) ?? '');
      const text = convertTree(tree, subtree(tree, str(a.at)), (str(a.to) ?? 'yaml') as ConvertTarget);
      const max = num(a.maxChars) ?? (ctx.cli ? 0 : 200_000);
      return max && text.length > max ? `${text.slice(0, max)}\n… ${(text.length - max).toLocaleString()} more characters (narrow it with "at")` : text;
    },
  },
];
