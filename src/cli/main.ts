/**
 * StructLens CLI.
 *   structlens [path]                 open the visualizer in your browser
 *   structlens mcp                    MCP server for AI agents (stdio, or --http)
 *   structlens setup <client>         register the MCP server with Claude Code, Codex, Cursor…
 *   structlens tree|overview|structure|schema|query|search|values|outline|flow|dataflow|calls|deps|find …
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server';
import { TOOLS, toolErrorMessage, type ToolDef } from '../mcp/tools';
import { callBridge, findBridges } from '../node/bridge';
import { Workspace } from '../node/workspace';
import { VERSION } from '../shared/version';
import { openBrowser, startServer, type VisualizerServer } from './serve';
import { CLIENTS, defaultLaunch, setupClient, type ClientId } from './setup';
import '../core/code/languages';

interface Args {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const rawKey = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      let value: string | boolean;
      if (eq > 0) value = a.slice(eq + 1);
      else if (rawKey.startsWith('no-')) {
        out.flags[rawKey.slice(3).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = false;
        continue;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) value = argv[++i];
      else value = true;
      const prev = out.flags[key];
      out.flags[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, String(value)] : [String(prev), String(value)];
    } else if (a === '-h') out.flags.help = true;
    else if (a === '-v') out.flags.version = true;
    else if (!out.command && out.positional.length === 0 && !a.startsWith('-') && isCommand(a)) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

function isCommand(a: string): boolean {
  return ['open', 'mcp', 'setup', 'help', 'version', ...TOOLS.filter((t) => t.cli).map((t) => t.cli!.command)].includes(a);
}

const HELP = `StructLens ${VERSION} — structure of data files, code and repositories, for humans and AI agents.

Usage
  structlens [path]                   Open the interactive visualizer in your browser (default: .)
  structlens open [path] [--view v] [--port n] [--no-browser]
  structlens mcp [--root dir]… [--http port] [--host h] [--no-browser]
                                      Start the MCP server (stdio by default)
  structlens setup <client> [--scope project|user] [--npx] [--dry-run]
                                      Register the MCP server with: ${Object.keys(CLIENTS).join(', ')}

Structure commands (same output AI agents get over MCP)
${TOOLS.filter((t) => t.cli)
  .map((t) => `  structlens ${`${t.cli!.command} ${t.cli!.positional.map((p) => `<${p}>`).join(' ')}`.padEnd(32)} ${t.cli!.summary}`)
  .join('\n')}

Common options
  --root <dir>      Workspace root (default: current directory)
  --format <f>      text | mermaid | json-schema | typescript (where supported)
  --depth <n>       Depth for trees and outlines
  -h, --help        Show help        -v, --version   Show version

Examples
  structlens data/big.json                       # graph/tree/table in the browser
  structlens schema data/big.json --format typescript
  structlens query data/users.json '$.users[?(@.active)].email'
  structlens flow src/app.ts handleRequest --format mermaid
  structlens deps src --level folder
  structlens setup claude && structlens setup codex
`;

function assetsDir(): string {
  const candidates = [join(__dirname, 'webview'), join(__dirname, '..', 'dist', 'webview')];
  return candidates.find((d) => existsSync(join(d, 'main.js'))) ?? candidates[0];
}

function roots(flags: Args['flags']): string[] {
  const r = flags.root;
  if (!r || r === true) return [process.cwd()];
  return (Array.isArray(r) ? r : [r]).map((x) => resolve(String(x)));
}

async function cmdOpen(args: Args): Promise<void> {
  const target = resolve(args.positional[0] ?? '.');
  if (!existsSync(target)) {
    process.stderr.write(`Not found: ${target}\n`);
    process.exitCode = 1;
    return;
  }
  // Root: --root, else the current directory when the target is inside it, else the target's folder.
  const cwd = process.cwd();
  const inCwd = target === cwd || target.startsWith(cwd + sep);
  const ws = new Workspace(args.flags.root ? roots(args.flags) : [inCwd ? cwd : statSync(target).isDirectory() ? target : dirname(target)]);
  const server = await startServer(ws, { port: Number(args.flags.port) || 0, host: typeof args.flags.host === 'string' ? args.flags.host : undefined, assetsDir: assetsDir() });
  const url = server.urlFor(ws.rel(target), typeof args.flags.view === 'string' ? args.flags.view : undefined);
  process.stdout.write(`StructLens is running at\n  ${url}\nPress Ctrl+C to stop.\n`);
  if (args.flags.browser !== false) openBrowser(url);
  await new Promise<void>((r) => process.on('SIGINT', () => r()));
  await server.close();
  process.exit(0);
}

async function cmdMcp(args: Args): Promise<void> {
  const explicitRoots = !!args.flags.root;
  const ws = new Workspace(roots(args.flags));
  let web: VisualizerServer | null = null;
  const openVisualizer = async (req: { path: string; view?: string; symbol?: string; line?: number }) => {
    const bridge = findBridges(req.path)[0];
    if (bridge) {
      try {
        return await callBridge(bridge, req);
      } catch (e) {
        process.stderr.write(`[structlens] VS Code bridge failed: ${(e as Error).message}\n`);
      }
    }
    web ??= await startServer(ws, { assetsDir: assetsDir() });
    const url = web.urlFor(ws.rel(req.path), req.view, req.symbol);
    // --no-browser (headless / SSH sessions): hand the link to the agent instead.
    if (args.flags.browser === false) return `The StructLens visualizer is running at ${url} — give this link to the user.`;
    openBrowser(url);
    return `Opened the StructLens visualizer in the user's browser: ${url}`;
  };
  const make = () => createMcpServer(ws, { openVisualizer, useClientRoots: !explicitRoots });

  if (args.flags.http) {
    const port = Number(args.flags.http === true ? 7811 : args.flags.http);
    const host = typeof args.flags.host === 'string' ? args.flags.host : '127.0.0.1';
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
    const httpServer = createServer(async (req, res) => {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end('StructLens MCP endpoint is /mcp');
        return;
      }
      const sid = req.headers['mcp-session-id'];
      let entry = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!entry) {
        const server = make();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `${host}:${port}`],
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        entry = { transport, server };
      }
      await entry.transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => httpServer.listen(port, host, () => r()));
    process.stderr.write(`StructLens MCP server (Streamable HTTP) listening on http://${host}:${port}/mcp\n`);
    await new Promise<void>((r) => process.on('SIGINT', () => r()));
    httpServer.close();
    return;
  }
  const server = make();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`StructLens MCP server ${VERSION} ready (roots: ${ws.roots.join(', ')})\n`);
}

function cmdSetup(args: Args): void {
  const client = args.positional[0] as ClientId | undefined;
  if (!client || !(client in CLIENTS)) {
    process.stdout.write(`Choose a client:\n${Object.entries(CLIENTS).map(([id, c]) => `  ${id.padEnd(16)} ${c.name} (${c.scopes.join('/')})`).join('\n')}\n\nExample: structlens setup claude --scope user\n`);
    process.exitCode = client ? 1 : 0;
    return;
  }
  const lines = setupClient(client, {
    scope: args.flags.scope === 'user' || args.flags.scope === 'project' ? args.flags.scope : undefined,
    launch: defaultLaunch(process.argv[1], args.flags.npx === true),
    dryRun: args.flags.dryRun === true,
  });
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdTool(tool: ToolDef, args: Args): Promise<void> {
  const ws = new Workspace(roots(args.flags));
  const input: Record<string, unknown> = { ...args.flags };
  delete input.root;
  const pos = tool.cli!.positional;
  pos.forEach((name, i) => {
    if (args.positional[i] === undefined) return;
    // Array parameters (paths) take every remaining positional argument.
    input[name] = name === 'paths' ? args.positional.slice(i) : args.positional[i];
  });
  const text = await tool.run(ws, input, {
    openVisualizer: async (req) => {
      const bridge = findBridges(req.path)[0];
      if (bridge) return callBridge(bridge, req);
      return 'No running VS Code window with StructLens for this folder — use `structlens open` instead.';
    },
  });
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version || args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.flags.help || args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  switch (args.command) {
    case 'mcp':
      return cmdMcp(args);
    case 'setup':
      return cmdSetup(args);
    case undefined:
    case 'open':
      return cmdOpen(args);
  }
  const tool = TOOLS.find((t) => t.cli?.command === args.command);
  if (!tool) {
    process.stderr.write(`Unknown command "${args.command}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  try {
    await cmdTool(tool, args);
  } catch (e) {
    process.stderr.write(`${toolErrorMessage(e)}\n`);
    process.exitCode = 1;
  }
}

void main();
