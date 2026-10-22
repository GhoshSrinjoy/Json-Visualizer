/**
 * StructLens VS Code extension entry point. StructLens activates in every
 * window, so activation only registers what VS Code needs up front (commands,
 * the custom editor, Copilot tools, the MCP server definition) and starts the
 * agent bridge. The implementation (parsers, analysis, panels, tool code) is
 * bundled separately in features.js and loaded the first time it is used.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startBridge } from '../node/bridge';
import type { Mode, Target, ViewId } from '../shared/protocol';
import { VERSION } from '../shared/version';
import type { Features } from './features';
import type { OpenOptions, PanelDiagnostics } from './panel';

/** Returned from `activate`: lets other extensions (and smoke tests) drive StructLens. */
export interface StructLensApi {
  version: string;
  /** Opens the visualizer for a file or folder. */
  open(uri: vscode.Uri, options?: OpenOptions): Promise<void>;
  /** State of the open visualizer panels. */
  panels(): PanelDiagnostics[];
}

interface Manifest {
  contributes: { commands: { command: string }[]; languageModelTools?: { name: string; displayName: string }[] };
}

const TOOL_PREFIX = 'structlens_';
let loaded: Features | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<StructLensApi> {
  const output = vscode.window.createOutputChannel('StructLens');
  context.subscriptions.push(output);
  // (toLocaleTimeString would load ICU locale data during activation: ~10 ms.)
  const log = (message: string) => output.appendLine(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
  const cfg = () => vscode.workspace.getConfiguration('structlens');
  // A separate bundle (see scripts/build.mjs), required on first use.
  const features = (): Features => (loaded ??= (require('./features.js') as typeof import('./features')).createFeatures(context, output));
  const manifest = context.extension.packageJSON as Manifest;

  for (const { command } of manifest.contributes.commands) {
    context.subscriptions.push(vscode.commands.registerCommand(command, (...args: unknown[]) => (command === 'structlens.showLog' ? output.show() : features().runCommand(command, args))));
  }
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'structlens.dataEditor',
      {
        openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
        resolveCustomEditor: (document, panel) => features().resolveCustomEditor(document, panel),
      },
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
    ),
    vscode.window.registerWebviewPanelSerializer('structlens.visualizer', {
      deserializeWebviewPanel: async (panel, state: { mode?: Mode; target?: Target; view?: ViewId } | undefined) => features().revivePanel(panel, state),
    }),
  );

  // Copilot tools: names and schemas come from package.json (scripts/gen-manifest.mjs); the code loads on first call.
  if (vscode.lm?.registerTool && cfg().get<boolean>('ai.copilotTools', true)) {
    for (const tool of manifest.contributes.languageModelTools ?? []) {
      const title = tool.displayName.replace(/^StructLens:\s*/, '');
      context.subscriptions.push(
        vscode.lm.registerTool<Record<string, unknown>>(tool.name, {
          prepareInvocation: () => ({ invocationMessage: `StructLens: ${title.toLowerCase()}…` }),
          invoke: (options) => features().invokeTool(tool.name.slice(TOOL_PREFIX.length), options.input ?? {}),
        }),
      );
    }
  }

  const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider };
  if (lm?.registerMcpServerDefinitionProvider) {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider('structlens.mcp', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: async () => (cfg().get<boolean>('ai.mcpServer', false) ? features().mcpServerDefinitions() : []),
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('structlens.ai.mcpServer') && changed.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
      changed,
    );
  }

  if (cfg().get<boolean>('ai.bridge', true)) startAgentBridge(context, log, (req) => features().openFromAgent(req));

  // After an update: refresh the copy of the MCP server that agent configs point at (if agents were connected).
  const server = join(context.globalStorageUri.fsPath, 'server');
  if (existsSync(join(server, 'cli.js')) && readStamp(join(server, 'VERSION')) !== VERSION) {
    void Promise.resolve()
      .then(() => features().services.stableServer())
      .catch((e) => log(`Could not update the MCP server copy: ${(e as Error).message}`));
  }

  log(`StructLens activated (${vscode.env.appName} ${vscode.version}).`);
  return {
    version: VERSION,
    open: (uri, options) => features().open(uri, options),
    panels: () => loaded?.panels() ?? [],
  };
}

export function deactivate(): void {
  loaded?.dispose();
}

function readStamp(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Lets external agents (the MCP server started by Claude Code, Codex…) open views in this window.
 * Only windows with a folder open take part: agents address files by path.
 */
function startAgentBridge(context: vscode.ExtensionContext, log: (message: string) => void, onOpen: Parameters<typeof startBridge>[0]['onOpen']): void {
  const roots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let bridge: Promise<Awaited<ReturnType<typeof startBridge>> | undefined> | undefined;
  const sync = () => {
    if (bridge) {
      void bridge.then((b) => b?.refresh());
      return;
    }
    if (!roots().length) return;
    bridge = startBridge({ roots, version: VERSION, app: vscode.env.appName, onOpen }).then(
      (b) => {
        context.subscriptions.push(b);
        log('Agent bridge ready: external AI agents can open StructLens views in this window.');
        return b;
      },
      (e) => {
        log(`Agent bridge unavailable: ${(e as Error).message}`);
        return undefined;
      },
    );
  };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(sync));
  sync();
}
