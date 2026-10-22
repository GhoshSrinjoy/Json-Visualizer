import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, startHttpServer, type HttpMcpServer } from '../../src/mcp/server';
import { Workspace } from '../../src/node/workspace';

const TOKEN = 'test-token-0123456789abcdef';
let base = '';
let dirA = '';
let dirB = '';
let fixedRoot = '';
let open: HttpMcpServer;
let fixed: HttpMcpServer;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'structlens-http-'));
  for (const [dir, file] of [
    ['alpha', 'a-only.json'],
    ['beta', 'b-only.json'],
    ['fixed', 'fixed-only.json'],
  ]) {
    mkdirSync(join(base, dir));
    writeFileSync(join(base, dir, file), '{"ok": true}');
  }
  [dirA, dirB, fixedRoot] = ['alpha', 'beta', 'fixed'].map((d) => join(base, d));
  open = await startHttpServer({ port: 0, token: TOKEN, createSession: () => ({ server: createMcpServer(new Workspace(fixedRoot)) }) });
  fixed = await startHttpServer({ port: 0, token: TOKEN, createSession: () => ({ server: createMcpServer(new Workspace(fixedRoot), { useClientRoots: false }) }) });
});

afterAll(async () => {
  await open?.close();
  await fixed?.close();
  rmSync(base, { recursive: true, force: true });
});

async function connect(server: HttpMcpServer, roots?: string[], token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const end = async () => {
    await transport.terminateSession();
    await client.close();
  };
  return { client, call, end };
}

function raw(server: HttpMcpServer, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } };
const auth = { authorization: `Bearer ${TOKEN}` };

describe('MCP over HTTP', () => {
  it('gives every session its own workspace with its client’s roots', async () => {
    const a = await connect(open, [dirA]);
    const b = await connect(open, [dirB]);
    expect((await a.call('repo_tree')).text).toContain('a-only.json');
    expect((await b.call('repo_tree')).text).toContain('b-only.json');
    // B's roots did not replace A's.
    const again = await a.call('repo_tree');
    expect(again.text).toContain('a-only.json');
    expect(again.text).not.toContain('b-only.json');
    const crossed = await a.call('file_structure', { path: join(dirB, 'b-only.json') });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/outside the workspace/);
    expect(open.sessionCount()).toBe(2);
    await a.end();
    await b.end();
    expect(open.sessionCount()).toBe(0);
  });

  it('keeps --root roots fixed: client roots cannot widen them', async () => {
    const c = await connect(fixed, [base]);
    expect((await c.call('repo_tree')).text).toContain('fixed-only.json');
    const r = await c.call('file_structure', { path: join(dirA, 'a-only.json') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outside the workspace/);
    await c.end();
  });

  it('requires the bearer token', async () => {
    const none = await raw(open, { body: initialize });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await raw(open, { body: initialize, headers: { authorization: 'Bearer wrong-token-0123456789ab' } })).status).toBe(401);
    expect((await raw(open, { body: initialize, headers: { authorization: TOKEN } })).status).toBe(401);
    await expect(connect(open, undefined, 'not-the-token-0123456789')).rejects.toThrow();
    expect(open.sessionCount()).toBe(0);
    const ok = await raw(open, { body: initialize, headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.headers['mcp-session-id']).toBeTruthy();
    await raw(open, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': String(ok.headers['mcp-session-id']) } });
    expect(open.sessionCount()).toBe(0);
  });

  it('rejects foreign Host headers and cross-origin browser requests', async () => {
    expect((await raw(open, { body: initialize, headers: { ...auth, host: `evil.example:${open.port}` } })).status).toBe(403);
    expect((await raw(open, { body: initialize, headers: { ...auth, host: 'localhost:1' } })).status).toBe(403);
    expect((await raw(open, { body: initialize, headers: { ...auth, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await raw(open, { body: initialize, headers: { ...auth, origin: 'null' } })).status).toBe(403);
    const same = await raw(open, { body: initialize, headers: { ...auth, host: `localhost:${open.port}`, origin: `http://localhost:${open.port}` } });
    expect(same.status).toBe(200);
    await raw(open, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': String(same.headers['mcp-session-id']) } });
  });

  it('answers unknown sessions, other requests and other paths without creating sessions', async () => {
    expect((await raw(open, { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { ...auth, 'mcp-session-id': 'nope' } })).status).toBe(404);
    expect((await raw(open, { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: auth })).status).toBe(400);
    expect((await raw(open, { method: 'GET', headers: auth })).status).toBe(400);
    expect((await raw(open, { path: '/other', body: initialize, headers: auth })).status).toBe(404);
    expect(open.sessionCount()).toBe(0);
  });

  it('closes the least recently used session beyond the limit', async () => {
    const small = await startHttpServer({ port: 0, token: TOKEN, maxSessions: 1, createSession: () => ({ server: createMcpServer(new Workspace(fixedRoot)) }) });
    try {
      const first = await connect(small);
      const second = await connect(small);
      expect(small.sessionCount()).toBe(1);
      await expect(first.call('repo_tree')).rejects.toThrow();
      expect((await second.call('repo_tree')).text).toContain('fixed-only.json');
      await second.end();
    } finally {
      await small.close();
    }
  });

  it('refuses to start without a token', async () => {
    await expect(startHttpServer({ port: 0, token: '', createSession: () => ({ server: createMcpServer(new Workspace(fixedRoot)) }) })).rejects.toThrow(/token/);
  });
});
