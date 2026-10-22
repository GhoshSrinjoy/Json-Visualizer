/**
 * StructLens MCP server: exposes repository, data-file and code structure to
 * AI agents (Claude Code, Codex, Copilot, Cursor, Gemini CLI, …). Every tool
 * is read-only and returns compact text designed for an agent's context.
 *
 * Over HTTP every session gets its own server and workspace (so clients can't
 * change each other's roots), and clients must present a bearer token.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  isInitializeRequest,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { bearerToken, sameToken } from '../node/token';
import type { Workspace } from '../node/workspace';
import { VERSION } from '../shared/version';
import { TOOLS, toolErrorMessage, type ToolContext } from './tools';

export interface McpServerOptions extends ToolContext {
  /** Max characters per tool result (default 60k). */
  maxChars?: number;
  /** Adopt the client's workspace roots when it advertises them (default true unless roots were given explicitly). */
  useClientRoots?: boolean;
  /** How long a tool call waits for the client to list its roots (default 5 s). */
  rootsTimeoutMs?: number;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const SERVER_INSTRUCTIONS =
  'StructLens shows the structure of this workspace. Start with repo_overview, then drill down: repo_tree for folders, ' +
  'file_structure for any file (data files get a schema, code files an outline), code_flow / code_dataflow for one ' +
  'function, call_graph and dependency_graph for relationships, data_query / data_search / data_tree for big ' +
  'JSON/YAML/XML/CSV/Excel files. Paths are relative to the workspace root. Use open_visualizer to show the user an interactive diagram.';

/**
 * An MCP server over `ws`. Unless `useClientRoots` is false, the client's roots (when it has any)
 * replace the workspace roots: they are fetched before the first tool call and again after the client
 * reports a change. The request travels with the tool call, so it also reaches HTTP clients that keep
 * no standalone event stream open.
 */
export function createMcpServer(ws: Workspace, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'structlens', title: 'StructLens', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const maxChars = options.maxChars ?? 60_000;
  const useClientRoots = options.useClientRoots !== false;
  let rootsStale = useClientRoots;
  let rootsReady: Promise<void> = Promise.resolve();

  const syncRoots = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<void> => {
    if (!rootsStale) return rootsReady;
    rootsStale = false;
    rootsReady = (async () => {
      if (!server.server.getClientCapabilities()?.roots) return;
      try {
        const { roots } = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema, { timeout: options.rootsTimeoutMs ?? 5000 });
        const dirs: string[] = [];
        for (const r of roots) {
          if (!/^file:/i.test(r.uri)) continue;
          try {
            dirs.push(fileURLToPath(r.uri));
          } catch {
            // not a local folder (file://remote-host/…)
          }
        }
        if (dirs.length) ws.setRoots(dirs);
      } catch {
        // The client advertised roots but did not list them: keep the current ones.
      }
    })();
    return rootsReady;
  };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...READ_ONLY },
      },
      async (args: Record<string, unknown>, extra) => {
        try {
          await syncRoots(extra);
          let text = await tool.run(ws, args ?? {}, options);
          if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters — narrow the request)`;
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          return { isError: true, content: [{ type: 'text' as const, text: toolErrorMessage(e) }] };
        }
      },
    );
  }

  if (useClientRoots) {
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      rootsStale = true;
    });
  }
  return server;
}

// ---------------------------------------------------------------- Streamable HTTP

export interface McpSession {
  server: McpServer;
  /** Releases what the session holds (e.g. its visualizer server). */
  close?: () => void | Promise<void>;
}

export interface HttpServerOptions {
  /** Port to listen on (0 picks a free one). */
  port: number;
  /** Interface to listen on (default 127.0.0.1). */
  host?: string;
  /** Secret every request must carry as `Authorization: Bearer <token>`. */
  token: string;
  /** Creates the server of a new session; give each session its own Workspace. */
  createSession: () => McpSession;
  /** Live sessions kept before the least recently used one is closed (default 32). */
  maxSessions?: number;
}

export interface HttpMcpServer {
  /** The endpoint, e.g. http://127.0.0.1:7811/mcp */
  url: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const isWildcard = (host: string) => host === '0.0.0.0' || host === '::' || host === '';
const urlHost = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host).toLowerCase();

/** `host:port` of an Origin header (default ports made explicit), or undefined when it is not an http(s) origin. */
function originHostPort(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readBody(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > max) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Serves MCP over Streamable HTTP at /mcp. Requests must carry the bearer token and a loopback (or
 * the configured) Host header; browser requests from other origins are refused, which together
 * blocks other local processes, web pages and DNS-rebinding attacks.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpMcpServer> {
  if (!opts.token) throw new Error('An access token is required');
  const host = opts.host ?? '127.0.0.1';
  const maxSessions = opts.maxSessions ?? 32;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; session: McpSession }>();
  let allowedHosts = new Set<string>();

  const evict = () => {
    for (const [id, entry] of sessions) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(id);
      void entry.transport.close();
    }
  };

  const httpServer = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) return jsonRpcError(res, 403, -32000, 'Forbidden: unexpected Host header');
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHosts.has(originHostPort(origin) ?? '')) return jsonRpcError(res, 403, -32000, 'Forbidden: cross-origin requests are not allowed');
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return jsonRpcError(res, 404, -32000, 'Not found: the StructLens MCP endpoint is /mcp');
      if (!sameToken(bearerToken(req.headers.authorization), opts.token)) {
        return jsonRpcError(res, 401, -32001, 'Unauthorized: send the token printed by `structlens mcp --http` as "Authorization: Bearer <token>"', {
          'www-authenticate': 'Bearer realm="StructLens"',
        });
      }
      const sid = req.headers['mcp-session-id'];
      if (typeof sid === 'string') {
        const entry = sessions.get(sid);
        if (!entry) return jsonRpcError(res, 404, -32001, 'Session not found');
        sessions.delete(sid); // most recently used last
        sessions.set(sid, entry);
        return await entry.transport.handleRequest(req, res);
      }
      if (req.method !== 'POST') return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided');
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return jsonRpcError(res, 400, -32700, 'Parse error');
      }
      if (!isInitializeRequest(body)) return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided');
      const session = opts.createSession();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, session });
          evict();
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        void Promise.resolve(session.close?.()).catch(() => undefined);
      };
      await session.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, `Internal error: ${(e as Error).message}`);
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, host, () => resolve());
  });
  const port = (httpServer.address() as { port: number }).port;
  allowedHosts = new Set([...LOOPBACK_HOSTS, ...(isWildcard(host) ? [] : [urlHost(host)])].map((h) => `${h}:${port}`));
  return {
    url: `http://${isWildcard(host) ? '127.0.0.1' : urlHost(host)}:${port}/mcp`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
      sessions.clear();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
