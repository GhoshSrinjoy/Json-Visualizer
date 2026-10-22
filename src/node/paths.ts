/**
 * Path comparison and confinement helpers shared by the workspace, the agent
 * bridge and the CLI. Windows and macOS file systems are case-insensitive by
 * default, so paths are compared case-insensitively there.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** Comparison key for an absolute, normalized path. */
export function pathKey(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** True when `p` is `root` or inside it (both absolute and normalized). */
export function isWithin(p: string, root: string): boolean {
  const a = pathKey(p);
  const r = pathKey(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** `p` relative to `root`, with forward slashes ('.' for the root itself). */
export function relativeTo(root: string, p: string): string {
  const base = root.endsWith(sep) ? root : root + sep;
  if (pathKey(p) === pathKey(root)) return '.';
  if (pathKey(p.slice(0, base.length)) === pathKey(base)) return p.slice(base.length).split(sep).join('/');
  return relative(root, p).split(sep).join('/') || '.';
}

/**
 * Real location of `p` with symbolic links, junctions, 8.3 short names and
 * letter case resolved. For a path that does not exist (yet), the real path of
 * its nearest existing ancestor joined with the rest.
 */
export function realpathNearest(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}
