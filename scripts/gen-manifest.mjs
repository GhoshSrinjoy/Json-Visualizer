// Regenerates package.json → contributes.languageModelTools from src/mcp/tools.ts
// so Copilot's tool schemas always match the MCP tools. Run: npm run manifest
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const cache = join(root, 'node_modules', '.cache', 'structlens');
mkdirSync(cache, { recursive: true });
const out = join(cache, 'manifest-entry.cjs');
await build({
  stdin: {
    contents: `export { TOOLS } from './src/mcp/tools'; export { z } from 'zod';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out,
  logLevel: 'warning',
  define: { __STRUCTLENS_VERSION__: '"0"' },
});
const { TOOLS, z } = await import(pathToFileURL(out).href);

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const ICONS = {
  repo_overview: '$(repo)', repo_tree: '$(list-tree)', file_structure: '$(symbol-structure)', data_schema: '$(json)',
  data_query: '$(filter)', data_search: '$(search)', data_tree: '$(list-tree)', code_outline: '$(symbol-class)',
  code_flow: '$(git-merge)', code_dataflow: '$(arrow-swap)', call_graph: '$(call-outgoing)', dependency_graph: '$(references)',
  find_symbol: '$(symbol-method)', open_visualizer: '$(graph)',
};

const tools = TOOLS.map((t) => {
  const schema = z.toJSONSchema(z.object(t.inputSchema), { target: 'draft-7' });
  delete schema.$schema;
  delete schema.additionalProperties;
  return {
    name: `structlens_${t.name}`,
    toolReferenceName: camel(t.name),
    displayName: `StructLens: ${t.title}`,
    modelDescription: t.description,
    userDescription: t.description.split(/(?<=\.)\s/)[0],
    canBeReferencedInPrompt: true,
    icon: ICONS[t.name] ?? '$(graph)',
    tags: ['structlens', 'structure', 'code', 'data'],
    inputSchema: schema,
  };
});

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.contributes = pkg.contributes ?? {};
pkg.contributes.languageModelTools = tools;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Wrote ${tools.length} language model tools to package.json`);
