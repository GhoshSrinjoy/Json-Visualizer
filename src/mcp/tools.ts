/**
 * Tool definitions shared by the MCP server and the CLI. Each tool is a
 * read-only operation over a Workspace that returns compact, agent-friendly
 * text (with Mermaid diagrams where useful).
 */

import { z, type ZodTypeAny } from 'zod';
import { flattenSymbols, isCodeFile, MODULE_SYMBOL } from '../core/code/analyze';
import { detectFormat, FORMAT_LABELS } from '../core/data/formats';
import { QueryError, runQuery } from '../core/data/query';
import { inferSchema, schemaToJsonSchema, schemaToText, schemaToTypeScript } from '../core/data/schema';
import { searchTree } from '../core/data/search';
import type { DataTree } from '../core/data/tree';
import { callGraphToMermaid, dataFlowToMermaid, depsToMermaid, flowToMermaid } from '../core/format/mermaid';
import {
  callGraphText,
  dataFlowText,
  dataMatchesText,
  dataSummaryText,
  dataTreeText,
  depsText,
  flowText,
  outlineText,
  repoSummaryText,
  repoTreeText,
} from '../core/format/text';
import { aggregateByFolder } from '../core/repo/deps';
import { repoIndex } from '../core/repo/model';
import { PathError, type Workspace } from '../node/workspace';

export interface ToolContext {
  /** Opens a visualization for the user; returns a human-readable status. */
  openVisualizer?: (req: { path: string; view?: string; symbol?: string; line?: number }) => Promise<string>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  /** Positional CLI arguments, in order (the rest are --flags). */
  cli?: { command: string; positional: string[]; summary: string };
  run(ws: Workspace, args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const fnTarget = z.string().describe(`Function name, Class.method, a line number inside it, or "${MODULE_SYMBOL}" for top-level code`);
const viewNames = ['graph', 'tree', 'table', 'schema', 'text', 'structure', 'flow', 'dataflow', 'calls', 'treemap', 'deps', 'stats'] as const;

function firstMatch(tree: DataTree, at: string): number {
  const r = runQuery(tree, at, 1);
  if (!r.ids.length) throw new QueryError(`Nothing matches ${at}`, 0);
  return r.ids[0];
}

async function dataStructure(ws: Workspace, abs: string, mode: string, depth?: number): Promise<string> {
  const { tree, format } = await ws.data(abs);
  const head = dataSummaryText(tree, `${ws.rel(abs)} (${FORMAT_LABELS[format]})`);
  if (mode === 'summary') return head;
  if (mode === 'outline') return `${head}\n\n${dataTreeText(tree, { depth: depth ?? 4 })}`;
  return `${head}\n\nSchema:\n${schemaToText(inferSchema(tree), { maxDepth: depth ?? 12 })}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : undefined);

export const TOOLS: ToolDef[] = [
  {
    name: 'repo_overview',
    title: 'Repository overview',
    description:
      'Summary of a repository or folder: file/line counts, language breakdown, largest files, key config/entry files and the top two levels of the tree. Respects .gitignore. Call this first to orient yourself.',
    inputSchema: { path: z.string().optional().describe('Folder (default: workspace root)') },
    cli: { command: 'overview', positional: ['path'], summary: 'Repository summary: languages, largest and key files' },
    async run(ws, a) {
      const repo = await ws.repo(str(a.path) ?? '.');
      return `${repoSummaryText(repo)}\n\nTop-level structure:\n${repoTreeText(repo, { depth: 2, maxChildren: 30 })}`;
    },
  },
  {
    name: 'repo_tree',
    title: 'Directory tree',
    description:
      'Directory tree with per-folder file and line counts and per-file line counts (respects .gitignore; large folders are collapsed with "… N more"). Use path to zoom into a subfolder and depth to go deeper.',
    inputSchema: {
      path: z.string().optional().describe('Folder (default: workspace root)'),
      depth: z.number().int().min(1).max(20).optional().describe('Levels to expand (default 3)'),
      maxChildren: z.number().int().min(5).max(500).optional().describe('Entries listed per folder before collapsing (default 40)'),
      dirsOnly: z.boolean().optional().describe('Only show folders'),
      showSize: z.boolean().optional().describe('Show byte sizes'),
    },
    cli: { command: 'tree', positional: ['path'], summary: 'Directory tree with file and line counts' },
    async run(ws, a) {
      const abs = ws.resolvePath(str(a.path) ?? '.');
      const repo = await ws.repo(ws.rootOf(abs));
      const rel = ws.rel(abs);
      const from = rel === '.' ? 0 : repoIndex(repo).get(rel);
      if (from === undefined) throw new PathError(`Not found in the scanned tree (ignored, or not a folder?): ${String(a.path)}`);
      return repoTreeText(repo, { depth: num(a.depth) ?? 3, maxChildren: num(a.maxChildren), dirsOnly: bool(a.dirsOnly), showSize: bool(a.showSize), from });
    },
  },
  {
    name: 'file_structure',
    title: 'Structure of a file',
    description:
      'General structural view of any file. Data files (JSON, JSONC, JSON Lines, YAML, XML, HTML, TOML, CSV/TSV, Excel .xlsx, INI, .env, .properties) return a size/type summary plus an inferred schema (default) or a value outline; huge files are fine. Source files (TypeScript, JavaScript, Python, Go, Java, C#, Rust, C/C++, Ruby, PHP and more) return imports, exports and the symbol tree with signatures, line ranges and complexity.',
    inputSchema: {
      path: z.string().describe('File path'),
      mode: z.enum(['schema', 'outline', 'summary']).optional().describe('Data files: schema (default), outline of values, or summary only'),
      depth: z.number().int().min(1).max(30).optional().describe('Depth for outlines (default 4)'),
      showCalls: z.boolean().optional().describe('Code files: list the calls each function makes'),
    },
    cli: { command: 'structure', positional: ['path'], summary: 'General structure of any data or source file' },
    async run(ws, a) {
      const abs = ws.resolvePath(str(a.path) ?? '');
      const mode = str(a.mode) ?? 'schema';
      if (detectFormat(abs)) return dataStructure(ws, abs, mode, num(a.depth));
      if (isCodeFile(abs)) return outlineText(await ws.outline(abs), { maxDepth: num(a.depth) ?? 4, showCalls: bool(a.showCalls) });
      try {
        return await dataStructure(ws, abs, mode, num(a.depth));
      } catch {
        throw new PathError(`Unsupported file type: ${String(a.path)}`);
      }
    },
  },
  {
    name: 'data_schema',
    title: 'Infer data schema',
    description:
      'Infers the schema of a JSON/YAML/XML/TOML/CSV/Excel file (or of the subtree at a JSONPath): types, optional fields with presence %, array sizes, enums, formats (date-time, email, uuid…), numeric ranges and examples. Output as compact text, JSON Schema or TypeScript types. Ideal for files too large to read.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      at: z.string().optional().describe('JSONPath of the subtree to describe, e.g. $.items[0]'),
      format: z.enum(['text', 'json-schema', 'typescript']).optional().describe('Output format (default text)'),
    },
    cli: { command: 'schema', positional: ['path'], summary: 'Inferred schema (text, JSON Schema or TypeScript)' },
    async run(ws, a) {
      const { tree } = await ws.data(str(a.path) ?? '');
      const at = str(a.at);
      const schema = inferSchema(tree, at ? firstMatch(tree, at) : tree.root);
      const format = str(a.format);
      if (format === 'json-schema') return JSON.stringify(schemaToJsonSchema(schema), null, 2);
      if (format === 'typescript') return schemaToTypeScript(schema);
      return schemaToText(schema);
    },
  },
  {
    name: 'data_query',
    title: 'Query a data file',
    description:
      'Runs a JSONPath query against a JSON/YAML/XML/TOML/CSV/Excel file and returns matching paths, line numbers and values. Supports $.a.b, [0], [-1], [1:5], [*], .., unions and filters like $.users[?(@.age > 30 && @.active)] or [?(@.email =~ /@example\\.com$/)]; a bare @.field in a filter is tested for truthiness.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      query: z.string().describe('JSONPath expression'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max results (default 50)'),
    },
    cli: { command: 'query', positional: ['path', 'query'], summary: 'Run a JSONPath query' },
    async run(ws, a) {
      const { tree } = await ws.data(str(a.path) ?? '');
      const r = runQuery(tree, str(a.query) ?? '$', num(a.limit) ?? 50);
      return dataMatchesText(tree, r.ids, r.total);
    },
  },
  {
    name: 'data_search',
    title: 'Search keys and values',
    description: 'Full-text search over the keys and values of a data file; returns the JSONPath, line and value of each hit.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      text: z.string().describe('Text or regular expression to find'),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      in: z.enum(['both', 'keys', 'values']).optional().describe('Where to search (default both)'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max results (default 50)'),
    },
    cli: { command: 'search', positional: ['path', 'text'], summary: 'Search keys and values of a data file' },
    async run(ws, a) {
      const { tree } = await ws.data(str(a.path) ?? '');
      const where = str(a.in);
      const r = searchTree(tree, {
        query: str(a.text) ?? '',
        regex: bool(a.regex),
        caseSensitive: bool(a.caseSensitive),
        keys: where !== 'values',
        values: where !== 'keys',
        limit: num(a.limit) ?? 50,
      });
      if (r.error) throw new QueryError(`Invalid pattern: ${r.error}`, 0);
      return dataMatchesText(tree, r.hits.map((h) => h.id), r.truncated ? r.hits.length + 1 : r.hits.length, 200);
    },
  },
  {
    name: 'data_tree',
    title: 'Browse data values',
    description: 'Outline of the actual values in a data file starting at a JSONPath (keys, types, child counts, value previews). Use to page through large documents level by level.',
    inputSchema: {
      path: z.string().describe('Data file path'),
      at: z.string().optional().describe('JSONPath to start from (default $)'),
      depth: z.number().int().min(1).max(20).optional().describe('Levels (default 3)'),
      maxChildren: z.number().int().min(1).max(500).optional().describe('Children per node (default 25)'),
    },
    cli: { command: 'values', positional: ['path', 'at'], summary: 'Outline of the values in a data file' },
    async run(ws, a) {
      const { tree } = await ws.data(str(a.path) ?? '');
      const at = str(a.at);
      return dataTreeText(tree, { from: at ? firstMatch(tree, at) : tree.root, depth: num(a.depth) ?? 3, maxChildren: num(a.maxChildren) });
    },
  },
  {
    name: 'code_outline',
    title: 'Code outline',
    description: 'Imports, exports and the symbol tree (classes, interfaces, functions, methods, fields) of a source file with signatures, docs, modifiers, base types, line ranges and cyclomatic complexity.',
    inputSchema: {
      path: z.string().describe('Source file path'),
      showCalls: z.boolean().optional().describe('Also list the calls made by each function'),
    },
    cli: { command: 'outline', positional: ['path'], summary: 'Symbols, imports and exports of a source file' },
    async run(ws, a) {
      return outlineText(await ws.outline(str(a.path) ?? ''), { showCalls: bool(a.showCalls) });
    },
  },
  {
    name: 'code_flow',
    title: 'Logic flow of a function',
    description:
      'Control-flow graph (flowchart) of one function: decisions with yes/no branches, loops with back edges, switch/match cases, try/catch/finally, early returns, throws, break/continue and unreachable code, plus cyclomatic complexity. Mermaid output can be shown to the user directly.',
    inputSchema: {
      path: z.string().describe('Source file path'),
      function: fnTarget,
      format: z.enum(['mermaid', 'text', 'both']).optional().describe('Default: both'),
    },
    cli: { command: 'flow', positional: ['path', 'function'], summary: 'Control-flow graph of a function (Mermaid + text)' },
    async run(ws, a) {
      const r = await ws.fn(str(a.path) ?? '', str(a.function) ?? num(a.function) ?? MODULE_SYMBOL);
      const f = str(a.format) ?? 'both';
      const parts: string[] = [];
      if (f !== 'mermaid') parts.push(flowText(r.flow));
      if (f !== 'text') parts.push('```mermaid\n' + flowToMermaid(r.flow) + '\n```');
      return parts.join('\n\n');
    },
  },
  {
    name: 'code_dataflow',
    title: 'Data flow of a function',
    description:
      'How values move inside one function: parameters → local variables → calls → return value, including fields written (this.x/self.x), collections mutated by method calls and loop iteration, with line numbers.',
    inputSchema: {
      path: z.string().describe('Source file path'),
      function: fnTarget,
      format: z.enum(['mermaid', 'text', 'both']).optional().describe('Default: both'),
    },
    cli: { command: 'dataflow', positional: ['path', 'function'], summary: 'Data flow of a function (Mermaid + text)' },
    async run(ws, a) {
      const r = await ws.fn(str(a.path) ?? '', str(a.function) ?? num(a.function) ?? MODULE_SYMBOL);
      const f = str(a.format) ?? 'both';
      const parts: string[] = [];
      if (f !== 'mermaid') parts.push(dataFlowText(r.data));
      if (f !== 'text') parts.push('```mermaid\n' + dataFlowToMermaid(r.data) + '\n```');
      return parts.join('\n\n');
    },
  },
  {
    name: 'call_graph',
    title: 'Call graph',
    description:
      'Who calls whom across files and folders. Calls are resolved through this/self, same-file definitions and imports. Use focus to see the callers/callees of one function within N hops.',
    inputSchema: {
      paths: z.array(z.string()).optional().describe('Files and/or folders to analyse (default: workspace root)'),
      focus: z.string().optional().describe('Function to centre on: "name", "Class.method" or "path#symbolId"'),
      direction: z.enum(['callees', 'callers', 'both']).optional(),
      depth: z.number().int().min(1).max(10).optional().describe('Hops from the focus (default 2)'),
      externals: z.boolean().optional().describe('Include calls into libraries/unknown code'),
      format: z.enum(['text', 'mermaid']).optional(),
    },
    cli: { command: 'calls', positional: ['paths'], summary: 'Call graph across files/folders' },
    async run(ws, a) {
      const paths = list(a.paths)?.length ? list(a.paths)! : ['.'];
      const focus = str(a.focus);
      let focusId: string | undefined;
      if (focus) {
        const full = await ws.callGraph(paths, { externals: false });
        focusId =
          full.nodes.find((n) => n.id === focus)?.id ??
          full.nodes.find((n) => `${n.container ? n.container + '.' : ''}${n.name}` === focus)?.id ??
          full.nodes.find((n) => n.name === focus)?.id;
        if (!focusId) throw new PathError(`No function named "${focus}" in the analysed files.`);
      }
      const direction = str(a.direction) as 'callees' | 'callers' | 'both' | undefined;
      const g = await ws.callGraph(paths, { externals: bool(a.externals), focus: focusId, direction, depth: num(a.depth), maxNodes: 400 });
      return str(a.format) === 'mermaid' ? '```mermaid\n' + callGraphToMermaid(g) + '\n```' : callGraphText(g);
    },
  },
  {
    name: 'dependency_graph',
    title: 'Import / dependency graph',
    description:
      "Module dependency graph of a folder: resolved imports between files (tsconfig paths, workspaces, Python packages, go.mod, Java/C# packages, C includes, Rust modules…), import cycles, most-imported files, fan-out and external packages. Use focus for one file's imports and importers; level=folder for an architecture-level view.",
    inputSchema: {
      path: z.string().optional().describe('Folder (default: workspace root)'),
      focus: z.string().optional().describe('File to show imports/importers for'),
      level: z.enum(['file', 'folder']).optional(),
      folderDepth: z.number().int().min(1).max(6).optional().describe('Folder level for level=folder (default 2)'),
      externals: z.boolean().optional().describe('Include external packages (default true)'),
      format: z.enum(['text', 'mermaid']).optional(),
    },
    cli: { command: 'deps', positional: ['path'], summary: 'Import graph: cycles, hubs, external packages' },
    async run(ws, a) {
      let g = await ws.deps(str(a.path) ?? '.', { externals: bool(a.externals) ?? true });
      if (str(a.level) === 'folder') g = aggregateByFolder(g, num(a.folderDepth) ?? 2);
      return str(a.format) === 'mermaid' ? '```mermaid\n' + depsToMermaid(g) + '\n```' : depsText(g, { focus: str(a.focus) });
    },
  },
  {
    name: 'find_symbol',
    title: 'Find symbol definitions',
    description: 'Finds where functions, classes, methods, types and constants are defined across the workspace (by full or partial name), with file paths, line ranges and signatures.',
    inputSchema: {
      query: z.string().describe('Name or part of a name'),
      path: z.string().optional().describe('Limit to a folder'),
      kinds: z.array(z.string()).optional().describe('e.g. ["class","function","method"]'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    cli: { command: 'find', positional: ['query', 'path'], summary: 'Find where symbols are defined' },
    async run(ws, a) {
      const query = str(a.query) ?? '';
      const hits = await ws.findSymbols(query, { dir: str(a.path), kinds: list(a.kinds), limit: num(a.limit) ?? 30 });
      if (!hits.length) return `No symbols matching "${query}".`;
      return hits.map(({ path, symbol: s }) => `${path}:${s.range.start.line + 1}  ${s.kind} ${s.id}${s.signature ?? ''}${s.doc ? `  — ${s.doc}` : ''}`).join('\n');
    },
  },
  {
    name: 'open_visualizer',
    title: 'Show an interactive diagram',
    description:
      'Opens the interactive StructLens visualizer for the user: inside their VS Code window when the extension is running, otherwise in the browser. Views — data files: graph, tree, table, schema; code files: structure, flow, dataflow, calls; folders: tree, treemap, graph, deps, stats.',
    inputSchema: {
      path: z.string().describe('File or folder to show'),
      view: z.enum(viewNames).optional(),
      function: z.string().optional().describe('Code: function to focus (name or Class.method)'),
    },
    async run(ws, a, ctx) {
      const abs = ws.resolvePath(str(a.path) ?? '.');
      if (!ctx.openVisualizer) return 'Opening visualizations is not available in this mode.';
      const fn = str(a.function);
      let symbol: string | undefined;
      if (fn && isCodeFile(abs)) {
        const o = await ws.outline(abs);
        symbol = flattenSymbols(o.symbols).find((s) => s.id === fn || s.name === fn)?.id ?? fn;
      }
      return ctx.openVisualizer({ path: abs, view: str(a.view), symbol });
    },
  },
];

export function toolErrorMessage(e: unknown): string {
  return e instanceof PathError || e instanceof QueryError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`;
}
