/**
 * Local bridge between external AI agents (via the MCP server) and a running
 * VS Code window. The extension listens on 127.0.0.1 with a random bearer
 * token and advertises itself in ~/.structlens/bridges/<pid>.json (readable by
 * the current user only); the MCP server finds the window whose workspace
 * contains a path and asks it to open a visualization.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, promises as fsp, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWithin } from './paths';
import { bearerToken, sameToken } from './token';

export interface BridgeInfo {
  pid: number;
  port: number;
  token: string;
  roots: string[];
  version: string;
  app: string;
}

export interface OpenRequest {
  /** Absolute file or folder path. */
  path: string;
  view?: string;
  symbol?: string;
  line?: number;
}

export function bridgeDir(): string {
  return join(homedir(), '.structlens', 'bridges');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const within = (path: string, root: string) => isWithin(resolve(path), resolve(root));

/** Live bridges, best match for `path` first (deepest root wins). */
export function findBridges(path?: string): BridgeInfo[] {
  let files: string[] = [];
  try {
    files = readdirSync(bridgeDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { b: BridgeInfo; score: number }[] = [];
  for (const f of files) {
    try {
      const b = JSON.parse(readFileSync(join(bridgeDir(), f), 'utf8')) as BridgeInfo;
      if (!alive(b.pid)) {
        try {
          unlinkSync(join(bridgeDir(), f));
        } catch {
          // another process may have removed it
        }
        continue;
      }
      const match = path ? Math.max(-1, ...b.roots.filter((r) => within(path, r)).map((r) => r.length)) : 0;
      if (path && match < 0) continue;
      out.push({ b, score: match });
    } catch {
      // ignore malformed files
    }
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.b);
}

export function callBridge(b: BridgeInfo, body: OpenRequest, timeoutMs = 4000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { host: '127.0.0.1', port: b.port, path: '/open', method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}`, 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => (res.statusCode === 200 ? resolvePromise(text) : reject(new Error(text || `bridge returned ${res.statusCode}`))));
      },
    );
    req.on('timeout', () => req.destroy(new Error('bridge timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Extension side: serve open requests and advertise the bridge. */
export async function startBridge(opts: {
  roots: () => string[];
  version: string;
  app: string;
  onOpen: (req: OpenRequest) => Promise<string>;
}): Promise<{ dispose(): void; refresh(): void }> {
  const token = randomBytes(24).toString('hex');
  const server: Server = createServer((req, res) => {
    const authorized = sameToken(bearerToken(req.headers.authorization), token);
    if (req.method !== 'POST' || req.url !== '/open' || !authorized) {
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as OpenRequest;
        const msg = await opts.onOpen(parsed);
        res.writeHead(200, { 'content-type': 'text/plain' }).end(msg);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(e instanceof Error ? e.message : String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const file = join(bridgeDir(), `${process.pid}.json`);
  const write = () => {
    mkdirSync(bridgeDir(), { recursive: true, mode: 0o700 });
    const info: BridgeInfo = { pid: process.pid, port, token, roots: opts.roots(), version: opts.version, app: opts.app };
    writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  };
  write();
  return {
    refresh: write,
    dispose() {
      server.close();
      void fsp.unlink(file).catch(() => undefined);
    },
  };
}
