/**
 * Everything the extension does beyond activation: commands, visualizer panels,
 * the custom editor, Copilot tool calls and agent setup. It is bundled on its
 * own (dist/features.js) and loaded by extension.ts the first time it is
 * needed, so activating StructLens in a window stays cheap.
 */

import * as vscode from 'vscode';
import '../core/code/languages';
import { analyzeCode } from '../core/code/analyze';
import { findAtLine } from '../core/code/symbols';
import type { OpenRequest } from '../node/bridge';
import type { Mode, Target, ViewId } from '../shared/protocol';
import { connectAgents, invokeTool, mcpServerDefinitions, openFromAgent } from './agents';
import { DataEditorProvider } from './customEditor';
import { VisualizerPanel, type OpenOptions, type PanelDiagnostics } from './panel';
import { Services } from './services';

export function createFeatures(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const services = new Services(context, output);
  const dataEditor = new DataEditorProvider(services);

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

  const folderArg = async (arg?: unknown) => (arg instanceof vscode.Uri ? arg : await workspaceFolder());

  // Explorer commands get (clicked resource, all selected resources).
  const commands: Record<string, (arg?: unknown, all?: unknown) => Promise<unknown>> = {
    'structlens.open': async (arg) => open(activeUri(arg)),
    'structlens.openFile': async (arg) => open(activeUri(arg)),
    'structlens.openFolder': async (arg) => open(await folderArg(arg)),
    'structlens.openWorkspace': async () => open(await workspaceFolder()),
    'structlens.showFlow': async () => openAtCursor('flow'),
    'structlens.showDataFlow': async () => openAtCursor('dataflow'),
    'structlens.showCalls': async () => openAtCursor('calls'),
    'structlens.showStructure': async () => openAtCursor('structure'),
    'structlens.showDependencies': async (arg) => open(await folderArg(arg), { view: 'deps' }),
    'structlens.showTreemap': async (arg) => open(await folderArg(arg), { view: 'treemap' }),
    'structlens.connectAgents': async () => connectAgents(services),
    // Two files selected in the Explorer: the first is the original. One file: ask for the one to compare with.
    'structlens.compareWith': async (arg, all) => {
      const selected = Array.isArray(all) ? all.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
      const current = selected.length >= 2 ? selected[1] : activeUri(arg);
      if (!current) return open(undefined);
      let other = selected.length >= 2 ? selected[0] : undefined;
      if (!other) [other] = (await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.joinPath(current, '..'), canSelectMany: false, openLabel: 'Compare' })) ?? [];
      if (other) await open(current, { view: 'compare', compare: other.toString() });
    },
  };

  return {
    services,
    async runCommand(id: string, args: unknown[]): Promise<void> {
      try {
        const command = commands[id];
        if (!command) throw new Error(`Unknown command ${id}`);
        await command(args[0], args[1]);
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    },
    resolveCustomEditor: (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => dataEditor.resolveCustomEditor(document, panel),
    revivePanel(panel: vscode.WebviewPanel, state: { mode?: Mode; target?: Target; view?: ViewId } | undefined): void {
      if (state?.mode && state.target) VisualizerPanel.revive(services, panel, { mode: state.mode, target: state.target, view: state.view });
      else panel.dispose();
    },
    invokeTool: (name: string, input: Record<string, unknown>) => invokeTool(services, name, input),
    mcpServerDefinitions: () => mcpServerDefinitions(services),
    openFromAgent: (req: OpenRequest) => openFromAgent(services, req),
    open: async (uri: vscode.Uri, options?: OpenOptions) => void (await VisualizerPanel.open(services, uri, options)),
    panels: (): PanelDiagnostics[] => VisualizerPanel.all().map((p) => ({ ...p.diagnostics, requests: { ...p.diagnostics.requests }, errors: [...p.diagnostics.errors] })),
    dispose(): void {
      for (const p of VisualizerPanel.all()) p.dispose();
    },
  };
}

export type Features = ReturnType<typeof createFeatures>;
