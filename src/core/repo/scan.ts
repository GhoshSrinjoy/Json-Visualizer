/**
 * Concurrent repository scanner. Environment-agnostic: the host provides an
 * FsAdapter (Node fs, VS Code workspace.fs, a browser directory handle…).
 * Honors nested .gitignore files with git's precedence (deeper files win,
 * negations included) and a configurable exclude list.
 */

import ignore, { type Ignore } from 'ignore';
import { fileLanguage, isTextLanguage, looksBinary, type FileLanguage } from './languages';
import { K_DIR, K_FILE, K_LINK, type RepoLanguageStat, type RepoModel } from './model';

export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
}

export interface FsAdapter {
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** Reads up to `maxBytes` bytes. */
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  join(...parts: string[]): string;
}

export interface ScanOptions {
  respectGitignore?: boolean;
  /** gitignore-style patterns, applied in addition to .gitignore files. */
  exclude?: string[];
  maxFiles?: number;
  maxDepth?: number;
  countLines?: boolean;
  /** Files larger than this are not line-counted. */
  maxLineCountBytes?: number;
  concurrency?: number;
  onProgress?: (files: number) => void;
  isCancelled?: () => boolean;
}

/** Always-skipped: VCS metadata, dependency folders, caches and IDE state. */
export const DEFAULT_EXCLUDES = [
  '.git/', '.hg/', '.svn/', 'node_modules/', 'bower_components/', '__pycache__/', '.venv/', 'venv/', '.tox/',
  '.mypy_cache/', '.pytest_cache/', '.ruff_cache/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/',
  '.gradle/', '.idea/', '.vs/', '.nyc_output/', '.DS_Store', 'Thumbs.db', '*.pyc',
];

interface TNode {
  name: string;
  kind: number;
  children?: TNode[];
  size: number;
  lines: number;
  lang: FileLanguage | null;
  mtime: number;
  incomplete?: boolean;
}

interface Matcher {
  base: string; // relative dir ('' for root)
  ig: Ignore;
}

export async function scanRepo(root: string, fs: FsAdapter, options: ScanOptions = {}): Promise<RepoModel> {
  const started = Date.now();
  const maxFiles = options.maxFiles ?? 200_000;
  const maxDepth = options.maxDepth ?? 64;
  const countLines = options.countLines ?? true;
  const maxLineBytes = options.maxLineCountBytes ?? 2 * 1024 * 1024;
  const concurrency = options.concurrency ?? 32;
  const respectGitignore = options.respectGitignore ?? true;
  const excludes = ignore().add(options.exclude ?? DEFAULT_EXCLUDES);

  let files = 0;
  let dirs = 0;
  let ignored = 0;
  let truncated = false;
  let deepest = 0;
  const rootNode: TNode = { name: baseName(root), kind: K_DIR, children: [], size: 0, lines: 0, lang: null, mtime: 0 };

  // Simple promise pool.
  const queue: (() => Promise<void>)[] = [];
  let active = 0;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((r) => (resolveIdle = r));
  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift()!;
      active++;
      job()
        .catch(() => undefined)
        .finally(() => {
          active--;
          pump();
          if (active === 0 && queue.length === 0) resolveIdle();
        });
    }
  };
  const schedule = (job: () => Promise<void>) => {
    queue.push(job);
    pump();
  };

  const isIgnored = (rel: string, isDir: boolean, matchers: Matcher[]): boolean => {
    const probe = isDir ? `${rel}/` : rel;
    if (excludes.ignores(probe)) return true;
    let result = false;
    for (const m of matchers) {
      const sub = m.base ? probe.slice(m.base.length + 1) : probe;
      if (!sub) continue;
      const t = m.ig.test(sub);
      if (t.ignored) result = true;
      else if (t.unignored) result = false;
    }
    return result;
  };

  const visitFile = async (abs: string, node: TNode) => {
    try {
      const st = await fs.stat(abs);
      node.size = st.size;
      node.mtime = st.mtimeMs;
      if (countLines && node.lang && isTextLanguage(node.lang) && st.size > 0 && st.size <= maxLineBytes) {
        const bytes = await fs.readFile(abs, maxLineBytes);
        if (!looksBinary(bytes)) {
          let n = 0;
          for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n++;
          if (bytes.length && bytes[bytes.length - 1] !== 10) n++;
          node.lines = n;
        } else node.lines = -1;
      } else node.lines = -1;
    } catch {
      node.lines = -1;
    }
  };

  const visitDir = async (abs: string, rel: string, node: TNode, depth: number, inherited: Matcher[]) => {
    if (options.isCancelled?.()) return;
    deepest = Math.max(deepest, depth);
    let entries: DirEntry[];
    try {
      entries = await fs.readdir(abs);
    } catch {
      node.incomplete = true;
      return;
    }
    let matchers = inherited;
    if (respectGitignore) {
      const extra: string[] = [];
      for (const name of ['.gitignore', ...(depth === 0 ? ['.git/info/exclude'] : [])]) {
        if (name === '.gitignore' && !entries.some((e) => e.name === '.gitignore')) continue;
        try {
          const bytes = await fs.readFile(fs.join(abs, name), 512 * 1024);
          extra.push(new TextDecoder().decode(bytes));
        } catch {
          // missing .git/info/exclude is normal
        }
      }
      if (extra.length) matchers = [...inherited, { base: rel, ig: ignore().add(extra.join('\n')) }];
    }
    for (const e of entries) {
      if (e.type === 'other') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.type === 'dir';
      if (isIgnored(childRel, isDir, matchers)) {
        ignored++;
        continue;
      }
      if (isDir) {
        const child: TNode = { name: e.name, kind: K_DIR, children: [], size: 0, lines: 0, lang: null, mtime: 0 };
        node.children!.push(child);
        dirs++;
        if (depth + 1 > maxDepth || files >= maxFiles) {
          child.incomplete = true;
          truncated ||= files >= maxFiles;
          continue;
        }
        schedule(() => visitDir(fs.join(abs, e.name), childRel, child, depth + 1, matchers));
      } else {
        if (files >= maxFiles) {
          truncated = true;
          node.incomplete = true;
          continue;
        }
        files++;
        if (options.onProgress && files % 500 === 0) options.onProgress(files);
        const child: TNode = { name: e.name, kind: e.type === 'symlink' ? K_LINK : K_FILE, size: 0, lines: -1, lang: fileLanguage(e.name), mtime: 0 };
        node.children!.push(child);
        if (e.type === 'file') schedule(() => visitFile(fs.join(abs, e.name), child));
      }
    }
  };

  schedule(() => visitDir(root, '', rootNode, 0, []));
  await idle;
  return flatten(root, rootNode, { files, dirs, ignored, truncated, durationMs: Date.now() - started, maxDepth: deepest });
}

function flatten(root: string, rootNode: TNode, s: { files: number; dirs: number; ignored: number; truncated: boolean; durationMs: number; maxDepth: number }): RepoModel {
  const model: RepoModel = {
    root,
    name: rootNode.name,
    names: [],
    parent: [],
    kind: [],
    size: [],
    lines: [],
    lang: [],
    files: [],
    subtree: [],
    childCount: [],
    mtime: [],
    incomplete: [],
    languages: [],
    stats: { files: s.files, dirs: s.dirs, bytes: 0, lines: 0, ignored: s.ignored, truncated: s.truncated, durationMs: s.durationMs, maxDepth: s.maxDepth },
  };
  const langIndex = new Map<string, number>();
  const langOf = (l: FileLanguage): number => {
    let i = langIndex.get(l.id);
    if (i === undefined) {
      i = model.languages.length;
      langIndex.set(l.id, i);
      model.languages.push({ id: l.id, name: l.name, color: l.color, category: l.category, files: 0, lines: 0, bytes: 0 } satisfies RepoLanguageStat);
    }
    return i;
  };
  const sortKids = (a: TNode, b: TNode) => (a.kind === K_DIR) !== (b.kind === K_DIR) ? (a.kind === K_DIR ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

  // Iterative pre-order with post-order aggregation.
  interface Frame { node: TNode; id: number; next: number }
  const push = (node: TNode, parent: number): number => {
    const id = model.names.length;
    model.names.push(node.name);
    model.parent.push(parent);
    model.kind.push(node.kind);
    model.size.push(node.size);
    model.lines.push(node.kind === K_DIR ? 0 : node.lines);
    model.lang.push(node.lang ? langOf(node.lang) : -1);
    model.files.push(node.kind === K_DIR ? 0 : 1);
    model.subtree.push(1);
    model.childCount.push(node.children?.length ?? 0);
    model.mtime.push(node.mtime);
    if (node.incomplete) model.incomplete.push(id);
    if (node.kind !== K_DIR && node.lang) {
      const ls = model.languages[model.lang[id]];
      ls.files++;
      ls.bytes += node.size;
      if (node.lines > 0) ls.lines += node.lines;
    }
    node.children?.sort(sortKids);
    return id;
  };
  const stack: Frame[] = [{ node: rootNode, id: push(rootNode, -1), next: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    const kids = f.node.children;
    if (kids && f.next < kids.length) {
      const child = kids[f.next++];
      const id = push(child, f.id);
      if (child.kind === K_DIR) stack.push({ node: child, id, next: 0 });
      continue;
    }
    stack.pop();
    const id = f.id;
    model.subtree[id] = model.names.length - id;
    // Direct files first (their frames are never pushed; sub-directories
    // already added themselves when they were popped)…
    for (let c = id + 1; c < id + model.subtree[id]; c += model.subtree[c]) {
      if (model.kind[c] !== K_DIR) {
        model.size[id] += model.size[c];
        model.files[id] += 1;
        model.lines[id] += Math.max(0, model.lines[c]);
      }
    }
    // …then the completed totals roll up into the parent.
    const p = model.parent[id];
    if (p >= 0) {
      model.size[p] += model.size[id];
      model.files[p] += model.files[id];
      model.lines[p] += Math.max(0, model.lines[id]);
    }
  }
  model.stats.bytes = model.size[0];
  model.stats.lines = model.lines[0];
  model.languages.sort((a, b) => b.bytes - a.bytes);
  // Re-map language indexes after sorting.
  const remap = new Map(model.languages.map((l, i) => [langIndex.get(l.id)!, i]));
  model.lang = model.lang.map((l) => (l < 0 ? l : remap.get(l)!));
  return model;
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
