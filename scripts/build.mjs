// Builds every StructLens artifact with esbuild:
//   dist/extension.js   VS Code extension (Node, CJS)
//   dist/cli.js         CLI + MCP server (Node, CJS, executable)
//   dist/webview/*      UI bundle (browser; the data worker is inlined)
//   dist/web/*          stand-alone static site (no backend)
//   dist/wasm/*         tree-sitter runtime + grammars
// Usage: node scripts/build.mjs [--production] [--watch]
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');

/** Grammars bundled with the extension/CLI (others in the package are skipped to save space). */
const GRAMMARS = ['javascript', 'typescript', 'tsx', 'python', 'go', 'java', 'c-sharp', 'rust', 'cpp', 'ruby', 'php'];

const define = {
  __STRUCTLENS_VERSION__: JSON.stringify(pkg.version),
  'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  define,
  legalComments: 'none',
};

/** Inlines the data worker as a string module so it can run from a blob URL. */
const workerPlugin = {
  name: 'inline-worker',
  setup(build) {
    build.onResolve({ filter: /^virtual:data-worker$/ }, () => ({ path: 'data-worker', namespace: 'virtual' }));
    build.onLoad({ filter: /.*/, namespace: 'virtual' }, async () => {
      const result = await esbuild.build({
        entryPoints: [join(root, 'src/webview/worker/data.worker.ts')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: ['chrome110', 'firefox115', 'safari16'],
        minify: production,
        define,
        metafile: true,
        logLevel: 'warning',
      });
      const code = result.outputFiles[0].text;
      return {
        contents: `export default ${JSON.stringify(code)};`,
        loader: 'js',
        watchFiles: Object.keys(result.metafile.inputs).map((f) => resolve(root, f)),
      };
    });
  },
};

const configs = [
  {
    ...common,
    entryPoints: { extension: join(root, 'src/extension/extension.ts') },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { cli: join(root, 'src/cli/main.ts') },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...common,
    entryPoints: { main: join(root, 'src/webview/main.tsx') },
    outdir: join(dist, 'webview'),
    platform: 'browser',
    format: 'iife',
    target: ['chrome110', 'firefox115', 'safari16'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.woff2': 'file' },
    plugins: [workerPlugin],
  },
];

function copyAssets() {
  const wasmSrc = join(root, 'node_modules/@vscode/tree-sitter-wasm/wasm');
  const wasmOut = join(dist, 'wasm');
  mkdirSync(wasmOut, { recursive: true });
  copyFileSync(join(wasmSrc, 'tree-sitter.wasm'), join(wasmOut, 'tree-sitter.wasm'));
  for (const g of GRAMMARS) copyFileSync(join(wasmSrc, `tree-sitter-${g}.wasm`), join(wasmOut, `tree-sitter-${g}.wasm`));
  // Stand-alone static site (GitHub Pages friendly).
  const web = join(dist, 'web');
  mkdirSync(web, { recursive: true });
  for (const f of ['main.js', 'main.css']) {
    const src = join(dist, 'webview', f);
    if (existsSync(src)) copyFileSync(src, join(web, f));
  }
  writeFileSync(join(web, 'index.html'), staticHtml());
  if (existsSync(join(root, 'media/icon.png'))) copyFileSync(join(root, 'media/icon.png'), join(web, 'icon.png'));
}

function staticHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StructLens</title>
<meta name="description" content="Visualize JSON, YAML, XML, TOML and CSV as interactive graphs, trees, tables and schemas — fast, local, private.">
<link rel="icon" href="icon.png">
<link rel="stylesheet" href="main.css">
</head>
<body>
<div id="app"></div>
<script>window.__STRUCTLENS__ = { host: 'browser' };</script>
<script src="main.js"></script>
</body>
</html>
`;
}

if (!watch) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (watch) {
  const contexts = await Promise.all(
    configs.map((c) =>
      esbuild.context({
        ...c,
        plugins: [
          ...(c.plugins ?? []),
          { name: 'assets', setup: (b) => b.onEnd((r) => !r.errors.length && copyAssets()) },
        ],
      }),
    ),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes…');
} else {
  const started = Date.now();
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyAssets();
  console.log(`Built StructLens ${pkg.version}${production ? ' (production)' : ''} in ${Date.now() - started} ms`);
}
