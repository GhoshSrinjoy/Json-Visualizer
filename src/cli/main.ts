/**
 * StructLens CLI.
 *   structlens [path]                 open the visualizer in your browser
 *   structlens mcp                    MCP server for AI agents (stdio, or --http)
 *   structlens setup <client>         register the MCP server with Claude Code, Codex, Cursor…
 *   structlens tree|overview|structure|schema|query|search|values|outline|flow|dataflow|calls|deps|find …
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, startHttpServer, type HttpMcpServer, type McpSession } from '../mcp/server';
import { TOOLS, toolErrorMessage, type ToolDef } from '../mcp/tools';
import { callBridge, findBridges } from '../node/bridge';
import { isWithin } from '../node/paths';
import { newToken } from '../node/token';
import { Workspace } from '../node/workspace';
import { VERSION } from '../shared/version';
import { parseArgs, type Args } from './args';
import { openBrowser, startServer, type VisualizerServer } from './serve';
import { CLIENTS, defaultLaunch, NPX_UNSUPPORTED, setupClient, type ClientId } from './setup';
import '../core/code/languages';

const HELP = `StructLens ${VERSION} — structure of data files, code and repositories, for humans and AI agents.

Usage
  structlens [path]                   Open the interactive visualizer in your browser (default: .)
  structlens open [path] [--view v] [--port n] [--no-browser]
  structlens mcp [--root dir]… [--http port] [--host h] [--token t] [--no-browser]
                                      Start the MCP server (stdio by default; over HTTP clients
                                      must send the printed token as a bearer token)
  structlens setup <client> [--scope project|user] [--dry-run]
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
  const inCwd = isWithin(target, cwd);
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
  // --root fixes the roots; otherwise each session adopts its client's roots.
  const explicitRoots = !!args.flags.root;
  const defaultRoots = roots(args.flags);
  /** One MCP session: its own workspace (roots and caches) and, when needed, its own visualizer server. */
  const session = (): McpSession => {
    const ws = new Workspace(defaultRoots);
    let web: Promise<VisualizerServer> | undefined;
    const openVisualizer = async (req: { path: string; view?: string; symbol?: string; line?: number }) => {
      const bridge = findBridges(req.path)[0];
      if (bridge) {
        try {
          return await callBridge(bridge, req);
        } catch (e) {
          process.stderr.write(`[structlens] VS Code bridge failed: ${(e as Error).message}\n`);
        }
      }
      web ??= startServer(ws, { assetsDir: assetsDir() }).catch((e) => {
        web = undefined;
        throw e;
      });
      const url = (await web).urlFor(ws.rel(req.path), req.view, req.symbol);
      // --no-browser (headless / SSH sessions): hand the link to the agent instead.
      if (args.flags.browser === false) return `The StructLens visualizer is running at ${url} — give this link to the user.`;
      openBrowser(url);
      return `Opened the StructLens visualizer in the user's browser: ${url}`;
    };
    return {
      server: createMcpServer(ws, { openVisualizer, useClientRoots: !explicitRoots }),
      close: async () => {
        if (web) await (await web).close();
      },
    };
  };

  if (args.flags.http) return serveHttp(args, session);
  await session().server.connect(new StdioServerTransport());
  process.stderr.write(`StructLens MCP server ${VERSION} ready (roots: ${defaultRoots.join(', ')})\n`);
}

async function serveHttp(args: Args, session: () => McpSession): Promise<void> {
  const port = args.flags.http === true ? 7811 : Number(args.flags.http);
  const host = typeof args.flags.host === 'string' ? args.flags.host : '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail(`Invalid port for --http: ${String(args.flags.http)}`);
  if (args.flags.token === true || Array.isArray(args.flags.token)) return fail('--token needs one value: a random string of at least 16 characters.');
  const pinned = typeof args.flags.token === 'string' ? args.flags.token : process.env.STRUCTLENS_TOKEN || undefined;
  if (pinned !== undefined && (pinned.length < 16 || /\s/.test(pinned))) return fail('The token must be at least 16 characters long, without spaces.');
  const token = pinned ?? newToken();
  let server: HttpMcpServer;
  try {
    server = await startHttpServer({ port, host, token, createSession: session });
  } catch (e) {
    return fail(`Could not listen on ${host}:${port}: ${(e as Error).message}`);
  }
  const config = { mcpServers: { structlens: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${token}` } } } };
  process.stderr.write(
    [
      `StructLens MCP server ${VERSION} (Streamable HTTP) listening on ${server.url}`,
      `Clients must send the header  Authorization: Bearer ${token}`,
      `  Claude Code:  claude mcp add --transport http structlens ${server.url} --header "Authorization: Bearer ${token}"`,
      `  Other clients (JSON):  ${JSON.stringify(config)}`,
      pinned ? 'Token pinned with --token / STRUCTLENS_TOKEN.' : 'The token changes on every start; pin it with --token <t> or the STRUCTLENS_TOKEN environment variable.',
      '',
    ].join('\n'),
  );
  await new Promise<void>((r) => process.on('SIGINT', () => r()));
  await server.close();
  process.exit(0);
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function cmdSetup(args: Args): void {
  if (args.flags.npx !== undefined && args.flags.npx !== false) return fail(NPX_UNSUPPORTED);
  const client = args.positional[0] as ClientId | undefined;
  if (!client || !(client in CLIENTS)) {
    process.stdout.write(`Choose a client:\n${Object.entries(CLIENTS).map(([id, c]) => `  ${id.padEnd(16)} ${c.name} (${c.scopes.join('/')})`).join('\n')}\n\nExample: structlens setup claude --scope user\n`);
    process.exitCode = client ? 1 : 0;
    return;
  }
  try {
    const lines = setupClient(client, {
      scope: args.flags.scope === 'user' || args.flags.scope === 'project' ? args.flags.scope : undefined,
      launch: defaultLaunch(),
      dryRun: args.flags.dryRun === true,
    });
    process.stdout.write(lines.join('\n') + '\n');
  } catch (e) {
    fail((e as Error).message);
  }
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
    cli: true,
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
