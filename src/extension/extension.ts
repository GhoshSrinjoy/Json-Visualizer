/** StructLens VS Code extension entry point. */

import * as vscode from 'vscode';
import '../core/code/languages';
import { findAtLine } from '../core/code/symbols';
import { analyzeCode } from '../core/code/analyze';
import type { Mode, Target, ViewId } from '../shared/protocol';
import { VERSION } from '../shared/version';
import { connectAgents, registerLanguageModelTools, registerMcpProvider, startAgentBridge } from './agents';
import { DataEditorProvider } from './customEditor';
import { VisualizerPanel, type OpenOptions, type PanelDiagnostics } from './panel';
import { Services } from './services';

/** Returned from `activate`: lets other extensions (and smoke tests) drive StructLens. */
export interface StructLensApi {
  version: string;
  /** Opens the visualizer for a file or folder. */
  open(uri: vscode.Uri, options?: OpenOptions): Promise<void>;
  /** State of the open visualizer panels. */
  panels(): PanelDiagnostics[];
}

export async function activate(context: vscode.ExtensionContext): Promise<StructLensApi> {
  const services = new Services(context);
  const run = (fn: (...args: never[]) => Promise<unknown>) => async (...args: never[]) => {
    try {
      await fn(...args);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const activeUri = (arg?: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    return vscode.window.activeTextEditor?.document.uri ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
  };

  const open = async (uri: vscode.Uri | undefined, opts: OpenOptions = {}) => {
    if (!uri) {
      void vscode.window.showInformationMessage('Open a file (or select one in the Explorer) to visualize it.');
      return;
    }
    await VisualizerPanel.open(services, uri, opts);
  };

  /** Opens a code view for the function at the cursor. */
  const openAtCursor = async (view: ViewId) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return open(undefined);
    const doc = editor.document;
    const outline = await analyzeCode(vscode.workspace.asRelativePath(doc.uri, false), doc.getText(), doc.languageId);
    if (!outline) {
      void vscode.window.showWarningMessage(`StructLens can't analyse ${doc.languageId} code yet.`);
      return;
    }
    const fn = findAtLine(outline.symbols, editor.selection.active.line);
    await open(doc.uri, { view, symbol: fn?.id, line: editor.selection.active.line });
  };

  const workspaceFolder = async (): Promise<vscode.Uri | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0]?.uri;
    const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which folder?' });
    return pick?.uri;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('structlens.open', run(async (arg?: vscode.Uri) => open(activeUri(arg)))),
    vscode.commands.registerCommand('structlens.openFile', run(async (arg?: vscode.Uri) => open(activeUri(arg)))),
    vscode.commands.registerCommand('structlens.openFolder', run(async (arg?: vscode.Uri) => open(arg instanceof vscode.Uri ? arg : await workspaceFolder()))),
    vscode.commands.registerCommand('structlens.openWorkspace', run(async () => open(await workspaceFolder()))),
    vscode.commands.registerCommand('structlens.showFlow', run(async () => openAtCursor('flow'))),
    vscode.commands.registerCommand('structlens.showDataFlow', run(async () => openAtCursor('dataflow'))),
    vscode.commands.registerCommand('structlens.showCalls', run(async () => openAtCursor('calls'))),
    vscode.commands.registerCommand('structlens.showStructure', run(async () => openAtCursor('structure'))),
    vscode.commands.registerCommand('structlens.showDependencies', run(async (arg?: vscode.Uri) => open(arg instanceof vscode.Uri ? arg : await workspaceFolder(), { view: 'deps' }))),
    vscode.commands.registerCommand('structlens.showTreemap', run(async (arg?: vscode.Uri) => open(arg instanceof vscode.Uri ? arg : await workspaceFolder(), { view: 'treemap' }))),
    vscode.commands.registerCommand('structlens.connectAgents', run(async () => connectAgents(services))),
    vscode.commands.registerCommand('structlens.showLog', () => services.output.show()),
    vscode.window.registerCustomEditorProvider(DataEditorProvider.viewType, new DataEditorProvider(services), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerWebviewPanelSerializer(VisualizerPanel.viewType, {
      async deserializeWebviewPanel(panel, state: { mode?: Mode; target?: Target; view?: ViewId } | undefined) {
        if (state?.mode && state.target) VisualizerPanel.revive(services, panel, { mode: state.mode, target: state.target, view: state.view });
        else panel.dispose();
      },
    }),
    ...registerLanguageModelTools(services),
  );

  const mcp = registerMcpProvider(services);
  if (mcp) context.subscriptions.push(mcp);
  void startAgentBridge(services).then((b) => b && context.subscriptions.push(b));
  void services.refreshStableServer().catch((e) => services.log(`Could not update the MCP server copy: ${(e as Error).message}`));
  services.log(`StructLens activated (${vscode.env.appName} ${vscode.version}).`);
  return {
    version: VERSION,
    open: async (uri, options) => void (await VisualizerPanel.open(services, uri, options)),
    panels: () => VisualizerPanel.all().map((p) => ({ ...p.diagnostics, requests: { ...p.diagnostics.requests }, errors: [...p.diagnostics.errors] })),
  };
}

export function deactivate(): void {
  for (const p of VisualizerPanel.all()) p.dispose();
}
