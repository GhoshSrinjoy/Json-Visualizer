/** Decides how a path should be visualized (data / code / repo) for the CLI server and MCP. */

import { promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import { languageFor } from '../core/code/registry';
import { detectFormat } from '../core/data/formats';
import type { Mode, Target } from '../shared/protocol';
import type { Workspace } from './workspace';

export async function describeTarget(ws: Workspace, path: string): Promise<{ mode: Mode; target: Target }> {
  const abs = ws.resolvePath(path);
  const rel = ws.rel(abs);
  const st = await fsp.stat(abs);
  const name = rel === '.' ? basename(abs) : basename(abs);
  if (st.isDirectory()) return { mode: 'repo', target: { uri: rel, path: rel === '.' ? abs : rel, name } };
  const format = detectFormat(abs);
  if (format) return { mode: 'data', target: { uri: rel, path: rel, name, format } };
  const lang = languageFor(abs);
  if (lang) return { mode: 'code', target: { uri: rel, path: rel, name, languageId: lang.id } };
  // Unknown extension: sniff the content.
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
    await fh.read(buf, 0, buf.length, 0);
    const sniffed = detectFormat(abs, undefined, buf.toString('utf8'));
    if (sniffed) return { mode: 'data', target: { uri: rel, path: rel, name, format: sniffed } };
  } finally {
    await fh.close();
  }
  throw new Error(`Don't know how to visualize ${rel} (not a data, code or folder path)`);
}
