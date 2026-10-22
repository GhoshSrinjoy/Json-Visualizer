/**
 * High-level, cached operations over a workspace on disk. Shared by the MCP
 * server, the CLI and the VS Code extension so every surface returns the same
 * structures. All paths are confined to the configured roots.
 */

import { existsSync, promises as fsp } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCode, analyzeFunction, findByName, flattenSymbols, MODULE_SYMBOL, type FunctionAnalysis } from '../core/code/analyze';
import { buildCallGraph, type CallGraphOptions, type ImportTargets } from '../core/code/callgraph';
import type { CallGraph, CodeOutline, CodeSymbol } from '../core/code/model';
import { languageFor } from '../core/code/registry';
import { configureTreeSitter, isTreeSitterConfigured } from '../core/code/treesitter';
import { decodeText, detectFormat, isBinaryFormat, parseData } from '../core/data/formats';
import { xlsxToJson } from '../core/data/xlsx';
import type { DataFormat, DataTree } from '../core/data/tree';
import { buildDependencyGraph, familyOf, type DepGraph, type DepOptions } from '../core/repo/deps';
import { K_DIR, K_FILE, K_LINK, repoIndex, repoPaths, type RepoModel } from '../core/repo/model';
import { scanRepo, type FsAdapter, type ScanOptions } from '../core/repo/scan';
import { nodeFs, wasmFromDir } from './fs';
import { isWithin, pathKey, realpathNearest, relativeTo } from './paths';

export class PathError extends Error {}

/** Locates the bundled tree-sitter wasm directory (dist build, or node_modules in dev). */
export function findWasmDir(base: string = __dirname): string | undefined {
  const candidates = [
    join(base, 'wasm'),
    join(base, '..', 'wasm'),
    join(base, '..', 'dist', 'wasm'),
    join(base, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
    join(base, '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
    join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
  ];
  return candidates.find((d) => existsSync(join(d, 'tree-sitter.wasm')));
}

export function ensureTreeSitter(wasmDir = findWasmDir()): boolean {
  if (isTreeSitterConfigured()) return true;
  if (!wasmDir) return false;
  configureTreeSitter(wasmFromDir(wasmDir));
  return true;
}

export interface WorkspaceOptions {
  scan?: ScanOptions;
  /** Re-scan the repository after this many ms (default 15 s). */
  scanTtlMs?: number;
  /** Largest data file parsed (default 512 MB). */
  maxDataBytes?: number;
}

interface CachedTree {
  mtime: number;
  size: number;
  tree: DataTree;
}

export class Workspace {
  roots: string[];
  /** The roots with links, short names and letter case resolved (computed on first use). */
  private realRoots: string[] | undefined;
  private repoCache = new Map<string, { at: number; repo: Promise<RepoModel> }>();
  private depsCache = new Map<string, { at: number; graph: Promise<DepGraph> }>();
  private trees = new Map<string, CachedTree>();

  constructor(
    roots: string | string[],
    readonly options: WorkspaceOptions = {},
  ) {
    this.roots = (Array.isArray(roots) ? roots : [roots]).map((r) => resolve(r));
    ensureTreeSitter();
  }

  get root(): string {
    return this.roots[0];
  }

  /** Replaces the roots (e.g. with the MCP client's workspace folders). */
  setRoots(roots: string[]): void {
    if (!roots.length) return;
    this.roots = roots.map((r) => resolve(r));
    this.invalidate();
  }

  /**
   * Absolute path for a user-supplied path (relative to the first root, absolute, or a file:// URL),
   * confined to the workspace roots. Symbolic links and junctions are followed: a path whose real
   * location is outside every root is rejected even when it is spelled as a path inside one.
   */
  resolvePath(p = '.'): string {
    let raw = p.trim();
    if (/^file:/i.test(raw)) {
      try {
        raw = fileURLToPath(raw);
      } catch {
        throw new PathError(`Not a local file URL: ${p}`);
      }
    }
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw || '.');
    const lexical = this.roots.some((r) => isWithin(abs, r));
    const real = realpathNearest(abs);
    const realRoots = (this.realRoots ??= this.roots.map(realpathNearest));
    const i = realRoots.findIndex((r) => isWithin(real, r));
    if (i < 0) {
      throw new PathError(
        lexical ? `Path is outside the workspace (through a symbolic link or junction): ${p}` : `Path is outside the workspace: ${p} (roots: ${this.roots.join(', ')})`,
      );
    }
    if (lexical) return abs;
    // The same place spelled differently (short names, a linked root…): express it under the root.
    const rel = relativeTo(realRoots[i], real);
    return rel === '.' ? this.roots[i] : join(this.roots[i], ...rel.split('/'));
  }

  /** Workspace-relative path with forward slashes. */
  rel(abs: string): string {
    return relativeTo(this.rootOf(abs), abs);
  }

  rootOf(abs: string): string {
    return this.roots.find((r) => isWithin(abs, r)) ?? this.root;
  }

  async isDirectory(abs: string): Promise<boolean> {
    try {
      return (await fsp.stat(abs)).isDirectory();
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<{ abs: string; text: string; size: number; mtime: number }> {
    const abs = this.resolvePath(path);
    const st = await fsp.stat(abs).catch(() => {
      throw new PathError(`File not found: ${path}`);
    });
    if (st.isDirectory()) throw new PathError(`Expected a file but got a directory: ${path}`);
    const max = this.options.maxDataBytes ?? 512 * 1024 * 1024;
    if (st.size > max) throw new PathError(`File is too large (${st.size} bytes > ${max})`);
    const bytes = await fsp.readFile(abs);
    return { abs, text: decodeText(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)), size: st.size, mtime: st.mtimeMs };
  }

  // ------------------------------------------------------------ repository

  async repo(dir = '.', force = false): Promise<RepoModel> {
    const abs = this.resolvePath(dir);
    const ttl = this.options.scanTtlMs ?? 15_000;
    const hit = this.repoCache.get(abs);
    if (hit && !force && Date.now() - hit.at < ttl) return hit.repo;
    const repo = scanRepo(abs, nodeFs, this.options.scan);
    this.repoCache.set(abs, { at: Date.now(), repo });
    repo.catch(() => this.repoCache.delete(abs));
    return repo;
  }

  async deps(dir = '.', options: DepOptions = {}, force = false): Promise<DepGraph> {
    const abs = this.resolvePath(dir);
    const key = `${abs}\0${options.externals ?? true}\0${options.under ?? ''}`;
    const ttl = this.options.scanTtlMs ?? 15_000;
    const hit = this.depsCache.get(key);
    if (hit && !force && Date.now() - hit.at < ttl) return hit.graph;
    const graph = this.repo(dir, force).then((repo) => buildDependencyGraph(repo, this.linkSafeFs(repo), options));
    this.depsCache.set(key, { at: Date.now(), graph });
    graph.catch(() => this.depsCache.delete(key));
    return graph;
  }

  invalidate(): void {
    this.realRoots = undefined;
    this.repoCache.clear();
    this.depsCache.clear();
    this.trees.clear();
  }

  /** File access for analyses of a scan: entries that are links are read only when they lead somewhere inside the roots. */
  private linkSafeFs(repo: RepoModel): FsAdapter {
    const paths = repoPaths(repo);
    const links = new Set<string>();
    for (let i = 0; i < paths.length; i++) if (repo.kind[i] === K_LINK) links.add(pathKey(join(repo.root, ...paths[i].split('/'))));
    if (!links.size) return nodeFs;
    return {
      ...nodeFs,
      readFile: async (p, maxBytes) => {
        if (links.has(pathKey(p))) this.resolvePath(p);
        return nodeFs.readFile(p, maxBytes);
      },
    };
  }

  // ------------------------------------------------------------ data files

  async data(path: string, format?: DataFormat): Promise<{ abs: string; tree: DataTree; format: DataFormat }> {
    const abs = this.resolvePath(path);
    const st = await fsp.stat(abs).catch(() => {
      throw new PathError(`File not found: ${path}`);
    });
    const cached = this.trees.get(abs);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size && (!format || cached.tree.format === format)) {
      return { abs, tree: cached.tree, format: cached.tree.format };
    }
    let fmt = format ?? detectFormat(abs);
    let text: string;
    if (isBinaryFormat(fmt)) {
      const max = this.options.maxDataBytes ?? 512 * 1024 * 1024;
      if (st.size > max) throw new PathError(`File is too large (${st.size} bytes > ${max})`);
      const bytes = await fsp.readFile(abs);
      text = await xlsxToJson(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), async (d) => new Uint8Array(inflateRawSync(d)));
    } else {
      text = (await this.readText(abs)).text;
      fmt = format ?? detectFormat(abs, undefined, text.slice(0, 64 * 1024));
    }
    if (!fmt) throw new PathError(`Not a recognised data file (JSON, YAML, XML, TOML, CSV, Excel, INI, .env…): ${path}`);
    const tree = parseData(text, fmt);
    this.trees.set(abs, { mtime: st.mtimeMs, size: st.size, tree });
    // Keep memory bounded: at most 4 parsed documents.
    while (this.trees.size > 4) this.trees.delete(this.trees.keys().next().value!);
    return { abs, tree, format: fmt };
  }

  // ------------------------------------------------------------ code

  async outline(path: string): Promise<CodeOutline> {
    const { abs, text } = await this.readText(path);
    const o = await analyzeCode(this.rel(abs), text);
    if (!o) throw new PathError(`Not a recognised source file: ${path}`);
    return o;
  }

  /** Flow + data flow of a function given by name, `Class.method`, line number or `<module>`. */
  async fn(path: string, target: string | number): Promise<FunctionAnalysis & { candidates?: string[] }> {
    const { abs, text } = await this.readText(path);
    const rel = this.rel(abs);
    const outline = await analyzeCode(rel, text);
    if (!outline) throw new PathError(`Not a recognised source file: ${path}`);
    let symbolId: string | undefined;
    let line: number | undefined;
    if (typeof target === 'number' || /^\d+$/.test(String(target))) line = Number(target) - 1;
    else if (target === MODULE_SYMBOL || target === 'module' || target === '') symbolId = MODULE_SYMBOL;
    else {
      const matches = findByName(outline.symbols, String(target));
      if (!matches.length) {
        const names = flattenSymbols(outline.symbols).filter((s) => s.hasBody).map((s) => s.id);
        throw new PathError(`No function "${target}" in ${rel}. Available: ${names.slice(0, 40).join(', ') || '(none)'}`);
      }
      symbolId = matches[0].id;
    }
    const r = await analyzeFunction(rel, text, { symbolId, line });
    if (!r) throw new PathError(`Could not analyse ${target} in ${rel} (flow analysis needs a supported language).`);
    return r;
  }

  /** Call graph over files and/or directories (directories are expanded to their code files). */
  async callGraph(paths: string[], options: CallGraphOptions & { maxFiles?: number } = {}): Promise<CallGraph> {
    const maxFiles = (options.maxFiles ??= 2000) + 1; // one file over the limit marks the CallGraph `truncated` (see buildCallGraph)
    const files: string[] = [];
    for (const p of paths.length ? paths : ['.']) {
      const abs = this.resolvePath(p);
      if (await this.isDirectory(abs)) {
        const repo = await this.repo(this.rel(abs) === '.' ? '.' : abs);
        const rels = repoPaths(repo);
        for (let i = 0; i < rels.length && files.length < maxFiles; i++) {
          if (repo.kind[i] === K_DIR || repo.size[i] > 1024 * 1024) continue;
          if (languageFor(rels[i])?.spec) files.push(join(abs, rels[i]));
        }
      } else files.push(abs);
    }
    const outlines = await Promise.all(
      files.slice(0, maxFiles).map(async (abs) => {
        try {
          return { path: this.rel(abs), outline: await this.outline(abs) };
        } catch {
          return undefined;
        }
      }),
    );
    const list = outlines.filter((x): x is { path: string; outline: CodeOutline } => !!x);
    const imports = await this.importTargets(list.map((l) => l.path));
    return buildCallGraph(list, imports, options);
  }

  /** Resolved import targets for files (via the dependency graph of their root). */
  private async importTargets(rels: string[]): Promise<ImportTargets> {
    const out: ImportTargets = new Map();
    if (!rels.length) return out;
    const graph = await this.deps('.', { externals: false }).catch(() => undefined);
    if (!graph) return out;
    const repo = await this.repo('.');
    const idx = repoIndex(repo);
    const paths = repoPaths(repo);
    const wanted = new Set(rels);
    for (const e of graph.edges) {
      const from = graph.nodes[e.from];
      if (!wanted.has(from.path)) continue;
      const to = graph.nodes[e.to];
      let targets: string[] = [];
      if (to.kind === 'file') targets = [to.path];
      else if (to.kind === 'dir') {
        // Package directories (Go, Java wildcards): every code file inside.
        const d = idx.get(to.path);
        if (d !== undefined) for (let c = d + 1; c < d + repo.subtree[d]; c++) if (repo.kind[c] !== K_DIR && familyOf(paths[c])) targets.push(paths[c]);
      }
      const list = out.get(from.path) ?? [];
      for (const line of e.lines) list.push({ line, files: targets });
      out.set(from.path, list);
    }
    return out;
  }

  /** Finds symbol definitions by (partial) name across code files, cheapest first. */
  async findSymbols(query: string, options: { dir?: string; kinds?: string[]; limit?: number } = {}): Promise<{ path: string; symbol: CodeSymbol }[]> {
    const limit = options.limit ?? 50;
    const repo = await this.repo(options.dir ?? '.');
    const base = this.resolvePath(options.dir ?? '.');
    const rels = repoPaths(repo);
    const needle = query.toLowerCase();
    const results: { path: string; symbol: CodeSymbol; score: number }[] = [];
    // Prefilter by a cheap text search, then parse candidates.
    const candidates: string[] = [];
    for (let i = 0; i < rels.length; i++) {
      // Links are not followed (like the scan itself): they could lead outside the workspace.
      if (repo.kind[i] !== K_FILE || repo.size[i] > 2 * 1024 * 1024 || !languageFor(rels[i])) continue;
      candidates.push(join(base, rels[i]));
    }
    const batch = 24;
    for (let k = 0; k < candidates.length && results.length < limit * 4; k += batch) {
      await Promise.all(
        candidates.slice(k, k + batch).map(async (abs) => {
          const text = await fsp.readFile(abs, 'utf8').catch(() => '');
          if (!text.toLowerCase().includes(needle)) return;
          const o = await analyzeCode(this.rel(abs), text);
          for (const s of flattenSymbols(o?.symbols ?? [])) {
            const n = s.name.toLowerCase();
            if (!n.includes(needle) && !s.id.toLowerCase().includes(needle)) continue;
            if (options.kinds?.length && !options.kinds.includes(s.kind)) continue;
            const score = n === needle ? 0 : n.startsWith(needle) ? 1 : 2;
            results.push({ path: this.rel(abs), symbol: s, score });
          }
        }),
      );
    }
    return results.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
}
