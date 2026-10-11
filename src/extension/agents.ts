/**
 * AI integrations inside VS Code:
 *  - Language Model Tools, so Copilot agent mode can call StructLens directly
 *  - an optional MCP server definition for VS Code's own MCP support
 *  - a localhost bridge so external agents (Claude Code, Codex…) can open views here
 *  - "Connect AI Agents…": writes MCP configs for other clients
 */

import { spawnSync } from 'node:child_process';
import * as vscode from 'vscode';
import { CLIENTS, setupClient, type ClientId, type LaunchCommand } from '../cli/setup';
import { TOOLS, toolErrorMessage, type ToolContext } from '../mcp/tools';
import { startBridge, type OpenRequest } from '../node/bridge';
import { which } from '../node/exec';
import { VERSION } from '../shared/version';
import { cfg } from './config';
import { VisualizerPanel } from './panel';
import type { Services } from './services';

export const TOOL_PREFIX = 'structlens_';

function toolContext(services: Services): ToolContext {
  return {
    openVisualizer: async (req) => {
      await VisualizerPanel.open(services, vscode.Uri.file(req.path), { view: req.view as never, symbol: req.symbol, line: req.line });
      return `Opened ${vscode.workspace.asRelativePath(req.path)} in StructLens${req.view ? ` (${req.view} view)` : ''}.`;
    },
  };
}

function primaryFolder(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)?.uri) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function registerLanguageModelTools(services: Services): vscode.Disposable[] {
  if (!vscode.lm?.registerTool || !cfg().get<boolean>('ai.copilotTools', true)) return [];
  const ctx = toolContext(services);
  return TOOLS.map((tool) =>
    vscode.lm.registerTool<Record<string, unknown>>(`${TOOL_PREFIX}${tool.name}`, {
      prepareInvocation: () => ({ invocationMessage: `StructLens: ${tool.title.toLowerCase()}…` }),
      async invoke(options) {
        const folder = primaryFolder();
        if (!folder) throw new Error('Open a folder or workspace to use StructLens tools.');
        try {
          const text = await tool.run(services.workspaceFor(folder), options.input ?? {}, ctx);
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated)` : text)]);
        } catch (e) {
          // Errors are returned as text so the model can correct its arguments.
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(toolErrorMessage(e))]);
        }
      },
    }),
  );
}

/** How VS Code itself (or another agent) can launch the bundled MCP server. */
export async function launchCommand(services: Services, preferNode = true): Promise<LaunchCommand> {
  const cli = await services.stableServer();
  // Absolute PATH entries only: never a `node` planted in an (untrusted) workspace folder.
  const node = preferNode ? which(process.platform === 'win32' ? 'node.exe' : 'node') : undefined;
  if (node) {
    const r = spawnSync(node, ['--version'], { encoding: 'utf8', timeout: 4000 });
    const major = Number(/v(\d+)/.exec(r.stdout ?? '')?.[1] ?? 0);
    if (r.status === 0 && major >= 18) return { command: 'node', args: [cli, 'mcp'] };
  }
  // No suitable Node on PATH: run the script with VS Code's own runtime.
  return { command: process.execPath, args: [cli, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function registerMcpProvider(services: Services): vscode.Disposable | undefined {
  const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider };
  if (!lm?.registerMcpServerDefinitionProvider) return undefined;
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: async () => {
      if (!cfg().get<boolean>('ai.mcpServer', false)) return [];
      const launch = await launchCommand(services, false);
      const roots = services.allRoots();
      return [new vscode.McpStdioServerDefinition('StructLens', launch.command, [...launch.args, ...roots.flatMap((r) => ['--root', r])], launch.env ?? {}, VERSION)];
    },
  };
  const reg = lm.registerMcpServerDefinitionProvider('structlens.mcp', provider);
  const watch = vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('structlens.ai.mcpServer') && changed.fire());
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire());
  return vscode.Disposable.from(reg, watch, folders, changed);
}

export async function startAgentBridge(services: Services): Promise<vscode.Disposable | undefined> {
  if (!cfg().get<boolean>('ai.bridge', true)) return undefined;
  try {
    const bridge = await startBridge({
      roots: () => services.allRoots(),
      version: VERSION,
      app: vscode.env.appName,
      onOpen: async (req: OpenRequest) => {
        const uri = vscode.Uri.file(req.path);
        if (req.view === 'editor') {
          await services.reveal(uri, { uri: uri.toString(), line: req.line ?? 0, focus: true });
          return 'Revealed in the editor.';
        }
        await VisualizerPanel.open(services, uri, { view: req.view as never, symbol: req.symbol, line: req.line });
        return `Opened ${vscode.workspace.asRelativePath(uri)} in StructLens inside ${vscode.env.appName}.`;
      },
    });
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => bridge.refresh());
    services.log('Agent bridge ready: external AI agents can open StructLens views in this window.');
    return { dispose: () => (folders.dispose(), bridge.dispose()) };
  } catch (e) {
    services.log(`Agent bridge unavailable: ${(e as Error).message}`);
    return undefined;
  }
}

interface ClientPick extends vscode.QuickPickItem {
  client?: ClientId;
  scope?: 'project' | 'user';
  action?: 'copilot' | 'json';
}

export async function connectAgents(services: Services): Promise<void> {
  const project = primaryFolder();
  const items: ClientPick[] = [
    { label: '$(copilot) GitHub Copilot (VS Code)', description: 'built in — tools are already available in agent mode', action: 'copilot' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Claude Code', description: 'this project (.mcp.json)', client: 'claude', scope: 'project' },
    { label: 'Claude Code', description: 'all projects (user scope)', client: 'claude', scope: 'user' },
    { label: 'OpenAI Codex', description: 'all projects (~/.codex/config.toml)', client: 'codex', scope: 'user' },
    { label: 'Cursor', description: 'this project (.cursor/mcp.json)', client: 'cursor', scope: 'project' },
    { label: 'Gemini CLI', description: 'this project (.gemini/settings.json)', client: 'gemini', scope: 'project' },
    { label: 'Windsurf', description: 'user (~/.codeium/windsurf/mcp_config.json)', client: 'windsurf', scope: 'user' },
    { label: 'Claude Desktop', description: 'user config', client: 'claude-desktop', scope: 'user' },
    { label: 'VS Code MCP config', description: 'this project (.vscode/mcp.json) — for setups without this extension', client: 'vscode', scope: 'project' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(copy) Copy MCP server JSON', description: 'for any other MCP client', action: 'json' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Connect AI agents to StructLens', placeHolder: 'Which agent should be able to see your repo, code flow and data structures?' });
  if (!pick) return;
  if (pick.action === 'copilot') {
    const enabled = cfg().get<boolean>('ai.copilotTools', true);
    const msg = enabled
      ? 'StructLens tools are registered for Copilot. In Copilot Chat (Agent mode) open the tools picker, or reference them with #repoOverview, #fileStructure, #codeFlow…'
      : 'Copilot tools are disabled. Enable "structlens.ai.copilotTools" in Settings.';
    void vscode.window.showInformationMessage(msg, ...(enabled ? ['Open Chat'] : ['Open Settings'])).then((a) => {
      if (a === 'Open Chat') void vscode.commands.executeCommand('workbench.action.chat.open');
      if (a === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'structlens.ai');
    });
    return;
  }
  const launch = await launchCommand(services);
  if (pick.action === 'json') {
    const json = JSON.stringify({ mcpServers: { structlens: { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) } } }, null, 2);
    await vscode.env.clipboard.writeText(json);
    void vscode.window.showInformationMessage('MCP server configuration copied to the clipboard.');
    return;
  }
  if (pick.scope === 'project' && !project) {
    void vscode.window.showWarningMessage('Open a folder first to add a project-level configuration.');
    return;
  }
  const info = CLIENTS[pick.client!];
  const confirm = await vscode.window.showInformationMessage(
    `Add the StructLens MCP server to ${info.name} (${pick.description})?`,
    { modal: true, detail: `Command: ${launch.command} ${launch.args.join(' ')}` },
    'Add',
  );
  if (confirm !== 'Add') return;
  try {
    const lines = setupClient(pick.client!, { scope: pick.scope, project: project?.fsPath, launch });
    services.log(lines.join('\n'));
    void vscode.window.showInformationMessage(lines[0], 'Show details').then((a) => a && services.output.show());
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not configure ${info.name}: ${(e as Error).message}`);
  }
}
