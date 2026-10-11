// Parser/layout micro-benchmarks on generated data: `npm run bench [-- --mb 200]`.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const mb = Number(args[args.indexOf('--mb') + 1]) || 100;
const dir = join(process.cwd(), 'bench', '.data');
mkdirSync(dir, { recursive: true });

const entry = join(dir, 'entry.mjs');
await build({
  stdin: {
    contents: `export { parseJson } from './src/core/data/json';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: entry,
  logLevel: 'warning',
});
const { parseJson } = await import(pathToFileURL(entry).href);

function generate(targetBytes, pretty) {
  const parts = [];
  let size = 2;
  let i = 0;
  while (size < targetBytes) {
    const rec = {
      id: i,
      uuid: `${(i * 2654435761 >>> 0).toString(16)}-4f1a-9c2e-${i}`,
      name: `User number ${i}`,
      email: `user${i}@example.com`,
      active: i % 3 !== 0,
      score: Math.round(Math.sin(i) * 10000) / 100,
      tags: ['alpha', 'beta', 'gamma'].slice(0, i % 4),
      address: { street: `${i} Main St`, city: ['Berlin', 'Paris', 'Tokyo'][i % 3], zip: null },
      note: i % 7 === 0 ? 'Escaped \"quote\" and \\ backslash\nnewline' : 'plain text value',
    };
    const s = pretty ? JSON.stringify(rec, null, 2) : JSON.stringify(rec);
    parts.push(s);
    size += s.length + 2;
    i++;
  }
  return '[' + parts.join(pretty ? ',\n' : ',') + ']';
}

for (const pretty of [false, true]) {
  const file = join(dir, `bench-${mb}mb-${pretty ? 'pretty' : 'min'}.json`);
  if (!existsSync(file)) writeFileSync(file, generate(mb * 1024 * 1024, pretty));
  const text = readFileSync(file, 'utf8');
  const label = `${(text.length / 1048576).toFixed(0)} MB ${pretty ? 'pretty' : 'minified'}`;

  let t = performance.now();
  const native = JSON.parse(text);
  const nativeMs = performance.now() - t;
  void native;

  global.gc?.();
  const before = process.memoryUsage();
  t = performance.now();
  const tree = parseJson(text);
  const ms = performance.now() - t;
  const after = process.memoryUsage();
  const nodes = tree.count;
  const mbps = text.length / 1048576 / (ms / 1000);
  console.log(
    `${label.padEnd(18)} parseJson ${ms.toFixed(0).padStart(5)} ms (${mbps.toFixed(0)} MB/s, ${(nodes / 1e6).toFixed(2)}M nodes, ` +
      `+${((after.arrayBuffers - before.arrayBuffers) / 1048576).toFixed(0)} MB buffers, errors=${tree.errors.length}) | JSON.parse ${nativeMs.toFixed(0)} ms`,
  );
  t = performance.now();
  const mid = tree.childAt(tree.root, Math.floor(tree.childCount[tree.root] / 2));
  const p = tree.pathString(tree.firstChild(mid) + 3);
  console.log(`  lookup middle child + path: ${(performance.now() - t).toFixed(2)} ms -> ${p}`);
}
