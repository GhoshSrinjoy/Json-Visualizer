import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server';
import { Workspace } from '../../src/node/workspace';
import '../../src/core/code/languages';

let root = '';
let client: Client;
const opened: unknown[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'structlens-mcp-'));
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w('src/sample.ts', readFileSync(join(__dirname, '..', 'fixtures', 'code', 'sample.ts'), 'utf8'));
  w('src/util.ts', "export function helper(x: unknown) { return x; }\nexport { other } from './other';\n");
  w('src/other.ts', 'export const other = 1;\n');
  w('data/users.json', JSON.stringify({ users: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `u${i}`, admin: i % 10 === 0 })) }));
  w('README.md', '# demo\n');
  const ws = new Workspace(root);
  const server = createMcpServer(ws, { openVisualizer: async (req) => (opened.push(req), 'opened') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(a);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists all tools with read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['call_graph', 'code_dataflow', 'code_flow', 'code_outline', 'data_convert', 'data_diff', 'data_query', 'data_schema', 'data_search', 'data_tree', 'data_types', 'data_validate', 'dependency_graph', 'file_structure', 'find_symbol', 'open_visualizer', 'repo_overview', 'repo_tree'].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('describes the repository', async () => {
    const r = await call('repo_overview');
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/5 files in 2 folders/);
    expect(r.text).toContain('TypeScript');
    const t = await call('repo_tree', { path: 'src', depth: 1 });
    expect(t.text).toContain('sample.ts');
  });

  it('gives a general structure for data and code files', async () => {
    const data = await call('file_structure', { path: 'data/users.json' });
    expect(data.text).toContain('Schema:');
    expect(data.text).toContain('admin: boolean');
    const code = await call('file_structure', { path: 'src/sample.ts' });
    expect(code.text).toContain('function loadUsers(file: string, limit = 10): Promise<User[]>');
    expect(code.text).toContain('class User');
  });

  it('queries, searches and exports schemas', async () => {
    const q = await call('data_query', { path: 'data/users.json', query: '$.users[?(@.admin)].id' });
    expect(q.text).toContain('3 matches');
    expect(q.text).toContain('$.users[10].id');
    const s = await call('data_search', { path: 'data/users.json', text: 'u2' });
    expect(s.text).toMatch(/\$\.users\[2\]\.name/);
    const ts = await call('data_schema', { path: 'data/users.json', format: 'typescript' });
    expect(ts.text).toContain('export interface Root');
  });

  it('reports exact match counts, or a lower bound when the list was cut', async () => {
    const exact = await call('data_search', { path: 'data/users.json', text: 'u2', limit: 11 });
    expect(exact.text.split('\n')[0]).toBe('11 matches');
    const cut = await call('data_search', { path: 'data/users.json', text: 'u2', limit: 5 });
    expect(cut.text.split('\n')[0]).toBe('5+ matches (showing 5)');
    expect(cut.text.split('\n').length).toBe(6);
    // A query that stops at the internal cap on intermediate results.
    const dir = mkdtempSync(join(tmpdir(), 'structlens-mcp-big-'));
    try {
      writeFileSync(join(dir, 'big.json'), JSON.stringify(Array.from({ length: 150_000 }, (_, i) => i)));
      const server = createMcpServer(new Workspace(dir));
      const big = new Client({ name: 'big', version: '1.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await big.connect(a);
      const r = (await big.callTool({ name: 'data_query', arguments: { path: 'big.json', query: '$..*', limit: 3 } })) as { content: { text: string }[] };
      expect(r.content[0].text.split('\n')[0]).toBe('150,000+ matches (showing 3)');
      await big.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns flow and data flow with mermaid', async () => {
    const f = await call('code_flow', { path: 'src/sample.ts', function: 'loadUsers' });
    expect(f.text).toContain('cyclomatic complexity');
    expect(f.text).toContain('```mermaid\nflowchart TD');
    const d = await call('code_dataflow', { path: 'src/sample.ts', function: 'loadUsers', format: 'text' });
    expect(d.text).toContain('inputs: file, limit');
    const missing = await call('code_flow', { path: 'src/sample.ts', function: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Available:');
  });

  it('builds call and dependency graphs and finds symbols', async () => {
    const cg = await call('call_graph', { paths: ['src'] });
    expect(cg.text).toContain('loadUsers');
    const focused = await call('call_graph', { paths: ['src'], focus: 'format', direction: 'callers', depth: 1 });
    expect(focused.text).toContain('describe');
    const deps = await call('dependency_graph', { focus: 'src/util.ts' });
    expect(deps.text).toContain('imports (1): src/other.ts');
    const sym = await call('find_symbol', { query: 'User' });
    expect(sym.text).toMatch(/src\/sample\.ts:37\s+class User/);
  });

  it('adopts the client’s roots before the first tool call and after they change', async () => {
    let roots = [join(root, 'src')];
    const ws = new Workspace(root);
    const server = createMcpServer(ws);
    const rootsClient = new Client({ name: 'roots', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
    rootsClient.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await rootsClient.connect(a);
    const tree = async () => ((await rootsClient.callTool({ name: 'repo_tree', arguments: {} })) as { content: { text: string }[] }).content[0].text;
    expect(await tree()).toContain('sample.ts');
    expect(ws.roots).toEqual([join(root, 'src')]);
    roots = [join(root, 'data')];
    await rootsClient.sendRootsListChanged();
    expect(await tree()).toContain('users.json');
    expect(ws.roots).toEqual([join(root, 'data')]);
    await rootsClient.close();
  });

  it('keeps its roots when the client does not answer roots/list', async () => {
    const ws = new Workspace(root);
    const server = createMcpServer(ws, { rootsTimeoutMs: 200 });
    const silent = new Client({ name: 'silent', version: '1.0.0' }, { capabilities: { roots: {} } });
    silent.setRequestHandler(ListRootsRequestSchema, () => new Promise(() => undefined));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await silent.connect(a);
    const r = (await silent.callTool({ name: 'repo_overview', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(ws.roots).toEqual([root]);
    await silent.close();
  });

  it('rejects paths outside the workspace and opens the visualizer', async () => {
    const r = await call('file_structure', { path: '../../etc/passwd' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('outside the workspace');
    const o = await call('open_visualizer', { path: 'src/sample.ts', view: 'flow', function: 'loadUsers' });
    expect(o.text).toBe('opened');
    expect(opened[0]).toMatchObject({ view: 'flow', symbol: 'loadUsers' });
  });
});
