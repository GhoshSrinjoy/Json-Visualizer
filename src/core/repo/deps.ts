/**
 * Repository dependency graph: fast regex import extraction per language
 * family plus real module resolution (tsconfig paths, workspace packages,
 * Python package roots, go.mod, Java/C# package indexes, C/C++ include
 * search, Rust modules, PHP PSR-4…), cycle detection and folder rollups.
 */

import { parseJson } from '../data/json';
import { K_DIR, repoPaths, type RepoModel } from './model';
import type { FsAdapter } from './scan';

export type DepKind = 'import' | 'require' | 'include' | 'use' | 'dynamic' | 'export-from' | 'mod';

export interface RawImport {
  specifier: string;
  kind: DepKind;
  line: number;
  /** Imported names when cheap to get (Python `from x import a, b`). */
  names?: string[];
}

export interface DepNode {
  id: number;
  /** Relative path (files/dirs) or package name (externals). */
  path: string;
  kind: 'file' | 'dir' | 'external';
  /** Repo entry id for files/dirs. */
  entry?: number;
  lang?: string;
  /** Top-level folder, or the ecosystem for externals (npm, pypi, std…). */
  group: string;
  fanIn: number;
  fanOut: number;
}

export interface DepEdge {
  from: number;
  to: number;
  kind: DepKind;
  count: number;
  lines: number[];
}

export interface DepGraph {
  root: string;
  nodes: DepNode[];
  edges: DepEdge[];
  unresolved: { from: number; specifier: string; line: number }[];
  /** Strongly connected components with more than one node (import cycles). */
  cycles: number[][];
  stats: { files: number; scanned: number; edges: number; externals: number; unresolved: number; durationMs: number };
}

export interface DepOptions {
  /** Include external packages as nodes (default true). */
  externals?: boolean;
  /** Skip files larger than this (default 1 MB). */
  maxFileBytes?: number;
  concurrency?: number;
  /** Restrict to files under this relative directory. */
  under?: string;
  isCancelled?: () => boolean;
}

// ---------------------------------------------------------------- extraction

type Family = 'js' | 'py' | 'go' | 'jvm' | 'cs' | 'c' | 'rust' | 'ruby' | 'php' | 'css' | 'html' | 'dart' | 'swift' | 'lua';

const FAMILY_BY_EXT: Record<string, Family> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', pyi: 'py', go: 'go', java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm', groovy: 'jvm', cs: 'cs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', ino: 'c',
  rs: 'rust', rb: 'ruby', rake: 'ruby', php: 'php', css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', dart: 'dart', swift: 'swift', lua: 'lua',
};

export function familyOf(path: string): Family | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : FAMILY_BY_EXT[path.slice(dot + 1).toLowerCase()];
}

/** Replaces comments with spaces (keeping newlines) so regexes skip them. */
function stripComments(text: string, family: Family): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  switch (family) {
    case 'py':
    case 'ruby':
      return text.replace(/^[ \t]*#[^\n]*/gm, blank);
    case 'lua':
      return text.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, blank);
    case 'html':
      return text.replace(/<!--[\s\S]*?-->/g, blank);
    default:
      return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p: string) => p + blank(m.slice(p.length)));
  }
}

export function extractImports(text: string, path: string): RawImport[] {
  const family = familyOf(path);
  if (!family) return [];
  const src = stripComments(text, family);
  const lineStarts: number[] = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (idx: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: RawImport[] = [];
  const scan = (re: RegExp, kind: DepKind, group = 1, names?: (m: RegExpExecArray) => string[] | undefined) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const s = m[group]?.trim();
      if (s) out.push({ specifier: s, kind, line: lineOf(m.index), names: names?.(m) });
      if (m[0].length === 0) re.lastIndex++;
    }
  };

  switch (family) {
    case 'js':
      scan(/(?:^|[^.\w$])import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g, 'import');
      scan(/(?:^|[^.\w$])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+['"]([^'"\n]+)['"]/g, 'export-from');
      scan(/(?:^|[^.\w$])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, 'require');
      scan(/(?:^|[^.\w$])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, 'dynamic');
      break;
    case 'py':
      scan(/^[ \t]*import[ \t]+([^\n#]+)/gm, 'import');
      // Expand `import a, b as c` into separate imports.
      for (let i = out.length - 1; i >= 0; i--) {
        const parts = out[i].specifier.split(',').map((p) => p.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        out.splice(i, 1, ...parts.map((p) => ({ ...out[i], specifier: p })));
      }
      scan(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm, 'import', 1, (m) =>
        m[2].replace(/[()\\\n]/g, ' ').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter((n) => n && n !== '*'),
      );
      break;
    case 'go': {
      scan(/(?:^|\n)[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/g, 'import');
      const blocks = /(?:^|\n)[ \t]*import[ \t]*\(([\s\S]*?)\)/g;
      let b: RegExpExecArray | null;
      while ((b = blocks.exec(src))) {
        const base = b.index + b[0].indexOf('(');
        const inner = /"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = inner.exec(b[1]))) out.push({ specifier: m[1], kind: 'import', line: lineOf(base + m.index) });
      }
      break;
    }
    case 'jvm':
      scan(/^[ \t]*import[ \t]+(?:static[ \t]+)?(\w+(?:\.\w+)*(?:\.\*)?)/gm, 'import');
      break;
    case 'cs':
      scan(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm, 'use');
      break;
    case 'c':
      scan(/^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"][^>"\n]+[>"])/gm, 'include');
      break;
    case 'rust':
      scan(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm, 'mod');
      scan(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm, 'use');
      scan(/^[ \t]*extern[ \t]+crate[ \t]+(\w+)/gm, 'use');
      break;
    case 'ruby':
      scan(/^[ \t]*require_relative[ \t(]+['"]([^'"]+)['"]/gm, 'require');
      for (const r of out) r.specifier = `./${r.specifier.replace(/^\.\//, '')}`;
      scan(/^[ \t]*(?:require|load)[ \t(]+['"]([^'"]+)['"]/gm, 'require');
      break;
    case 'php':
      scan(/^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?([\w\\]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm, 'use');
      scan(/^[ \t]*use[ \t]+([\w\\]+)\\\{([^}]+)\}/gm, 'use', 1, (m) => m[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]));
      // Expand group use into one import per name.
      for (let i = out.length - 1; i >= 0; i--) {
        const r = out[i];
        if (r.names?.length) out.splice(i, 1, ...r.names.map((n) => ({ specifier: `${r.specifier}\\${n}`, kind: r.kind, line: r.line })));
      }
      scan(/(?:require|include)(?:_once)?[ \t]*\(?[ \t]*(?:__DIR__[ \t]*\.[ \t]*)?['"]([^'"]+\.php)['"]/g, 'require');
      break;
    case 'css':
      scan(/@import[ \t]+(?:url\()?['"]?([^'")\s;]+)/g, 'import');
      scan(/@(?:use|forward)[ \t]+['"]([^'"]+)['"]/g, 'use');
      break;
    case 'html':
      scan(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi, 'include');
      scan(/<link\b[^>]*\bhref=["']([^"']+\.css)["']/gi, 'include');
      break;
    case 'dart':
      scan(/^[ \t]*(?:import|export|part)[ \t]+['"]([^'"]+)['"]/gm, 'import');
      break;
    case 'swift':
      scan(/^[ \t]*import[ \t]+(?:class[ \t]+|struct[ \t]+|func[ \t]+)?(\w+)/gm, 'import');
      break;
    case 'lua':
      scan(/require[ \t]*\(?[ \t]*['"]([^'"]+)['"]/g, 'require');
      break;
  }
  return out;
}

// ---------------------------------------------------------------- resolution

type Resolution = { file: string } | { dir: string } | { external: string; group: string } | null;

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json'];
const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test'.split(' '),
);
const PY_STDLIB = new Set(
  'abc argparse array ast asyncio base64 bisect builtins collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib email enum functools gc glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json logging math multiprocessing operator os pathlib pickle platform pprint queue random re shutil signal socket sqlite3 ssl statistics string struct subprocess sys tempfile textwrap threading time timeit tkinter traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib __future__'.split(' '),
);

interface TsPaths {
  dir: string; // tsconfig directory
  baseUrl?: string; // relative to repo root
  paths: [string, string[]][];
}

class Resolver {
  readonly files = new Set<string>();
  readonly dirs = new Set<string>();
  readonly byBase = new Map<string, string[]>();
  tsConfigs: TsPaths[] = [];
  workspaces = new Map<string, { dir: string; entry?: string }>();
  goModules: [string, string][] = [];
  pyRoots: string[] = [''];
  jvmIndex = new Map<string, string>();
  jvmPackages = new Map<string, string>();
  csNamespaces = new Map<string, string[]>();
  psr4: [string, string][] = [];
  dartPackage?: string;
  crateDirs: string[] = [];

  constructor(paths: string[], kinds: number[]) {
    for (let i = 1; i < paths.length; i++) {
      if (kinds[i] === K_DIR) this.dirs.add(paths[i]);
      else {
        this.files.add(paths[i]);
        const base = paths[i].slice(paths[i].lastIndexOf('/') + 1);
        const list = this.byBase.get(base);
        if (list) list.push(paths[i]);
        else this.byBase.set(base, [paths[i]]);
      }
    }
    this.dirs.add('');
  }

  resolve(from: string, imp: RawImport): Resolution {
    switch (familyOf(from)) {
      case 'js':
        return this.js(from, imp.specifier);
      case 'py':
        return this.py(from, imp.specifier);
      case 'go':
        return this.go(imp.specifier);
      case 'jvm':
        return this.jvm(imp.specifier);
      case 'cs':
        return this.cs(imp.specifier);
      case 'c':
        return this.c(from, imp.specifier);
      case 'rust':
        return this.rust(from, imp);
      case 'ruby':
        return this.ruby(from, imp.specifier);
      case 'php':
        return this.php(from, imp);
      case 'css':
        return this.css(from, imp.specifier);
      case 'html':
        return /^(https?:)?\/\//.test(imp.specifier) ? null : this.fileWith(join(dirname(from), imp.specifier), ['']) ?? null;
      case 'dart':
        return this.dart(from, imp.specifier);
      case 'swift':
        return { external: imp.specifier, group: 'swift' };
      case 'lua':
        return this.fileWith(imp.specifier.replace(/\./g, '/'), ['.lua', '/init.lua']) ?? { external: imp.specifier.split('.')[0], group: 'lua' };
      default:
        return null;
    }
  }

  private fileWith(base: string, exts: string[]): { file: string } | undefined {
    for (const e of exts) {
      const p = normalize(base + e);
      if (this.files.has(p)) return { file: p };
    }
    return undefined;
  }

  private jsFile(base: string): { file: string } | undefined {
    const direct = this.fileWith(base, ['', ...JS_EXTS]);
    if (direct) return direct;
    // TS ESM: `./foo.js` written for `foo.ts`.
    const m = /\.(m|c)?jsx?$/.exec(base);
    if (m) {
      const stem = base.slice(0, -m[0].length);
      const alt = this.fileWith(stem, ['.ts', '.tsx', '.mts', '.cts', '.d.ts']);
      if (alt) return alt;
    }
    return this.fileWith(base, JS_EXTS.map((e) => `/index${e}`));
  }

  private js(from: string, spec: string): Resolution {
    const clean = spec.replace(/[?#].*$/, '');
    if (clean.startsWith('.') || clean.startsWith('/')) {
      return this.jsFile(clean.startsWith('/') ? clean.slice(1) : join(dirname(from), clean)) ?? null;
    }
    // tsconfig paths / baseUrl (nearest config first).
    const configs = this.tsConfigs.filter((c) => c.dir === '' || from.startsWith(c.dir + '/')).sort((a, b) => b.dir.length - a.dir.length);
    for (const c of configs) {
      for (const [pattern, targets] of c.paths) {
        const star = pattern.indexOf('*');
        let rest: string | undefined;
        if (star < 0) rest = pattern === clean ? '' : undefined;
        else if (clean.startsWith(pattern.slice(0, star)) && clean.endsWith(pattern.slice(star + 1))) rest = clean.slice(star, clean.length - (pattern.length - star - 1));
        if (rest === undefined) continue;
        for (const t of targets) {
          const hit = this.jsFile(join(c.baseUrl ?? c.dir, t.replace('*', rest)));
          if (hit) return hit;
        }
      }
      if (c.baseUrl !== undefined) {
        const hit = this.jsFile(join(c.baseUrl, clean));
        if (hit) return hit;
      }
    }
    // Common bundler aliases.
    if (clean.startsWith('@/') || clean.startsWith('~/')) {
      const hit = this.jsFile(join('src', clean.slice(2))) ?? this.jsFile(clean.slice(2));
      if (hit) return hit;
    }
    // Workspace packages.
    const pkgName = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0];
    const ws = this.workspaces.get(pkgName);
    if (ws) {
      const sub = clean.slice(pkgName.length + 1);
      if (!sub) {
        const entry = (ws.entry && this.jsFile(join(ws.dir, ws.entry))) || this.jsFile(join(ws.dir, 'src/index')) || this.jsFile(join(ws.dir, 'index'));
        return entry ?? { dir: ws.dir };
      }
      return this.jsFile(join(ws.dir, sub)) ?? this.jsFile(join(ws.dir, 'src', sub)) ?? { dir: ws.dir };
    }
    const builtin = clean.startsWith('node:') ? clean.slice(5) : clean.split('/')[0];
    if (clean.startsWith('node:') || NODE_BUILTINS.has(builtin)) return { external: `node:${builtin}`, group: 'node' };
    return { external: pkgName, group: 'npm' };
  }

  private pyModule(base: string, dotted: string): { file: string } | { dir: string } | undefined {
    const rel = dotted.replace(/\./g, '/');
    const p = base ? (rel ? `${base}/${rel}` : base) : rel;
    return this.fileWith(p, ['.py', '.pyi', '/__init__.py']) ?? (p && this.dirs.has(p) ? { dir: p } : undefined);
  }

  private py(from: string, spec: string): Resolution {
    const dots = /^\.*/.exec(spec)![0].length;
    const mod = spec.slice(dots);
    if (dots) {
      let base = dirname(from);
      for (let i = 1; i < dots; i++) base = dirname(base);
      if (!mod) return { dir: base };
      const direct = this.pyModule(base, mod);
      if (direct) return direct;
      // `from .pkg.mod import x` where `mod` is an attribute of `pkg`.
      return mod.includes('.') ? (this.pyModule(base, mod.split('.').slice(0, -1).join('.')) ?? null) : null;
    }
    const candidates = [dirname(from), ...this.pyRoots];
    for (const root of candidates) {
      const hit = this.pyModule(root, mod);
      if (hit) return hit;
    }
    // `import a.b.c` where c is an attribute: fall back to the deepest module.
    const parts = mod.split('.');
    for (let k = parts.length - 1; k >= 1; k--) {
      for (const root of this.pyRoots) {
        const hit = this.pyModule(root, parts.slice(0, k).join('.'));
        if (hit) return hit;
      }
    }
    const top = parts[0];
    return { external: top, group: PY_STDLIB.has(top) ? 'python' : 'pypi' };
  }

  private go(spec: string): Resolution {
    for (const [mod, dir] of this.goModules) {
      if (spec === mod || spec.startsWith(mod + '/')) {
        const p = join(dir, spec.slice(mod.length + 1));
        if (this.dirs.has(p)) return { dir: p };
      }
    }
    const first = spec.split('/')[0];
    if (!first.includes('.')) return { external: spec.split('/')[0] === spec ? spec : first, group: 'go std' };
    return { external: spec.split('/').slice(0, 3).join('/'), group: 'go' };
  }

  private jvm(spec: string): Resolution {
    const s = spec.replace(/\.\*$/, '');
    if (spec.endsWith('.*')) {
      const dir = this.jvmPackages.get(s);
      if (dir) return { dir };
    }
    // A class, or a nested/static member of one: longest known prefix.
    for (let parts = s.split('.'); parts.length; parts.pop()) {
      const hit = this.jvmIndex.get(parts.join('.'));
      if (hit) return { file: hit };
    }
    const segs = s.split('.');
    return { external: segs.slice(0, segs[0] === 'java' || segs[0] === 'javax' || segs[0] === 'kotlin' ? 1 : 2).join('.'), group: 'jvm' };
  }

  private cs(spec: string): Resolution {
    const files = this.csNamespaces.get(spec);
    if (files?.length === 1) return { file: files[0] };
    if (files?.length) return { dir: commonDir(files) };
    return { external: spec.split('.')[0], group: 'nuget' };
  }

  private c(from: string, raw: string): Resolution {
    const system = raw.startsWith('<');
    const spec = raw.slice(1, -1);
    if (!system) {
      const local = this.fileWith(join(dirname(from), spec), ['']);
      if (local) return local;
    }
    const base = spec.slice(spec.lastIndexOf('/') + 1);
    const matches = (this.byBase.get(base) ?? []).filter((p) => p === spec || p.endsWith('/' + spec));
    if (matches.length) return { file: matches.sort((a, b) => commonPrefix(b, from) - commonPrefix(a, from))[0] };
    return system ? { external: spec, group: 'system' } : null;
  }

  private rust(from: string, imp: RawImport): Resolution {
    const fileDir = dirname(from);
    const stem = from.slice(from.lastIndexOf('/') + 1).replace(/\.rs$/, '');
    const modDir = ['mod', 'lib', 'main'].includes(stem) ? fileDir : join(fileDir, stem);
    if (imp.kind === 'mod') return this.fileWith(join(modDir, imp.specifier), ['.rs', '/mod.rs']) ?? null;
    const path = imp.specifier.replace(/\{[\s\S]*$/, '').replace(/::\s*$/, '').replace(/\s+as\s+\w+$/, '').trim();
    const segs = path.split('::').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return null;
    let base: string;
    const head = segs[0];
    if (head === 'crate') {
      base = this.crateDirs.filter((d) => from.startsWith(d + '/') || d === '').sort((a, b) => b.length - a.length)[0] ?? 'src';
      segs.shift();
    } else if (head === 'super') {
      base = dirname(modDir);
      segs.shift();
    } else if (head === 'self') {
      base = modDir;
      segs.shift();
    } else {
      return { external: head, group: ['std', 'core', 'alloc'].includes(head) ? 'rust std' : 'crates' };
    }
    let best: { file: string } | undefined;
    let cur = base;
    for (const seg of segs) {
      const hit = this.fileWith(join(cur, seg), ['.rs', '/mod.rs']);
      if (!hit) break;
      best = hit;
      cur = join(cur, seg);
    }
    return best ?? null;
  }

  private ruby(from: string, spec: string): Resolution {
    if (spec.startsWith('.')) return this.fileWith(join(dirname(from), spec), ['', '.rb']) ?? null;
    for (const root of ['lib', '', 'app']) {
      const hit = this.fileWith(join(root, spec), ['.rb', '']);
      if (hit) return hit;
    }
    return { external: spec.split('/')[0], group: 'gems' };
  }

  private php(from: string, imp: RawImport): Resolution {
    if (imp.kind === 'require') {
      const p = imp.specifier.replace(/^\//, '');
      return this.fileWith(join(dirname(from), p), ['']) ?? this.fileWith(p, ['']) ?? null;
    }
    const ns = imp.specifier.replace(/^\\/, '');
    for (const [prefix, dir] of this.psr4) {
      if (ns.startsWith(prefix)) {
        const hit = this.fileWith(join(dir, ns.slice(prefix.length).replace(/\\/g, '/')), ['.php']);
        if (hit) return hit;
      }
    }
    const segs = ns.split('\\');
    return { external: segs.slice(0, 2).join('\\'), group: 'composer' };
  }

  private css(from: string, spec: string): Resolution {
    if (/^(https?:)?\/\//.test(spec)) return null;
    const s = spec.replace(/^~/, '');
    const dir = dirname(join(dirname(from), s));
    const base = s.slice(s.lastIndexOf('/') + 1);
    const local =
      this.fileWith(join(dirname(from), s), ['', '.css', '.scss', '.sass', '.less', '/index.scss', '/_index.scss']) ??
      this.fileWith(join(dir, '_' + base), ['', '.scss', '.sass']);
    if (local) return local;
    return spec.startsWith('.') ? null : { external: s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0], group: 'npm' };
  }

  private dart(from: string, spec: string): Resolution {
    if (spec.startsWith('dart:')) return { external: spec, group: 'dart' };
    const m = /^package:([\w]+)\/(.*)$/.exec(spec);
    if (m) {
      if (m[1] === this.dartPackage) return this.fileWith(join('lib', m[2]), ['']) ?? null;
      return { external: m[1], group: 'pub' };
    }
    return this.fileWith(join(dirname(from), spec), ['']) ?? null;
  }
}

// ---------------------------------------------------------------- graph building

export async function buildDependencyGraph(repo: RepoModel, fs: FsAdapter, options: DepOptions = {}): Promise<DepGraph> {
  const started = Date.now();
  const paths = repoPaths(repo);
  const resolver = new Resolver(paths, repo.kind);
  const maxBytes = options.maxFileBytes ?? 1024 * 1024;
  const under = options.under ? options.under.replace(/^\/|\/$/g, '') : '';
  const read = async (rel: string, max = maxBytes): Promise<string | undefined> => {
    try {
      return new TextDecoder().decode(await fs.readFile(fs.join(repo.root, ...rel.split('/')), max));
    } catch {
      return undefined;
    }
  };

  await loadProjectConfig(resolver, paths, repo, read);

  const sourceIds: number[] = [];
  for (let i = 1; i < paths.length; i++) {
    if (repo.kind[i] === K_DIR) continue;
    if (under && !(paths[i] === under || paths[i].startsWith(under + '/'))) continue;
    if (repo.size[i] > maxBytes || !familyOf(paths[i])) continue;
    sourceIds.push(i);
  }

  // Index JVM packages and C# namespaces (needs file contents).
  const contents = new Map<number, string>();
  const concurrency = options.concurrency ?? 24;
  for (let k = 0; k < sourceIds.length; k += concurrency) {
    if (options.isCancelled?.()) break;
    const batch = sourceIds.slice(k, k + concurrency);
    const texts = await Promise.all(batch.map((id) => read(paths[id])));
    batch.forEach((id, j) => {
      const t = texts[j];
      if (t === undefined) return;
      contents.set(id, t);
      const p = paths[id];
      const fam = familyOf(p);
      if (fam === 'jvm') {
        const pkg = /^\s*package\s+([\w.]+)/m.exec(t)?.[1];
        const cls = p.slice(p.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
        const fqn = pkg ? `${pkg}.${cls}` : cls;
        resolver.jvmIndex.set(fqn, p);
        if (pkg && !resolver.jvmPackages.has(pkg)) resolver.jvmPackages.set(pkg, dirname(p));
      } else if (fam === 'cs') {
        for (const m of t.matchAll(/^\s*namespace\s+([\w.]+)/gm)) {
          const list = resolver.csNamespaces.get(m[1]);
          if (list) list.push(p);
          else resolver.csNamespaces.set(m[1], [p]);
        }
      }
    });
  }

  const nodes: DepNode[] = [];
  const nodeIndex = new Map<string, number>();
  const node = (key: string, kind: DepNode['kind'], path: string, group: string, entry?: number, lang?: string) => {
    let id = nodeIndex.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ id, path, kind, group, entry, lang, fanIn: 0, fanOut: 0 });
      nodeIndex.set(key, id);
    }
    return id;
  };
  const entryIndex = new Map(paths.map((p, i) => [p, i]));
  const fileNode = (p: string) => {
    const e = entryIndex.get(p);
    const lang = e !== undefined && repo.lang[e] >= 0 ? repo.languages[repo.lang[e]].id : undefined;
    return node(`f:${p}`, 'file', p, topDir(p), e, lang);
  };
  const dirNode = (p: string) => node(`d:${p}`, 'dir', p || '.', topDir(p), entryIndex.get(p));

  const edgeMap = new Map<string, DepEdge>();
  const unresolved: DepGraph['unresolved'] = [];
  const withExternals = options.externals ?? true;

  for (const id of sourceIds) {
    const text = contents.get(id);
    if (text === undefined) continue;
    const from = paths[id];
    const fromNode = fileNode(from);
    for (const imp of extractImports(text, from)) {
      const r = resolver.resolve(from, imp);
      let to: number | undefined;
      if (!r) {
        if (unresolved.length < 5000) unresolved.push({ from: fromNode, specifier: imp.specifier, line: imp.line });
        continue;
      }
      if ('file' in r) to = r.file === from ? undefined : fileNode(r.file);
      else if ('dir' in r) to = dirNode(r.dir);
      else if (withExternals) to = node(`x:${r.external}`, 'external', r.external, r.group);
      if (to === undefined) continue;
      // Python `from pkg import mod`: also link the submodules that exist.
      const extra: number[] = [];
      if (imp.names?.length && 'dir' in r) {
        for (const n of imp.names) {
          const sub = resolver.files.has(`${r.dir}/${n}.py`) ? `${r.dir}/${n}.py` : resolver.files.has(`${r.dir}/${n}/__init__.py`) ? `${r.dir}/${n}/__init__.py` : undefined;
          if (sub) extra.push(fileNode(sub));
        }
      }
      for (const t of extra.length ? extra : [to]) {
        const key = `${fromNode}>${t}`;
        const e = edgeMap.get(key);
        if (e) {
          e.count++;
          if (e.lines.length < 20) e.lines.push(imp.line);
        } else edgeMap.set(key, { from: fromNode, to: t, kind: imp.kind, count: 1, lines: [imp.line] });
      }
    }
  }

  const edges = [...edgeMap.values()];
  for (const e of edges) {
    nodes[e.from].fanOut++;
    nodes[e.to].fanIn++;
  }
  const cycles = stronglyConnected(nodes.length, edges).filter((c) => c.length > 1);
  return {
    root: repo.root,
    nodes,
    edges,
    unresolved,
    cycles,
    stats: {
      files: nodes.filter((n) => n.kind === 'file').length,
      scanned: contents.size,
      edges: edges.length,
      externals: nodes.filter((n) => n.kind === 'external').length,
      unresolved: unresolved.length,
      durationMs: Date.now() - started,
    },
  };
}

async function loadProjectConfig(r: Resolver, paths: string[], repo: RepoModel, read: (p: string, max?: number) => Promise<string | undefined>) {
  const configs = paths.filter((p, i) => repo.kind[i] !== K_DIR && /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|package\.json|go\.mod|composer\.json|Cargo\.toml|pubspec\.yaml)$/.test(p) && depthOf(p) <= 4);
  const jsonOf = async (p: string): Promise<Record<string, unknown> | undefined> => {
    const t = await read(p, 2 * 1024 * 1024);
    if (t === undefined) return undefined;
    const tree = parseJson(t, { format: 'jsonc' });
    const js = tree.toJS(tree.root, 50_000);
    return js && typeof js === 'object' && !Array.isArray(js) ? (js as Record<string, unknown>) : undefined;
  };
  for (const p of configs) {
    const dir = dirname(p);
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (/^(tsconfig[\w.-]*|jsconfig)\.json$/.test(base)) {
      let cfg = await jsonOf(p);
      // One level of `extends` (relative paths only).
      const ext = cfg?.extends;
      if (typeof ext === 'string' && ext.startsWith('.')) {
        const parentCfg = await jsonOf(normalize(join(dir, ext.endsWith('.json') ? ext : `${ext}.json`)));
        if (parentCfg) cfg = { ...parentCfg, ...cfg, compilerOptions: { ...(parentCfg.compilerOptions as object), ...(cfg?.compilerOptions as object) } };
      }
      const co = (cfg?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      if (co.baseUrl !== undefined || co.paths) {
        r.tsConfigs.push({
          dir,
          baseUrl: co.baseUrl !== undefined ? normalize(join(dir, co.baseUrl)) : undefined,
          paths: Object.entries(co.paths ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]),
        });
      }
    } else if (base === 'package.json') {
      const pkg = await jsonOf(p);
      const name = typeof pkg?.name === 'string' ? pkg.name : undefined;
      if (name && dir) {
        const entry = [pkg?.source, pkg?.module, pkg?.main, pkg?.types].find((x): x is string => typeof x === 'string');
        r.workspaces.set(name, { dir, entry: entry?.replace(/^\.\//, '') });
      }
    } else if (base === 'go.mod') {
      const t = await read(p, 64 * 1024);
      const m = t && /^module\s+(\S+)/m.exec(t);
      if (m) r.goModules.push([m[1], dir]);
    } else if (base === 'composer.json') {
      const c = await jsonOf(p);
      const auto = (c?.autoload ?? {}) as { 'psr-4'?: Record<string, string | string[]> };
      for (const [prefix, d] of Object.entries(auto['psr-4'] ?? {})) {
        for (const x of Array.isArray(d) ? d : [d]) r.psr4.push([prefix, normalize(join(dir, x))]);
      }
    } else if (base === 'Cargo.toml') {
      r.crateDirs.push(join(dir, 'src'));
    } else if (base === 'pubspec.yaml') {
      const t = await read(p, 64 * 1024);
      const m = t && /^name:\s*([\w]+)/m.exec(t);
      if (m) r.dartPackage = m[1];
    }
  }
  r.goModules.sort((a, b) => b[0].length - a[0].length);
  r.psr4.sort((a, b) => b[0].length - a[0].length);
  // Python package roots: parents of top-level packages, plus src/.
  const roots = new Set<string>(['']);
  if (r.dirs.has('src')) roots.add('src');
  for (const f of r.files) {
    if (!f.endsWith('/__init__.py')) continue;
    const pkg = dirname(f);
    const parent = dirname(pkg);
    if (!r.files.has(`${parent}/__init__.py`)) roots.add(parent);
  }
  r.pyRoots = [...roots];
}

/** Iterative Tarjan SCC. */
export function stronglyConnected(n: number, edges: { from: number; to: number }[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) adj[e.from].push(e.to);
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    const work: [number, number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] < adj[v].length) {
        const w = adj[v][top[1]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}

/** Folder-level rollup: each file maps to its ancestor folder at `depth`. */
export function aggregateByFolder(graph: DepGraph, depth: number): DepGraph {
  const nodes: DepNode[] = [];
  const index = new Map<string, number>();
  const map = new Int32Array(graph.nodes.length).fill(-1);
  for (const n of graph.nodes) {
    // Files roll up into their containing folder (root-level files into ".").
    const dirSegs = n.kind === 'file' ? n.path.split('/').slice(0, -1) : n.path.split('/');
    const key = n.kind === 'external' ? `x:${n.group}` : `d:${dirSegs.slice(0, depth).join('/') || '.'}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      const path = n.kind === 'external' ? n.group : key.slice(2);
      nodes.push({ id, path, kind: n.kind === 'external' ? 'external' : 'dir', group: n.kind === 'external' ? n.group : topDir(path), fanIn: 0, fanOut: 0 });
      index.set(key, id);
    }
    map[n.id] = id;
  }
  const edgeMap = new Map<string, DepEdge>();
  for (const e of graph.edges) {
    const a = map[e.from];
    const b = map[e.to];
    if (a === b) continue;
    const key = `${a}>${b}`;
    const ex = edgeMap.get(key);
    if (ex) ex.count += e.count;
    else edgeMap.set(key, { from: a, to: b, kind: e.kind, count: e.count, lines: [] });
  }
  const edges = [...edgeMap.values()];
  for (const e of edges) {
    nodes[e.from].fanOut++;
    nodes[e.to].fanIn++;
  }
  return { ...graph, nodes, edges, cycles: stronglyConnected(nodes.length, edges).filter((c) => c.length > 1), unresolved: [] };
}

// ---------------------------------------------------------------- path utils

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((x) => x !== '' && x !== undefined).join('/'));
}

export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function topDir(p: string): string {
  const i = p.indexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

function depthOf(p: string): number {
  return p.split('/').length;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonDir(files: string[]): string {
  let prefix = dirname(files[0]);
  for (const f of files) while (prefix && !(f === prefix || f.startsWith(prefix + '/'))) prefix = dirname(prefix);
  return prefix;
}
