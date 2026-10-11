import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureTreeSitter } from '../../src/core/code/treesitter';
import '../../src/core/code/languages';

const wasmDir = join(__dirname, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
configureTreeSitter({ load: async (f) => new Uint8Array(readFileSync(join(wasmDir, f))) });

export const fixture = (name: string) => {
  const path = join(__dirname, '..', 'fixtures', 'code', name);
  return { path, text: readFileSync(path, 'utf8') };
};
