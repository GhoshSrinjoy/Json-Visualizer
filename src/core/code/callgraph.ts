/**
 * Cross-file call graph built from code outlines. Calls are resolved by
 * scope: `this`/`self` → enclosing class, then the same file, then files the
 * caller imports (from the dependency graph), then a unique global match.
 */

import { flattenSymbols } from './symbols';
import {
  CALLABLE_KINDS,
  CONTAINER_KINDS,
  type CallGraph,
  type CallGraphEdge,
  type CallGraphNode,
  type CallRef,
  type CodeOutline,
  type CodeSymbol,
} from './model';

export interface CallGraphFile {
  path: string;
  outline: CodeOutline;
}

/** Resolved imports of a file: import line -> target files. */
export type ImportTargets = Map<string, { line: number; files: string[] }[]>;

export interface CallGraphOptions {
  /** Add nodes for calls that resolve to nothing in the analysed files. */
  externals?: boolean;
  /** Centre the graph on this node id (`path#symbolId`) and keep `depth` hops. */
  focus?: string;
  depth?: number;
  direction?: 'callees' | 'callers' | 'both';
  /** Cap on nodes (largest fan-in/out kept). */
  maxNodes?: number;
  /**
   * Most files analysed. A caller that stops collecting files at the limit passes one file
   * more when there are more (the workspace does): that file is left out and the result is
   * marked `truncated`.
   */
  maxFiles?: number;
}

interface Entry {
  id: string;
  sym: CodeSymbol;
  file: string;
  container?: CodeSymbol;
  /** The language lets methods call each other without `this.` (bare `foo()` may be a method). */
  implicitThis: boolean;
}

const SELF = new Set(['this', 'self', '$this', 'cls', 'base', 'super', 'Self', 'static']);

/**
 * Languages where a bare `foo()` inside a class can call one of its methods. Python, JS/TS, Go,
 * Rust and PHP need `self.` / `this.` / `$this->` / a receiver, so there a bare name is a function.
 */
const IMPLICIT_THIS = new Set(['java', 'csharp', 'cpp', 'ruby', 'kotlin', 'swift', 'scala', 'dart', 'groovy']);

/** Module name of a file: `models` for `app/models.py`, `app` for `app/__init__.py` or `app/index.ts`. */
function moduleName(path: string): string {
  const parts = path.split('/');
  const stem = parts[parts.length - 1].replace(/\.[^.]*$/, '');
  return /^(__init__|index|mod)$/.test(stem) && parts.length > 1 ? parts[parts.length - 2] : stem;
}

export function callGraphNodeId(path: string, symbolId: string): string {
  return `${path}#${symbolId}`;
}

export function buildCallGraph(all: CallGraphFile[], imports?: ImportTargets, options: CallGraphOptions = {}): CallGraph {
  const truncated = options.maxFiles !== undefined && all.length > options.maxFiles;
  const files = truncated ? all.slice(0, options.maxFiles) : all;
  const entries: Entry[] = [];
  const byName = new Map<string, Entry[]>();
  const byFileName = new Map<string, Map<string, Entry[]>>();
  const classesByName = new Map<string, Entry[]>();
  const parentOf = new Map<CodeSymbol, CodeSymbol>();

  for (const f of files) {
    const fileMap = new Map<string, Entry[]>();
    byFileName.set(f.path, fileMap);
    const implicitThis = IMPLICIT_THIS.has(f.outline.language);
    for (const s of flattenSymbols(f.outline.symbols)) for (const c of s.children ?? []) parentOf.set(c, s);
    for (const s of flattenSymbols(f.outline.symbols)) {
      const isCallable = CALLABLE_KINDS.has(s.kind);
      const isClass = s.kind === 'class' || s.kind === 'struct';
      if (!isCallable && !isClass) continue;
      const parent = parentOf.get(s);
      const container = parent && CONTAINER_KINDS.has(parent.kind) ? parent : undefined;
      const e: Entry = { id: callGraphNodeId(f.path, s.id), sym: s, file: f.path, container, implicitThis };
      entries.push(e);
      push(byName, s.name, e);
      push(fileMap, s.name, e);
      if (isClass) push(classesByName, s.name, e);
    }
  }
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const importedFiles = (path: string): Set<string> => new Set((imports?.get(path) ?? []).flatMap((i) => i.files));
  const outlineOf = new Map(files.map((f) => [f.path, f.outline]));
  /** Every file an import line resolves to (`from pkg import a, b` reaches the package and its modules). */
  const lineFiles = (path: string, line: number): string[] => [
    ...new Set((imports?.get(path) ?? []).filter((i) => i.line === line).flatMap((i) => i.files)),
  ];

  /** Files bound to an import alias such as `fs`, `np`, `util`, or a module from `from pkg import mod`. */
  const aliasFiles = (path: string, alias: string): string[] | undefined => {
    const o = outlineOf.get(path);
    if (!o) return undefined;
    for (const imp of o.imports) {
      const last = imp.source.split(/[/.\\:]/).filter(Boolean).pop();
      const named = imp.names.find((n) => (n.alias ?? (n.name === '*' || n.name === 'default' ? undefined : n.name)) === alias);
      if (!named && !(last === alias && imp.names.every((n) => !n.alias))) continue;
      const found = lineFiles(path, imp.line);
      // `from app import models`: the name is the module `app/models.py`, not the package.
      const module = named ? found.filter((f) => moduleName(f) === named.name.split('.').pop()) : [];
      return module.length ? module : found;
    }
    return undefined;
  };

  /** Files a bare name comes from: a named/default import binding, or star imports. */
  const bindingFiles = (path: string, name: string): { files: string[]; original: string; star: boolean } | undefined => {
    const o = outlineOf.get(path);
    if (!o) return undefined;
    for (const imp of o.imports) {
      const n = imp.names.find((x) => (x.alias ?? x.name) === name && x.name !== '*');
      if (!n) continue;
      return { files: lineFiles(path, imp.line), original: n.name === 'default' ? name : n.name, star: false };
    }
    const star = o.imports.filter((imp) => imp.names.some((x) => x.name === '*' && !x.alias));
    const files = star.flatMap((imp) => lineFiles(path, imp.line));
    return files.length ? { files, original: name, star: true } : undefined;
  };

  const methodsOf = (cls: CodeSymbol, name: string, file: string): Entry[] =>
    (cls.children ?? []).filter((c) => c.name === name && CALLABLE_KINDS.has(c.kind)).map((c) => entryById.get(callGraphNodeId(file, c.id))!).filter(Boolean);

  const resolve = (from: Entry, call: CallRef): { targets: Entry[]; confidence: CallGraphEdge['confidence'] } => {
    const name = call.name;
    const recv = call.receiver;
    const constructorOf = (cls: Entry) => {
      const ctor = (cls.sym.children ?? []).find((c) => c.kind === 'constructor');
      return ctor ? (entryById.get(callGraphNodeId(cls.file, ctor.id)) ?? cls) : cls;
    };
    // new X() / X{} / X(...) where X is a class
    if (call.kind === 'new' || (!recv && classesByName.has(name) && !byFileName.get(from.file)?.get(name)?.some((e) => CALLABLE_KINDS.has(e.sym.kind)))) {
      const classes = scoped(classesByName.get(name) ?? [], from.file, importedFiles(from.file));
      if (classes.targets.length) return { targets: classes.targets.map(constructorOf), confidence: classes.confidence };
    }
    // this.foo() / self.foo()
    if (recv && SELF.has(recv)) {
      if (from.container) {
        const own = methodsOf(from.container, name, from.file);
        if (own.length) return { targets: own, confidence: 'exact' };
        // Inherited: look at base classes declared in the analysed files.
        for (const base of from.container.bases ?? []) {
          for (const cls of classesByName.get(base.replace(/<.*$/, '')) ?? []) {
            const m = methodsOf(cls.sym, name, cls.file);
            if (m.length) return { targets: m, confidence: 'likely' };
          }
        }
      }
    }
    if (!recv) {
      // Nested function, same class (implicit this), same file, imports, global.
      const nested = (from.sym.children ?? []).filter((c) => c.name === name && CALLABLE_KINDS.has(c.kind));
      if (nested.length) return { targets: nested.map((c) => entryById.get(callGraphNodeId(from.file, c.id))!).filter(Boolean), confidence: 'exact' };
      if (from.container && from.implicitThis) {
        const own = methodsOf(from.container, name, from.file);
        if (own.length) return { targets: own, confidence: 'exact' };
      }
      const topLevel = (e: Entry) => CALLABLE_KINDS.has(e.sym.kind) && (!e.container || e.container.kind === 'module' || e.container.kind === 'namespace');
      const sameFile = (byFileName.get(from.file)?.get(name) ?? []).filter(topLevel);
      if (sameFile.length) return { targets: sameFile, confidence: 'exact' };
      const bound = bindingFiles(from.file, name);
      if (bound) {
        const hits = bound.files.flatMap((f) => (byFileName.get(f)?.get(bound.original) ?? []).filter(topLevel));
        if (hits.length || !bound.star) return { targets: hits, confidence: bound.star ? 'likely' : 'exact' };
      }
      // Not imported by name: a global, or something from an unresolved import.
      return scoped((byName.get(name) ?? []).filter(topLevel), from.file, new Set());
    }
    // Receiver is an import alias (`fs.read`, `np.array`, Go `util.Log`).
    const root = recv.split(/[.\[(]|->|::/)[0];
    const aliased = aliasFiles(from.file, root);
    if (aliased) {
      const hits = aliased.flatMap((f) => (byFileName.get(f)?.get(name) ?? []).filter((e) => CALLABLE_KINDS.has(e.sym.kind)));
      return { targets: hits, confidence: 'exact' };
    }
    // Static call on a known class (`User.create()`).
    const cls = classesByName.get(root);
    if (cls?.length) {
      const m = cls.flatMap((c) => methodsOf(c.sym, name, c.file));
      if (m.length) return { targets: m, confidence: 'likely' };
    }
    // Unique method name across all classes.
    const methods = (byName.get(name) ?? []).filter((e) => e.container && CALLABLE_KINDS.has(e.sym.kind));
    if (methods.length === 1) return { targets: methods, confidence: 'guess' };
    return { targets: [], confidence: 'guess' };
  };

  const edges = new Map<string, CallGraphEdge>();
  const externals = new Map<string, CallGraphNode>();
  for (const from of entries) {
    if (!CALLABLE_KINDS.has(from.sym.kind) || !from.sym.calls) continue;
    for (const call of from.sym.calls) {
      const { targets, confidence } = resolve(from, call);
      if (!targets.length) {
        if (!options.externals) continue;
        const label = call.receiver && !SELF.has(call.receiver) ? `${call.receiver}.${call.name}` : call.name;
        const id = `ext:${label}`;
        if (!externals.has(id)) externals.set(id, { id, name: label, kind: 'external', callers: 0 });
        addEdge(edges, from.id, id, 'exact');
        continue;
      }
      for (const t of targets) if (t.id !== from.id || targets.length === 1) addEdge(edges, from.id, t.id, confidence);
    }
  }

  let nodes: CallGraphNode[] = entries
    .filter((e) => CALLABLE_KINDS.has(e.sym.kind) || [...edges.values()].some((x) => x.to === e.id))
    .map((e) => ({
      id: e.id,
      name: e.sym.name,
      kind: e.sym.kind,
      file: e.file,
      container: e.container?.name,
      line: e.sym.range.start.line,
      callers: 0,
    }));
  nodes.push(...externals.values());
  let edgeList = [...edges.values()];

  if (options.focus) {
    const keep = reach(options.focus, edgeList, options.depth ?? 2, options.direction ?? 'both');
    nodes = nodes.filter((n) => keep.has(n.id));
    edgeList = edgeList.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  edgeList = edgeList.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  const inCount = new Map<string, number>();
  for (const e of edgeList) inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
  for (const n of nodes) n.callers = inCount.get(n.id) ?? 0;
  if (options.maxNodes && nodes.length > options.maxNodes) {
    const degree = new Map<string, number>();
    for (const e of edgeList) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    nodes = nodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, options.maxNodes);
    const keep = new Set(nodes.map((n) => n.id));
    edgeList = edgeList.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  const graph: CallGraph = { nodes, edges: edgeList, files: files.map((f) => f.path) };
  if (truncated) graph.truncated = true;
  return graph;
}

function scoped(candidates: Entry[], file: string, imported: Set<string>): { targets: Entry[]; confidence: CallGraphEdge['confidence'] } {
  if (!candidates.length) return { targets: [], confidence: 'guess' };
  const same = candidates.filter((e) => e.file === file);
  if (same.length) return { targets: same, confidence: 'exact' };
  const imp = candidates.filter((e) => imported.has(e.file));
  if (imp.length) return { targets: imp, confidence: 'exact' };
  if (candidates.length === 1) return { targets: candidates, confidence: 'likely' };
  // Ambiguous: prefer the closest directory, but only when it is unique.
  const dir = file.slice(0, file.lastIndexOf('/'));
  const near = candidates.filter((e) => e.file.startsWith(dir + '/') && !e.file.slice(dir.length + 1).includes('/'));
  if (near.length === 1) return { targets: near, confidence: 'guess' };
  return { targets: [], confidence: 'guess' };
}

function addEdge(edges: Map<string, CallGraphEdge>, from: string, to: string, confidence: CallGraphEdge['confidence']) {
  const key = `${from}>${to}`;
  const e = edges.get(key);
  if (e) e.count++;
  else edges.set(key, { from, to, count: 1, confidence });
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function reach(start: string, edges: CallGraphEdge[], depth: number, direction: 'callees' | 'callers' | 'both'): Set<string> {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of edges) {
    push(out, e.from, e.to);
    push(inc, e.to, e.from);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      const nbrs = [...(direction !== 'callers' ? (out.get(n) ?? []) : []), ...(direction !== 'callees' ? (inc.get(n) ?? []) : [])];
      for (const m of nbrs) {
        if (!seen.has(m)) {
          seen.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return seen;
}
