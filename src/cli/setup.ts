/**
 * `structlens setup <client>`: registers the StructLens MCP server with an AI
 * client by adding it to the client's config file (or printing what to add).
 * Only the `structlens` entry is touched; a config with syntax errors is left
 * alone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runSync } from '../node/exec';
import { setJsonEntry, setTomlTable, tomlTable } from './config-edit';

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type ClientId = 'claude' | 'claude-desktop' | 'codex' | 'cursor' | 'vscode' | 'windsurf' | 'gemini' | 'json';

export const CLIENTS: Record<ClientId, { name: string; scopes: ('project' | 'user')[]; note?: string }> = {
  claude: { name: 'Claude Code', scopes: ['project', 'user'] },
  'claude-desktop': { name: 'Claude Desktop', scopes: ['user'] },
  codex: { name: 'OpenAI Codex CLI / IDE', scopes: ['user', 'project'] },
  cursor: { name: 'Cursor', scopes: ['project', 'user'] },
  vscode: { name: 'VS Code (Copilot agent mode)', scopes: ['project'] },
  windsurf: { name: 'Windsurf', scopes: ['user'] },
  gemini: { name: 'Gemini CLI', scopes: ['project', 'user'] },
  json: { name: 'Any MCP client (prints JSON)', scopes: ['project'] },
};

/** An argument as the user would type it into a shell (for printed commands). */
const shellArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export const NPX_UNSUPPORTED =
  '--npx is not supported: StructLens is not published on npm, so `npx structlens` would run whatever package of that name someone else publishes. ' +
  'Run setup from your StructLens copy instead (from a clone: node dist/cli.js setup <client>); the configuration then starts that cli.js with an absolute path.';

/** How this CLI can be launched again later: absolute paths of the Node.js binary and of this script. */
export function defaultLaunch(cliPath: string = process.argv[1] || __filename): LaunchCommand {
  return {
    command: process.execPath,
    args: [resolve(cliPath), 'mcp'],
    // Running inside an Electron app (VS Code's runtime): make it behave as plain Node.js.
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  };
}

function writeConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function mergeServer(path: string, key: 'mcpServers' | 'servers', entry: Record<string, unknown>): string {
  const edit = setJsonEntry(existsSync(path) ? readFileSync(path, 'utf8') : '', key, 'structlens', entry, path);
  if (!edit.changed) return `"structlens" in ${path} is already up to date`;
  writeConfig(path, edit.text);
  return `${edit.existed ? 'Updated' : 'Added'} "structlens" in ${path}`;
}

const codexBody = (launch: LaunchCommand) => ({ command: launch.command, args: launch.args, ...(launch.env && Object.keys(launch.env).length ? { env: launch.env } : {}) });

/** Adds or replaces the [mcp_servers.structlens] table in a Codex config. */
function mergeCodex(path: string, launch: LaunchCommand): string {
  const edit = setTomlTable(existsSync(path) ? readFileSync(path, 'utf8') : '', ['mcp_servers', 'structlens'], codexBody(launch), path);
  if (!edit.changed) return `[mcp_servers.structlens] in ${path} is already up to date`;
  writeConfig(path, edit.text);
  return `${edit.existed ? 'Updated' : 'Added'} [mcp_servers.structlens] in ${path}`;
}

function claudeDesktopConfig(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

export interface SetupOptions {
  scope?: 'project' | 'user';
  /** Project directory (default cwd). */
  project?: string;
  launch?: LaunchCommand;
  /** Only print what would be added. */
  dryRun?: boolean;
}

/** Applies the configuration; returns human-readable lines describing what happened. */
export function setupClient(client: ClientId, opts: SetupOptions = {}): string[] {
  const info = CLIENTS[client];
  if (!info) throw new Error(`Unknown client "${client}". Choose one of: ${Object.keys(CLIENTS).join(', ')}`);
  const scope = opts.scope ?? info.scopes[0];
  if (!info.scopes.includes(scope)) throw new Error(`${info.name} supports scope: ${info.scopes.join(', ')}`);
  const project = resolve(opts.project ?? process.cwd());
  const launch = opts.launch ?? defaultLaunch();
  const stdio = { type: 'stdio', command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
  const plain = { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
  const out: string[] = [];
  const show = (path: string, json: unknown) => out.push(`Would write to ${path}:`, JSON.stringify(json, null, 2));
  if (launch.args.some((a) => /[\\/]_npx[\\/]/.test(a))) out.push(`Note: ${launch.args[0]} is in the npx cache, which can be cleared at any time; run setup from a permanent copy of StructLens.`);

  switch (client) {
    case 'claude': {
      if (scope === 'project') {
        const path = join(project, '.mcp.json');
        if (opts.dryRun) show(path, { mcpServers: { structlens: stdio } });
        else out.push(mergeServer(path, 'mcpServers', stdio), 'Claude Code will ask you to approve the project server the next time it starts in this folder.');
      } else {
        const env = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
        const args = ['mcp', 'add', '--scope', 'user', ...env, 'structlens', '--', launch.command, ...launch.args];
        if (opts.dryRun) out.push(`Would run: claude ${args.map(shellArg).join(' ')}`);
        else {
          runSync('claude', ['mcp', 'remove', '--scope', 'user', 'structlens'], { stdio: 'ignore' });
          const r = runSync('claude', args);
          if (r?.status === 0) out.push('Registered with Claude Code (user scope).');
          else out.push('Could not run the `claude` CLI. Run this yourself:', `  claude ${args.map(shellArg).join(' ')}`);
        }
      }
      break;
    }
    case 'claude-desktop': {
      const path = claudeDesktopConfig();
      if (opts.dryRun) show(path, { mcpServers: { structlens: plain } });
      else out.push(mergeServer(path, 'mcpServers', plain), 'Restart Claude Desktop to load it.');
      break;
    }
    case 'codex': {
      const path = scope === 'user' ? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml') : join(project, '.codex', 'config.toml');
      if (opts.dryRun) out.push(`Would add to ${path}:`, tomlTable(['mcp_servers', 'structlens'], codexBody(launch)).join('\n'));
      else out.push(mergeCodex(path, launch));
      break;
    }
    case 'cursor': {
      const path = scope === 'user' ? join(homedir(), '.cursor', 'mcp.json') : join(project, '.cursor', 'mcp.json');
      if (opts.dryRun) show(path, { mcpServers: { structlens: plain } });
      else out.push(mergeServer(path, 'mcpServers', plain));
      break;
    }
    case 'vscode': {
      const path = join(project, '.vscode', 'mcp.json');
      const entry = { ...stdio, args: [...launch.args, '--root', '${workspaceFolder}'] };
      if (opts.dryRun) show(path, { servers: { structlens: entry } });
      else out.push(mergeServer(path, 'servers', entry), 'Tip: the StructLens VS Code extension already provides these tools to Copilot — this file is for setups without it.');
      break;
    }
    case 'windsurf': {
      const path = join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      if (opts.dryRun) show(path, { mcpServers: { structlens: plain } });
      else out.push(mergeServer(path, 'mcpServers', plain));
      break;
    }
    case 'gemini': {
      const path = scope === 'user' ? join(homedir(), '.gemini', 'settings.json') : join(project, '.gemini', 'settings.json');
      if (opts.dryRun) show(path, { mcpServers: { structlens: plain } });
      else out.push(mergeServer(path, 'mcpServers', plain));
      break;
    }
    case 'json':
      out.push(JSON.stringify({ mcpServers: { structlens: plain } }, null, 2));
      break;
  }
  return out;
}
