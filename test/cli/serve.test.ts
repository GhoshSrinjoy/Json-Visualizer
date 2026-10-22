import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type VisualizerServer } from '../../src/cli/serve';
import { Workspace } from '../../src/node/workspace';

let dir = '';
let server: VisualizerServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'structlens-serve-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'main.js'), 'console.log("ui")');
  writeFileSync(join(dir, 'assets', 'main.css'), 'body{}');
  writeFileSync(join(dir, 'data.json'), '{"ok": true}');
  server = await startServer(new Workspace(dir), { assetsDir: join(dir, 'assets') });
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(new URL(path, server.url));

describe('visualizer web server', () => {
  it('serves the page (which embeds the token) only with the token', async () => {
    for (const path of ['/', '/index.html', '/?token=wrong', `/?token=${server.token}x`]) {
      const res = await get(path);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(server.token);
    }
    const ok = await fetch(server.url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await ok.text()).toContain(server.token);
  });

  it('prints links that work', async () => {
    const res = await fetch(server.urlFor('data.json', 'graph'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(server.token);
  });

  it('keeps the static assets public and the API behind the token', async () => {
    expect((await get('/assets/main.js')).status).toBe(200);
    expect((await get('/api/init?path=data.json')).status).toBe(401);
    expect((await get(`/api/file?uri=data.json&token=${server.token}`)).status).toBe(200);
  });
});
