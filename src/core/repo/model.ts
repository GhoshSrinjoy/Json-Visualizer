/** Repository structure model: a flat, pre-order, JSON-serialisable tree. */

import type { FileCategory } from './languages';

export const K_DIR = 0;
export const K_FILE = 1;
export const K_LINK = 2;

export interface RepoLanguageStat {
  id: string;
  name: string;
  color: string;
  category: FileCategory;
  files: number;
  lines: number;
  bytes: number;
}

export interface RepoStats {
  files: number;
  dirs: number;
  bytes: number;
  lines: number;
  /** Entries skipped by .gitignore / exclude patterns. */
  ignored: number;
  /** Scan stopped at maxFiles. */
  truncated: boolean;
  durationMs: number;
  maxDepth: number;
}

/**
 * Entries in pre-order (directories first, then files, alphabetical). The
 * subtree of entry `i` is [i, i + subtree[i]). Directory size/lines/files are
 * totals over their subtree.
 */
export interface RepoModel {
  /** Absolute path of the scanned root. */
  root: string;
  name: string;
  names: string[];
  parent: number[];
  kind: number[];
  /** Bytes. */
  size: number[];
  /** Lines (-1 when not counted). */
  lines: number[];
  /** Index into `languages` (-1 for directories). */
  lang: number[];
  /** Files in the subtree (1 for files). */
  files: number[];
  subtree: number[];
  childCount: number[];
  mtime: number[];
  /** Directory entries whose contents were not scanned (limit reached / unreadable). */
  incomplete: number[];
  languages: RepoLanguageStat[];
  stats: RepoStats;
}

export function repoPath(repo: RepoModel, id: number): string {
  const parts: string[] = [];
  for (let i = id; i > 0; i = repo.parent[i]) parts.push(repo.names[i]);
  return parts.reverse().join('/');
}

export function repoChildren(repo: RepoModel, id: number): number[] {
  const out: number[] = [];
  let c = id + 1;
  for (let k = 0; k < repo.childCount[id]; k++) {
    out.push(c);
    c += repo.subtree[c];
  }
  return out;
}

/** Index from relative path to entry id. */
export function repoIndex(repo: RepoModel): Map<string, number> {
  const map = new Map<string, number>();
  const paths: string[] = new Array(repo.names.length);
  paths[0] = '';
  map.set('', 0);
  for (let i = 1; i < repo.names.length; i++) {
    const p = repo.parent[i];
    paths[i] = p === 0 ? repo.names[i] : `${paths[p]}/${repo.names[i]}`;
    map.set(paths[i], i);
  }
  return map;
}

/** Relative paths for all entries (index-aligned). */
export function repoPaths(repo: RepoModel): string[] {
  const paths: string[] = new Array(repo.names.length);
  paths[0] = '';
  for (let i = 1; i < repo.names.length; i++) {
    const p = repo.parent[i];
    paths[i] = p === 0 ? repo.names[i] : `${paths[p]}/${repo.names[i]}`;
  }
  return paths;
}
