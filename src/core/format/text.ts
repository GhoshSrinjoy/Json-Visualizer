/**
 * Compact text renderers. These are what AI agents read through the MCP
 * server and the CLI, so they favour density: one line per node, counts
 * instead of repetition, and explicit truncation markers.
 */

import { CALLABLE_KINDS, type CallGraph, type CodeOutline, type CodeSymbol, type DataFlowGraph, type FlowGraph } from '../code/model';
import { DataTree, F_SYNTHETIC, T_STRING } from '../data/tree';
import type { DepGraph } from '../repo/deps';
import { K_DIR, repoChildren, repoPath, type RepoModel } from '../repo/model';
import { formatBytes, formatCount, oneLine, plural, withCommas } from '../util/strings';

// ---------------------------------------------------------------- repository

export interface RepoTreeOptions {
  depth?: number;
  /** Children shown per directory before collapsing (default 40). */
  maxChildren?: number;
  dirsOnly?: boolean;
  /** Start at this entry (default root). */
  from?: number;
  showLines?: boolean;
  showSize?: boolean;
}

function dirStats(repo: RepoModel, id: number, opts: RepoTreeOptions): string {
  const parts = [plural(repo.files[id], 'file')];
  if (opts.showLines !== false && repo.lines[id] > 0) parts.push(`${formatCount(repo.lines[id])} lines`);
  if (opts.showSize) parts.push(formatBytes(repo.size[id]));
  return parts.join(', ');
}

export function repoTreeText(repo: RepoModel, opts: RepoTreeOptions = {}): string {
  const depth = opts.depth ?? 3;
  const maxChildren = opts.maxChildren ?? 40;
  const start = opts.from ?? 0;
  const incomplete = new Set(repo.incomplete);
  const lines: string[] = [];
  const rootName = start === 0 ? repo.name : repoPath(repo, start);
  lines.push(`${rootName}/  (${dirStats(repo, start, opts)})${start === 0 ? languageSummary(repo, 4) : ''}`);
  const walk = (id: number, prefix: string, d: number) => {
    let kids = repoChildren(repo, id);
    if (opts.dirsOnly) kids = kids.filter((k) => repo.kind[k] === K_DIR);
    const shown = kids.slice(0, maxChildren);
    shown.forEach((k, i) => {
      const last = i === shown.length - 1 && kids.length <= maxChildren;
      const branch = last ? '└── ' : '├── ';
      if (repo.kind[k] === K_DIR) {
        lines.push(`${prefix}${branch}${repo.names[k]}/  (${dirStats(repo, k, opts)})${incomplete.has(k) ? ' [not scanned]' : ''}`);
        if (d + 1 < depth) walk(k, prefix + (last ? '    ' : '│   '), d + 1);
      } else {
        const meta: string[] = [];
        if (opts.showLines !== false && repo.lines[k] > 0) meta.push(`${withCommas(repo.lines[k])} lines`);
        if (opts.showSize || repo.lines[k] <= 0) meta.push(formatBytes(repo.size[k]));
        lines.push(`${prefix}${branch}${repo.names[k]}${meta.length ? `  ${meta.join(', ')}` : ''}`);
      }
    });
    if (kids.length > maxChildren) {
      const rest = kids.slice(maxChildren);
      const files = rest.reduce((s, k) => s + repo.files[k], 0);
      lines.push(`${prefix}└── … ${rest.length} more entries (${plural(files, 'file')})`);
    }
  };
  walk(start, '', 0);
  if (repo.stats.truncated) lines.push(`(scan stopped at ${withCommas(repo.stats.files)} files — raise maxFiles to see everything)`);
  return lines.join('\n');
}

function languageSummary(repo: RepoModel, n: number): string {
  const code = repo.languages.filter((l) => l.category !== 'binary' && l.category !== 'asset' && l.id !== 'other' && l.id !== 'lock');
  const total = code.reduce((s, l) => s + (l.lines || 0), 0);
  if (!total) return '';
  const top = [...code].sort((a, b) => b.lines - a.lines).slice(0, n).filter((l) => l.lines > 0);
  return ' — ' + top.map((l) => `${l.name} ${Math.round((l.lines / total) * 100)}%`).join(', ');
}

export function repoSummaryText(repo: RepoModel, top = 10): string {
  const s = repo.stats;
  const out = [
    `${repo.name}: ${plural(s.files, 'file')} in ${plural(s.dirs, 'folder')}, ${withCommas(s.lines)} lines, ${formatBytes(s.bytes)}` +
      `${s.ignored ? `, ${withCommas(s.ignored)} ignored` : ''}${s.truncated ? ' (truncated)' : ''}`,
    '',
    'Languages (by lines):',
  ];
  const langs = [...repo.languages].sort((a, b) => b.lines - a.lines || b.bytes - a.bytes).slice(0, 15);
  for (const l of langs) out.push(`  ${l.name.padEnd(18)} ${String(l.files).padStart(6)} files ${withCommas(l.lines).padStart(10)} lines ${formatBytes(l.bytes).padStart(10)}`);
  const files: number[] = [];
  for (let i = 0; i < repo.names.length; i++) if (repo.kind[i] !== K_DIR) files.push(i);
  out.push('', `Largest files (by lines):`);
  for (const f of [...files].sort((a, b) => repo.lines[b] - repo.lines[a]).slice(0, top)) {
    if (repo.lines[f] <= 0) break;
    out.push(`  ${withCommas(repo.lines[f]).padStart(8)}  ${repoPath(repo, f)}`);
  }
  const keyFiles = files.map((f) => repoPath(repo, f)).filter((p) => KEY_FILES.test(p));
  if (keyFiles.length) out.push('', 'Key files:', ...keyFiles.slice(0, 25).map((p) => `  ${p}`));
  return out.join('\n');
}

const KEY_FILES = /^(?:[^/]+\/)?(package\.json|tsconfig\.json|pyproject\.toml|setup\.py|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|Makefile|CMakeLists\.txt|Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/[^/]+|README(\.\w+)?|CLAUDE\.md|AGENTS\.md|[^/]+\.sln|[^/]+\.csproj)$/i;

// ---------------------------------------------------------------- data

export interface DataTreeTextOptions {
  depth?: number;
  maxChildren?: number;
  maxValue?: number;
  from?: number;
  /** Total line budget. */
  maxLines?: number;
}

/** Indented outline of a data tree with types, counts and value previews. */
export function dataTreeText(tree: DataTree, opts: DataTreeTextOptions = {}): string {
  const depth = opts.depth ?? 4;
  const maxChildren = opts.maxChildren ?? 25;
  const maxValue = opts.maxValue ?? 60;
  const maxLines = opts.maxLines ?? 400;
  const start = opts.from ?? tree.root;
  const out: string[] = [];
  const label = (id: number): string => {
    const t = tree.typeName(id);
    if (t === 'object') return `{${tree.childCount[id]}}`;
    if (t === 'array') return `[${withCommas(tree.childCount[id])}]`;
    if (tree.type[id] === T_STRING) return JSON.stringify(oneLine(tree.stringValue(id), maxValue));
    return tree.preview(id, maxValue);
  };
  const keyOf = (id: number) => {
    const k = tree.key(id);
    return k === null ? '$' : typeof k === 'number' ? `[${k}]` : k;
  };
  const head = start === tree.root ? '$' : tree.pathString(start);
  out.push(`${head} ${label(start)}${tree.flags[start] & F_SYNTHETIC ? ' (document list)' : ''}`);
  const walk = (id: number, prefix: string, d: number) => {
    const n = tree.childCount[id];
    const kids = tree.children(id, 0, maxChildren);
    kids.forEach((c, i) => {
      if (out.length >= maxLines) return;
      const last = i === kids.length - 1 && n <= maxChildren;
      out.push(`${prefix}${last ? '└─ ' : '├─ '}${keyOf(c)}: ${label(c)}`);
      if (tree.isContainer(c) && d + 1 < depth && tree.childCount[c] > 0) walk(c, prefix + (last ? '   ' : '│  '), d + 1);
    });
    if (n > maxChildren && out.length < maxLines) out.push(`${prefix}└─ … ${withCommas(n - maxChildren)} more`);
  };
  if (tree.isContainer(start)) walk(start, '', 0);
  if (out.length >= maxLines) out.push(`… (output truncated at ${maxLines} lines; narrow with a path or lower depth)`);
  return out.join('\n');
}

export function dataSummaryText(tree: DataTree, name: string): string {
  const c = tree.typeCounts();
  const parts = Object.entries(c).filter(([k, v]) => v > 0 && k !== 'unknown').map(([k, v]) => `${withCommas(v)} ${k}`);
  const errs = tree.errors.length ? `\n${plural(tree.errors.length, 'parse error')}: ${tree.errors.slice(0, 5).map((e) => `L${e.line}:${e.col} ${e.message}`).join('; ')}` : '';
  return `${name}: ${tree.format.toUpperCase()}, ${formatBytes(tree.text.length)}, ${withCommas(tree.nodeCount())} values (${parts.join(', ')}), max depth ${tree.maxDepth}, parsed in ${Math.round(tree.parseMs)} ms${errs}`;
}

/** Path + compact JSON value lines for query/search hits (numbers keep every digit of the source). */
export function dataMatchesText(tree: DataTree, ids: number[], total: number, maxValueChars = 300): string {
  const out = [`${plural(total, 'match', 'matches')}${total > ids.length ? ` (showing ${ids.length})` : ''}`];
  for (const id of ids) {
    const loc = tree.hasPosition(id) ? ` (L${tree.lineCol(tree.start(id)).line + 1})` : '';
    const { text, truncated } = tree.jsonText(id, undefined, maxValueChars);
    out.push(`${tree.pathString(id)}${loc}: ${truncated ? text + '…' : text}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- code

function lineRange(s: CodeSymbol): string {
  const a = s.range.start.line + 1;
  const b = s.range.end.line + 1;
  return a === b ? `L${a}` : `L${a}-${b}`;
}

export function outlineText(o: CodeOutline, opts: { maxDepth?: number; showCalls?: boolean } = {}): string {
  const out = [`${o.path} — ${o.languageName}, ${withCommas(o.lines)} lines (${withCommas(o.loc)} code)${o.syntaxErrors ? `, ${o.syntaxErrors} syntax errors` : ''}${o.approximate ? ' [approximate outline]' : ''}`];
  if (o.imports.length) {
    out.push(`imports (${o.imports.length}):`);
    for (const i of o.imports.slice(0, 60)) {
      const names = i.names.filter((n) => n.name !== '*' || n.alias).map((n) => (n.alias && n.alias !== n.name ? `${n.name === 'default' ? '' : n.name + ' as '}${n.alias}` : n.name));
      out.push(`  ${i.source}${names.length ? ` { ${names.join(', ')} }` : ''}${i.kind !== 'import' ? ` [${i.kind}]` : ''}`);
    }
    if (o.imports.length > 60) out.push(`  … ${o.imports.length - 60} more`);
  }
  if (o.exports.length) out.push(`exports: ${o.exports.slice(0, 40).join(', ')}${o.exports.length > 40 ? ', …' : ''}`);
  out.push('symbols:');
  const maxDepth = opts.maxDepth ?? 4;
  const walk = (syms: CodeSymbol[], indent: string, d: number) => {
    for (const s of syms) {
      const mods = s.modifiers?.length ? `${s.modifiers.join(' ')} ` : '';
      const bases = s.bases?.length ? ` : ${s.bases.join(', ')}` : '';
      const sig = s.signature ?? (s.detail ? ` — ${s.detail}` : '');
      const cx = s.complexity && s.complexity > 1 ? ` cx=${s.complexity}` : '';
      out.push(`${indent}${mods}${s.kind} ${s.name}${sig}${bases}  [${lineRange(s)}]${cx}`);
      if (s.doc) out.push(`${indent}  "${s.doc}"`);
      if (opts.showCalls && s.calls?.length) {
        const names = [...new Set(s.calls.map((c) => (c.receiver ? `${c.receiver}.${c.name}` : c.name)))];
        out.push(`${indent}  calls: ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', …' : ''}`);
      }
      if (s.children?.length && d + 1 < maxDepth) walk(s.children, indent + '  ', d + 1);
    }
  };
  walk(o.symbols, '  ', 0);
  return out.join('\n');
}

/** Structured, line-referenced description of a control-flow graph. */
export function flowText(g: FlowGraph): string {
  const out = [`flow of ${g.name}${g.signature ?? ''} — ${g.nodes.length} nodes, ${g.edges.length} edges, cyclomatic complexity ${g.complexity}`];
  const outs = new Map<number, typeof g.edges>();
  for (const e of g.edges) {
    const l = outs.get(e.from);
    if (l) l.push(e);
    else outs.set(e.from, [e]);
  }
  for (const n of g.nodes) {
    const loc = n.range ? `L${n.range.start.line + 1}` : '';
    const body = n.lines && n.lines.length > 1 ? n.lines.join(' ⏎ ') : n.label;
    const tag = n.unreachable ? ' (unreachable)' : '';
    const next = (outs.get(n.id) ?? []).map((e) => `${e.label ? `${e.label}→` : ''}#${e.to}${e.kind === 'back' || e.kind === 'continue' ? '↺' : e.kind === 'exception' ? '⚡' : ''}`).join(', ');
    out.push(`#${n.id} ${n.kind}${loc ? ` ${loc}` : ''}: ${oneLine(body, 160)}${tag}${next ? `  ⇒ ${next}` : ''}`);
  }
  return out.join('\n');
}

export function dataFlowText(g: DataFlowGraph): string {
  const label = new Map(g.nodes.map((n) => [n.id, n.label]));
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const params = g.nodes.filter((n) => n.kind === 'param').map((n) => n.label);
  const out = [`data flow of ${g.name}: ${plural(g.nodes.length, 'node')}, ${plural(g.edges.length, 'edge')}`, `inputs: ${params.join(', ') || '(none)'}`];
  const sorted = [...g.edges].sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
  for (const e of sorted) {
    const lines = e.lines.map((l) => l + 1).join(',');
    const verb = e.kind === 'mutate' ? 'mutates' : e.kind === 'iterate' ? 'iterates into' : e.kind === 'arg' ? 'passed to' : e.kind === 'return' ? 'returned' : 'flows to';
    out.push(`  ${label.get(e.from)} (${kind.get(e.from)}) ${verb} ${e.kind === 'return' ? '' : `${label.get(e.to)} (${kind.get(e.to)})`}  [L${lines}]`.replace(/\s+\[/, ' ['));
  }
  const sinks = g.nodes.filter((n) => n.kind === 'call' && !g.edges.some((e) => e.from === n.id)).map((n) => n.label);
  if (sinks.length) out.push(`side-effect calls: ${sinks.join(', ')}`);
  return out.join('\n');
}

export function callGraphText(g: CallGraph, maxNodes = 150): string {
  const out = [`call graph: ${plural(g.nodes.filter((n) => n.kind !== 'external').length, 'function')}, ${plural(g.edges.length, 'call edge')} across ${plural(g.files.length, 'file')}`];
  if (g.truncated) out.push(`note: only the first ${plural(g.files.length, 'file')} were analysed; narrow the paths (or use focus) for the rest`);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const name = (id: string, fromFile?: string) => {
    const n = byId.get(id);
    if (!n) return id;
    const q = n.container ? `${n.container}.${n.name}` : n.name;
    return n.file && n.file !== fromFile ? `${q} (${n.file})` : q;
  };
  const outs = new Map<string, string[]>();
  for (const e of g.edges) {
    const l = outs.get(e.from);
    const s = `${name(e.to, byId.get(e.from)?.file)}${e.count > 1 ? ` ×${e.count}` : ''}${e.confidence !== 'exact' ? ` (${e.confidence})` : ''}`;
    if (l) l.push(s);
    else outs.set(e.from, [s]);
  }
  const files = [...new Set(g.nodes.map((n) => n.file).filter((f): f is string => !!f))];
  let shown = 0;
  for (const f of files) {
    const fnodes = g.nodes.filter((n) => n.file === f && CALLABLE_KINDS.has(n.kind as never));
    if (!fnodes.length) continue;
    out.push(f);
    for (const n of fnodes) {
      if (shown++ >= maxNodes) break;
      const calls = outs.get(n.id);
      out.push(`  ${n.container ? `${n.container}.` : ''}${n.name} [L${(n.line ?? 0) + 1}]${n.callers ? ` ← ${n.callers}` : ''}${calls ? ` → ${calls.join(', ')}` : ''}`);
    }
  }
  if (shown > maxNodes) out.push(`… ${shown - maxNodes} more functions`);
  const hot = [...g.nodes].filter((n) => n.callers > 1).sort((a, b) => b.callers - a.callers).slice(0, 10);
  if (hot.length) out.push('most called: ' + hot.map((n) => `${name(n.id)} (${n.callers})`).join(', '));
  return out.join('\n');
}

export function depsText(g: DepGraph, opts: { focus?: string; top?: number } = {}): string {
  const top = opts.top ?? 12;
  const s = g.stats;
  const out = [`dependency graph: ${plural(s.files, 'file')} with imports, ${plural(s.edges, 'edge')}, ${plural(s.externals, 'external package')}, ${s.unresolved} unresolved (scanned ${s.scanned} files in ${s.durationMs} ms)`];
  const label = (id: number) => g.nodes[id].path;
  if (opts.focus) {
    const f = g.nodes.find((n) => n.path === opts.focus || n.path.endsWith('/' + opts.focus));
    if (f) {
      const imports = g.edges.filter((e) => e.from === f.id).map((e) => label(e.to));
      const importedBy = g.edges.filter((e) => e.to === f.id).map((e) => label(e.from));
      out.push('', `${f.path}`, `  imports (${imports.length}): ${imports.join(', ') || '—'}`, `  imported by (${importedBy.length}): ${importedBy.join(', ') || '—'}`);
    } else out.push('', `(no file matching "${opts.focus}" has import edges)`);
  }
  if (g.cycles.length) {
    out.push('', `import cycles (${g.cycles.length}):`);
    for (const c of g.cycles.slice(0, 10)) out.push(`  ${c.map(label).join(' ⇄ ')}`);
  }
  const internal = g.nodes.filter((n) => n.kind !== 'external');
  out.push('', 'most imported (fan-in):');
  for (const n of [...internal].sort((a, b) => b.fanIn - a.fanIn).slice(0, top)) if (n.fanIn) out.push(`  ${String(n.fanIn).padStart(4)}  ${n.path}`);
  out.push('', 'most dependencies (fan-out):');
  for (const n of [...internal].sort((a, b) => b.fanOut - a.fanOut).slice(0, top)) if (n.fanOut) out.push(`  ${String(n.fanOut).padStart(4)}  ${n.path}`);
  const ext = g.nodes.filter((n) => n.kind === 'external').sort((a, b) => b.fanIn - a.fanIn);
  if (ext.length) {
    out.push('', 'external packages (used by N files):');
    out.push('  ' + ext.slice(0, 40).map((n) => `${n.path} (${n.fanIn})`).join(', ') + (ext.length > 40 ? ', …' : ''));
  }
  const orphans = internal.filter((n) => n.kind === 'file' && n.fanIn === 0 && n.fanOut > 0).length;
  if (orphans) out.push('', `${orphans} files are imported by nothing (entry points, scripts or dead code).`);
  return out.join('\n');
}
