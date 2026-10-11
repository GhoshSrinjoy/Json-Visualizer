/** Shared state for the extension: per-folder workspaces, document access and editor navigation. */

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { decodeText } from '../core/data/formats';
import { ensureTreeSitter, Workspace } from '../node/workspace';
import type { SourceLocation } from '../shared/protocol';
import { VERSION } from '../shared/version';
import { scanOptions } from './config';

export class Services {
  private readonly workspaces = new Map<string, Workspace>();
  readonly output: vscode.OutputChannel;

  constructor(readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('StructLens');
    ensureTreeSitter(join(context.extensionPath, 'dist', 'wasm'));
    context.subscriptions.push(
      this.output,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.workspaces.clear()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('structlens.repo')) this.workspaces.clear();
      }),
    );
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  folderFor(uri: vscode.Uri): vscode.Uri | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri;
  }

  /** Workspace (cached analysis) rooted at the URI's workspace folder, or at the URI itself. */
  workspaceFor(uri: vscode.Uri): Workspace {
    const folder = this.folderFor(uri) ?? uri;
    const key = folder.fsPath;
    let ws = this.workspaces.get(key);
    if (!ws) {
      ws = new Workspace(this.allRoots(folder), { scan: scanOptions() });
      this.workspaces.set(key, ws);
    }
    return ws;
  }

  /** The folder first, then the other workspace folders (multi-root). */
  allRoots(first?: vscode.Uri): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (first && !roots.includes(first.fsPath)) roots.unshift(first.fsPath);
    else if (first) roots.sort((a, b) => (a === first.fsPath ? -1 : b === first.fsPath ? 1 : 0));
    return roots.length ? roots : [first?.fsPath ?? process.cwd()];
  }

  invalidate(uri: vscode.Uri): void {
    this.workspaces.get((this.folderFor(uri) ?? uri).fsPath)?.invalidate();
  }

  /** Text of a document: the live (possibly unsaved) editor buffer, else the file on disk. */
  async readText(uri: vscode.Uri): Promise<{ text: string; languageId?: string }> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) return { text: doc.getText(), languageId: doc.languageId };
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { text: decodeText(bytes) };
  }

  /** Shows a source location without covering the visualizer. */
  async reveal(uri: vscode.Uri, loc: SourceLocation, avoid?: vscode.ViewColumn): Promise<void> {
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    const column = visible?.viewColumn ?? (avoid === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: column, preserveFocus: loc.focus === false, preview: !visible });
    const start = new vscode.Position(loc.line, loc.col ?? 0);
    const end = loc.endLine !== undefined ? new vscode.Position(loc.endLine, loc.endCol ?? 0) : start;
    const range = new vscode.Range(start, end.isBefore(start) ? start : end);
    // Select only the first line of large ranges so the editor doesn't jump.
    editor.selection = new vscode.Selection(range.start, range.end.line - range.start.line > 40 ? range.start : range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Copies the CLI/MCP server bundle to a version-independent location so AI
   * agent configs keep working across extension updates.
   */
  async stableServer(): Promise<string> {
    const root = vscode.Uri.joinPath(this.context.globalStorageUri, 'server').fsPath;
    const cli = join(root, 'cli.js');
    const stamp = join(root, 'VERSION');
    const current = existsSync(stamp) ? (await readFile(stamp, 'utf8')).trim() : '';
    if (current !== VERSION || !existsSync(cli)) {
      await mkdir(root, { recursive: true });
      const dist = join(this.context.extensionPath, 'dist');
      await cp(join(dist, 'cli.js'), cli);
      await cp(join(dist, 'wasm'), join(root, 'wasm'), { recursive: true });
      await cp(join(dist, 'webview'), join(root, 'webview'), { recursive: true });
      await writeFile(stamp, VERSION);
      this.log(`Installed MCP server ${VERSION} at ${root}`);
    }
    return cli;
  }

  /** After an extension update: refresh the installed copy if agents were connected before. */
  async refreshStableServer(): Promise<void> {
    if (existsSync(join(vscode.Uri.joinPath(this.context.globalStorageUri, 'server').fsPath, 'cli.js'))) await this.stableServer();
  }
}
