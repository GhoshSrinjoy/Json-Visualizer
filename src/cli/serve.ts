/**
 * Local web server for the visualizer UI (`structlens open`, and the MCP
 * server's open_visualizer fallback). Binds to 127.0.0.1, requires a random
 * token on every API call and rejects foreign Host headers (DNS rebinding).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, watch, type FSWatcher, promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { analyzeFunction } from '../core/code/analyze';
import { isBinaryFormat } from '../core/data/formats';
import { findBridges, callBridge } from '../node/bridge';
import { runDetached } from '../node/exec';
import { describeTarget } from '../node/target';
import type { Workspace } from '../node/workspace';
import { DEFAULT_SETTINGS, type InitPayload, type RequestMap, type UiSettings, type ViewId } from '../shared/protocol';
import { VERSION } from '../shared/version';

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Directory with main.js / main.css. */
  assetsDir: string;
  /** Default path shown at `/`. */
  initialPath?: string;
}

export interface VisualizerServer {
  url: string;
  port: number;
  token: string;
  urlFor(path: string, view?: string, symbol?: string): string;
  close(): Promise<void>;
}

export async function startServer(ws: Workspace, opts: ServeOptions): Promise<VisualizerServer> {
  const token = randomBytes(18).toString('base64url');
  const hostName = opts.host ?? '127.0.0.1';
  let settings: UiSettings = { ...DEFAULT_SETTINGS };
  const watchers = new Set<FSWatcher>();

  const html = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StructLens</title>
<link rel="stylesheet" href="/assets/main.css">
</head>
<body>
<div id="app"></div>
<script>window.__STRUCTLENS__ = ${JSON.stringify({ host: 'server', token })};</script>
<script src="/assets/main.js"></script>
</body>
</html>`;

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

  const openInEditor = async (path: string, line = 0, col = 0) => {
    const abs = ws.resolvePath(path);
    const bridge = findBridges(abs)[0];
    if (bridge) {
      await callBridge(bridge, { path: abs, line, view: 'editor' }).catch(() => undefined);
      return;
    }
    // Fall back to the `code` CLI when it is on PATH.
    runDetached('code', ['--goto', `${abs}:${line + 1}:${col + 1}`]);
  };

  const rpc = async (method: keyof RequestMap, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'getOutline':
        return ws.outline(String(params.uri));
      case 'getFunction': {
        const { abs, text } = await ws.readText(String(params.uri));
        return analyzeFunction(ws.rel(abs), text, { symbolId: params.symbolId as string | undefined, line: params.line as number | undefined });
      }
      case 'getCallGraph':
        return ws.callGraph((params.uris as string[]) ?? ['.'], {
          focus: params.focus as string | undefined,
          depth: params.depth as number | undefined,
          direction: params.direction as 'callees' | 'callers' | 'both' | undefined,
          externals: params.externals as boolean | undefined,
          maxNodes: 600,
        });
      case 'getRepo':
        return ws.repo(String(params.uri ?? '.'), !!params.force);
      case 'getDeps':
        return ws.deps(String(params.uri ?? '.'), { under: params.under as string | undefined, externals: params.externals as boolean | undefined }, !!params.force);
      case 'reveal':
        await openInEditor(String(params.uri), Number(params.line ?? 0), Number(params.col ?? 0));
        return null;
      case 'open':
        await openInEditor(String(params.uri));
        return null;
      case 'setSettings':
        settings = { ...settings, ...(params as Partial<UiSettings>) };
        return null;
      case 'notify':
        process.stderr.write(`[ui] ${String(params.message)}\n`);
        return null;
      default:
        throw new Error(`Unsupported request: ${method}`);
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url ?? '/', `http://${host}`);
      const p = url.pathname;
      if (p === '/' || p === '/index.html') return send(res, 200, html(), 'text/html; charset=utf-8');
      if (p === '/assets/main.js' || p === '/assets/main.css') {
        const file = join(opts.assetsDir, p.slice('/assets/'.length));
        if (!existsSync(file)) return send(res, 404, 'Run `npm run build` first');
        return send(res, 200, readFileSync(file), p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      if (p === '/favicon.ico') return send(res, 204, '');
      if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
      if ((url.searchParams.get('token') ?? req.headers['x-structlens-token']) !== token) return send(res, 401, 'Bad token');

      if (p === '/api/init') {
        const path = url.searchParams.get('path') ?? opts.initialPath ?? '.';
        try {
          const { mode, target } = await describeTarget(ws, path);
          const payload: InitPayload = {
            mode,
            target,
            view: (url.searchParams.get('view') as ViewId | null) ?? undefined,
            symbol: url.searchParams.get('symbol') ?? undefined,
            line: url.searchParams.has('line') ? Number(url.searchParams.get('line')) : undefined,
            settings,
            host: 'server',
            capabilities: { reveal: !isBinaryFormat(target.format), code: true, repo: true, settings: true },
            version: VERSION,
          };
          return json(res, 200, payload);
        } catch (e) {
          const payload: InitPayload = { mode: 'welcome', notice: (e as Error).message, settings, host: 'server', capabilities: { reveal: false, code: true, repo: true, settings: true }, version: VERSION };
          return json(res, 200, payload);
        }
      }
      if (p === '/api/file') {
        const uri = url.searchParams.get('uri') ?? '';
        const abs = ws.resolvePath(uri);
        const st = await fsp.stat(abs);
        const bytes = await fsp.readFile(abs);
        return send(res, 200, bytes, 'application/octet-stream', { 'x-version': String(Math.round(st.mtimeMs)) });
      }
      if (p === '/api/rpc' && req.method === 'POST') {
        const { method, params } = JSON.parse(await readBody(req)) as { method: keyof RequestMap; params: Record<string, unknown> };
        try {
          return json(res, 200, { result: await rpc(method, params ?? {}) });
        } catch (e) {
          return json(res, 200, { error: (e as Error).message });
        }
      }
      if (p === '/api/events') {
        const uri = url.searchParams.get('uri') ?? '.';
        const abs = ws.resolvePath(uri);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let watcher: FSWatcher | undefined;
        try {
          const isDir = (await fsp.stat(abs)).isDirectory();
          watcher = watch(abs, { recursive: isDir }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              if (isDir) ws.invalidate();
              res.write(`data: ${JSON.stringify({ type: 'changed', uri, version: Date.now() })}\n\n`);
            }, isDir ? 800 : 150);
          });
          watchers.add(watcher);
        } catch {
          // watching unsupported (e.g. network drives): no live reload
        }
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          clearTimeout(timer);
          if (watcher) {
            watcher.close();
            watchers.delete(watcher);
          }
        });
        return;
      }
      return send(res, 404, 'Not found');
    } catch (e) {
      return send(res, 500, (e as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, hostName, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://${hostName === '0.0.0.0' ? '127.0.0.1' : hostName}:${port}`;
  return {
    url: `${base}/?token=${token}`,
    port,
    token,
    urlFor(path: string, view?: string, symbol?: string) {
      const u = new URL(base + '/');
      u.searchParams.set('token', token);
      u.searchParams.set('path', path);
      if (view) u.searchParams.set('view', view);
      if (symbol) u.searchParams.set('symbol', symbol);
      return u.toString();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of watchers) w.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Opens a URL in the default browser (best effort). */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url.replace(/&/g, '^&')] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', () => undefined);
  child.unref();
}
