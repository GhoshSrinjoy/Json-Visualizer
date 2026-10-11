/** Node.js implementations of the core's host interfaces. */

import { promises as fsp, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WasmSource } from '../core/code/treesitter';
import type { DirEntry, FsAdapter } from '../core/repo/scan';

export const nodeFs: FsAdapter = {
  async readdir(p: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other',
    }));
  },
  async stat(p: string) {
    const s = await fsp.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  async readFile(p: string, maxBytes?: number): Promise<Uint8Array> {
    if (!maxBytes) return new Uint8Array(await fsp.readFile(p));
    const fh = await fsp.open(p, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, off);
    } finally {
      await fh.close();
    }
  },
  join: (...parts: string[]) => join(...parts),
};

/** Loads bundled tree-sitter wasm files from a directory. */
export function wasmFromDir(dir: string): WasmSource {
  return { load: async (file: string) => new Uint8Array(readFileSync(join(dir, file))) };
}
