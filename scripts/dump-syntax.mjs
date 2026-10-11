// Prints the tree-sitter syntax tree (named nodes + field names) of a file.
// Handy when adding or tuning a language adapter:
//   node scripts/dump-syntax.mjs python path/to/file.py [--all]
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [grammar, file, ...flags] = process.argv.slice(2);
if (!grammar || !file) {
  console.error('usage: node scripts/dump-syntax.mjs <grammar> <file> [--all]');
  process.exit(1);
}
const showAnonymous = flags.includes('--all');
const cache = join(process.cwd(), 'node_modules', '.cache', 'structlens');
mkdirSync(cache, { recursive: true });
const out = join(cache, 'dump-entry.cjs');
await build({
  stdin: {
    contents: `export { configureTreeSitter, parseCode } from './src/core/code/treesitter';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out,
  logLevel: 'warning',
});
const { configureTreeSitter, parseCode } = await import(pathToFileURL(out).href);
const wasmDir = join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
configureTreeSitter({ load: async (f) => new Uint8Array(readFileSync(join(wasmDir, f))) });
const text = readFileSync(file, 'utf8');
const tree = await parseCode(grammar, text);

const lines = [];
const walk = (node, depth, field) => {
  if (!node.isNamed && !showAnonymous) return;
  const label = `${'  '.repeat(depth)}${field ? field + ': ' : ''}${node.isNamed ? node.type : JSON.stringify(node.type)}`;
  const leaf = node.childCount === 0 ? `  ${JSON.stringify(node.text.slice(0, 60))}` : '';
  lines.push(`${label} [${node.startPosition.row + 1}:${node.startPosition.column}]${leaf}`);
  for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1, node.fieldNameForChild(i));
};
walk(tree.rootNode, 0, null);
console.log(lines.join('\n'));
