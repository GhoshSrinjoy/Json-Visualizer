/**
 * A StructLens webview (editor panel or custom editor) bound to one target:
 * a data file, a source file or a folder. Answers the UI's RPC requests and
 * pushes document changes and editor-cursor moves.
 */

import { randomBytes } from 'node:crypto';
import { basename, dirname, join, posix } from 'node:path';
import * as vscode from 'vscode';
import { analyzeCode, analyzeFunction } from '../core/code/analyze';
import { languageFor } from '../core/code/registry';
import { detectFormat, isBinaryFormat } from '../core/data/formats';
import { K_DIR, type RepoModel } from '../core/repo/model';
import type { HostEvent, InitPayload, Mode, RequestMap, RpcRequest, Target, UiToHost, ViewId } from '../shared/protocol';
import { VERSION } from '../shared/version';
import { saveUiSettings, uiSettings } from './config';
import { loadSchemaFor, pickSchema } from './schemas';
import type { Services } from './services';

export interface OpenOptions {
  view?: ViewId;
  symbol?: string;
  line?: number;
  /** Open beside the active editor (default), or in the active group. */
  beside?: boolean;
  /** Data files: compare with this file (URI string). */
  compare?: string;
}

/** Decides how to visualize a URI. */
export async function classify(uri: vscode.Uri, languageId?: string): Promise<{ mode: Mode; target: Target }> {
  const name = basename(uri.path) || uri.path;
  let isDir = false;
  try {
    isDir = (await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory ? true : false;
  } catch {
    // untitled / not on disk: treat as a document
  }
  const path = vscode.workspace.asRelativePath(uri, true);
  if (isDir) return { mode: 'repo', target: { uri: uri.toString(), path, name } };
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const lang = languageId ?? doc?.languageId;
  // Known data file (by name, extension or language), then source code; content sniffing comes last
  // so that code is never mistaken for YAML.
  if (detectFormat(uri.path, lang)) {
    const format = detectFormat(uri.path, lang, doc?.getText().slice(0, 64 * 1024))!;
    return { mode: 'data', target: { uri: uri.toString(), path, name, languageId: lang, format } };
  }
  const code = languageFor(uri.path, lang);
  if (code) return { mode: 'code', target: { uri: uri.toString(), path, name, languageId: lang ?? code.id } };
  const head = doc ? doc.getText().slice(0, 64 * 1024) : new TextDecoder().decode((await vscode.workspace.fs.readFile(uri)).subarray(0, 64 * 1024));
  const sniffed = detectFormat(uri.path, lang, head);
  if (sniffed) return { mode: 'data', target: { uri: uri.toString(), path, name, languageId: lang, format: sniffed } };
  throw new Error(`StructLens can't visualize ${name}: it is not a recognised data file, source file or folder.`);
}

/** Health of one webview (exposed through the extension API for smoke tests). */
export interface PanelDiagnostics {
  name: string;
  mode: Mode;
  /** The UI loaded and asked for its init payload. */
  ready: boolean;
  /** Answered requests by method. */
  requests: Record<string, number>;
  /** Failed requests and errors reported by the UI. */
  errors: string[];
}

const pathKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Absolute paths of the scanned folders (the root included). */
function scannedDirs(repo: RepoModel): Set<string> {
  const paths: string[] = new Array(repo.names.length);
  paths[0] = repo.root;
  const out = new Set([pathKey(repo.root)]);
  for (let i = 1; i < repo.names.length; i++) {
    if (repo.kind[i] !== K_DIR) continue;
    paths[i] = join(paths[repo.parent[i]], repo.names[i]);
    out.add(pathKey(paths[i]));
  }
  return out;
}

export class VisualizerPanel {
  private static readonly panels = new Map<string, VisualizerPanel>();
  /** Every live panel, including custom editors (which are not keyed by URI). */
  private static readonly instances = new Set<VisualizerPanel>();
  readonly diagnostics: PanelDiagnostics;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingNavigate: HostEvent | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  /** Repo views: folders of the last scan, so changes in ignored folders (node_modules, dist, .git…) don't trigger rescans. */
  private scannedDirs: Set<string> | null = null;

  static readonly viewType = 'structlens.visualizer';

  /** Opens (or reveals) the visualizer for a URI. */
  static async open(services: Services, uri: vscode.Uri, opts: OpenOptions = {}): Promise<VisualizerPanel> {
    const { mode, target } = await classify(uri);
    const key = target.uri;
    const existing = VisualizerPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, true);
      existing.navigate(opts);
      return existing;
    }
    const column = opts.beside === false ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(VisualizerPanel.viewType, `${target.name} · StructLens`, { viewColumn: column, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(services.context.extensionUri, 'dist', 'webview')],
    });
    return new VisualizerPanel(services, panel, mode, target, opts);
  }

  /** Restores a panel after a window reload. */
  static revive(services: Services, panel: vscode.WebviewPanel, state: { mode: Mode; target: Target; view?: ViewId }): VisualizerPanel {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(services.context.extensionUri, 'dist', 'webview')] };
    return new VisualizerPanel(services, panel, state.mode, state.target, { view: state.view });
  }

  static forUri(uri: vscode.Uri): VisualizerPanel | undefined {
    return VisualizerPanel.panels.get(uri.toString());
  }

  static all(): VisualizerPanel[] {
    return [...VisualizerPanel.instances];
  }

  constructor(
    private readonly services: Services,
    readonly panel: vscode.WebviewPanel,
    readonly mode: Mode,
    readonly target: Target,
    private readonly initial: OpenOptions,
    private readonly registerKey = true,
  ) {
    if (registerKey) VisualizerPanel.panels.set(target.uri, this);
    VisualizerPanel.instances.add(this);
    this.diagnostics = { name: target.name, mode, ready: false, requests: {}, errors: [] };
    panel.iconPath = {
      light: vscode.Uri.joinPath(services.context.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(services.context.extensionUri, 'media', 'tab-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: UiToHost) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === target.uri && e.contentChanges.length) this.scheduleChanged(350);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() !== target.uri || !uiSettings().followCursor) return;
        // Ignore selections we caused when revealing nodes.
        if (e.kind === undefined || e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => {
          const pos = e.selections[0].active;
          this.post({ type: 'cursor', uri: target.uri, line: pos.line, offset: mode === 'data' ? e.textEditor.document.offsetAt(pos) : undefined });
        }, 120);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('structlens')) this.post({ type: 'settings', settings: uiSettings() });
      }),
    );
    // Files changed on disk (and folders, for repo views).
    const uri = vscode.Uri.parse(target.uri);
    if (uri.scheme === 'file') {
      const pattern = mode === 'repo' ? new vscode.RelativePattern(uri, '**/*') : new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), basename(uri.path));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onDisk = (changed: vscode.Uri) => {
        if (mode !== 'repo' && vscode.workspace.textDocuments.some((d) => d.uri.toString() === target.uri && d.isDirty)) return;
        if (mode === 'repo' && this.scannedDirs && !this.scannedDirs.has(pathKey(changed.fsPath)) && !this.scannedDirs.has(pathKey(dirname(changed.fsPath)))) return;
        if (mode === 'repo') this.services.invalidate(uri);
        this.scheduleChanged(mode === 'repo' ? 1500 : 250);
      };
      this.disposables.push(watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk));
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const base = vscode.Uri.joinPath(this.services.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      'worker-src blob:',
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>StructLens</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.__STRUCTLENS__ = { host: 'vscode' };</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private initPayload(): InitPayload {
    return {
      mode: this.mode,
      target: this.target,
      view: this.initial.view,
      symbol: this.initial.symbol,
      line: this.initial.line,
      compare: this.initial.compare,
      settings: uiSettings(),
      host: 'vscode',
      capabilities: { reveal: !isBinaryFormat(this.target.format), code: true, repo: vscode.Uri.parse(this.target.uri).scheme === 'file', settings: true, edit: !isBinaryFormat(this.target.format) },
      version: VERSION,
    };
  }

  private post(event: HostEvent): void {
    if (!this.ready && event.type !== 'init') {
      if (event.type === 'navigate') this.pendingNavigate = event;
      return;
    }
    void this.panel.webview.postMessage({ kind: 'event', event });
  }

  private scheduleChanged(ms: number): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.post({ type: 'changed', uri: this.target.uri, version: ++this.version }), ms);
  }

  navigate(opts: OpenOptions): void {
    if (opts.view || opts.symbol || opts.line !== undefined || opts.compare) this.post({ type: 'navigate', view: opts.view, symbol: opts.symbol, line: opts.line, compare: opts.compare });
  }

  private async onMessage(m: UiToHost): Promise<void> {
    if (m.kind === 'ready') {
      this.ready = true;
      this.diagnostics.ready = true;
      void this.panel.webview.postMessage({ kind: 'event', event: { type: 'init', payload: this.initPayload() } });
      if (this.pendingNavigate) this.post(this.pendingNavigate);
      this.pendingNavigate = null;
      return;
    }
    if (m.kind === 'log') {
      if (m.level === 'error') this.diagnostics.errors.push(m.message);
      this.services.log(`[${this.target.name}] ${m.level}: ${m.message}`);
      return;
    }
    if (m.kind !== 'request') return;
    try {
      const result = await this.handle(m);
      this.diagnostics.requests[m.method] = (this.diagnostics.requests[m.method] ?? 0) + 1;
      void this.panel.webview.postMessage({ kind: 'response', id: m.id, result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.diagnostics.errors.push(`${m.method}: ${message}`);
      void this.panel.webview.postMessage({ kind: 'response', id: m.id, error: message });
    }
  }

  /** Absolute URIs pass through; plain paths are workspace-relative (call graphs, CLI-style ids). */
  private resolveUri(uri: string): vscode.Uri {
    if (uri.includes('://')) return vscode.Uri.parse(uri);
    const target = vscode.Uri.parse(this.target.uri);
    const base = this.services.folderFor(target) ?? (this.mode === 'repo' ? target : vscode.Uri.joinPath(target, '..'));
    return base.with({ path: posix.join(base.path, uri) });
  }

  private async handle(req: RpcRequest): Promise<unknown> {
    const s = this.services;
    switch (req.method) {
      case 'getData': {
        const { uri } = req.params as RequestMap['getData']['params'];
        const u = this.resolveUri(uri);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === u.toString());
        const raw = doc ? new TextEncoder().encode(doc.getText()) : await vscode.workspace.fs.readFile(u);
        // workspace.fs returns a Node Buffer, whose toJSON() would turn it into {type, data} in postMessage:
        // send a plain Uint8Array (zero-copy when the Buffer owns its memory).
        const bytes = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength ? new Uint8Array(raw.buffer) : new Uint8Array(raw);
        return { bytes, version: doc?.version ?? this.version };
      }
      case 'getOutline': {
        const u = this.resolveUri((req.params as RequestMap['getOutline']['params']).uri);
        const { text, languageId } = await s.readText(u);
        return (await analyzeCode(vscode.workspace.asRelativePath(u, false), text, languageId)) ?? null;
      }
      case 'getFunction': {
        const p = req.params as RequestMap['getFunction']['params'];
        const u = this.resolveUri(p.uri);
        const { text, languageId } = await s.readText(u);
        return (await analyzeFunction(vscode.workspace.asRelativePath(u, false), text, { symbolId: p.symbolId, line: p.line }, languageId)) ?? null;
      }
      case 'getCallGraph': {
        const p = req.params as RequestMap['getCallGraph']['params'];
        const uris = p.uris.map((x) => (x === '.' ? (s.folderFor(vscode.Uri.parse(this.target.uri)) ?? vscode.Uri.parse(this.target.uri)) : this.resolveUri(x)));
        const ws = s.workspaceFor(uris[0]);
        // The UI addresses the focus as "<display path>#<symbol>"; map it to the workspace-relative id.
        const focus = p.focus ? (() => {
          const hash = p.focus.indexOf('#');
          const file = this.resolveUri(this.target.uri);
          return `${ws.rel(file.fsPath)}#${p.focus.slice(hash + 1)}`;
        })() : undefined;
        return ws.callGraph(uris.map((u) => u.fsPath), { focus, depth: p.depth, direction: p.direction, externals: p.externals, maxNodes: 600 });
      }
      case 'getRepo': {
        const p = req.params as RequestMap['getRepo']['params'];
        const u = this.resolveUri(p.uri);
        const repo = await s.workspaceFor(u).repo(u.fsPath, p.force);
        if (u.toString() === this.target.uri) this.scannedDirs = scannedDirs(repo);
        return repo;
      }
      case 'getDeps': {
        const p = req.params as RequestMap['getDeps']['params'];
        const u = this.resolveUri(p.uri);
        return s.workspaceFor(u).deps(u.fsPath, { under: p.under, externals: p.externals ?? true }, p.force);
      }
      case 'reveal': {
        const p = req.params as RequestMap['reveal']['params'];
        await s.reveal(this.resolveUri(p.uri), p, this.panel.viewColumn);
        return null;
      }
      case 'open': {
        const p = req.params as RequestMap['open']['params'];
        const u = this.resolveUri(p.uri);
        if (p.visualize) await VisualizerPanel.open(s, u, { view: p.view, symbol: p.symbol, beside: false });
        else await vscode.window.showTextDocument(u, { viewColumn: vscode.ViewColumn.One, preview: true });
        return null;
      }
      case 'saveFile': {
        const p = req.params as RequestMap['saveFile']['params'];
        const folder = s.folderFor(vscode.Uri.parse(this.target.uri));
        const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, p.name) : undefined, saveLabel: 'Export' });
        if (!target) return { saved: false };
        const data = typeof p.data === 'string' ? new TextEncoder().encode(p.data) : p.data;
        await vscode.workspace.fs.writeFile(target, data);
        void vscode.window.showInformationMessage(`Exported ${basename(target.fsPath)}`, 'Open').then((a) => a && vscode.commands.executeCommand('vscode.open', target));
        return { saved: true, path: target.fsPath };
      }
      case 'copyText':
        await vscode.env.clipboard.writeText((req.params as RequestMap['copyText']['params']).text);
        return null;
      case 'applyEdit': {
        const p = req.params as RequestMap['applyEdit']['params'];
        const u = this.resolveUri(p.uri);
        const doc = await vscode.workspace.openTextDocument(u);
        const range = (from: number, to: number) => new vscode.Range(doc.positionAt(from), doc.positionAt(to));
        // Offsets come from the text the view parsed: refuse if the document has moved on since.
        for (const e of p.edits) if (doc.getText(range(e.check.from, e.offset + e.length)) !== e.check.text) throw new Error('The file changed since the view loaded it. Try again in a moment.');
        const we = new vscode.WorkspaceEdit();
        for (const e of p.edits) we.replace(u, range(e.offset, e.offset + e.length), e.text);
        if (!(await vscode.workspace.applyEdit(we))) throw new Error('VS Code did not apply the edit.');
        // With no editor showing the file, an unsaved change would be invisible: save it (Undo still works in an editor).
        if (!vscode.window.visibleTextEditors.some((ed) => ed.document === doc)) await doc.save();
        return null;
      }
      case 'loadSchema': {
        const p = req.params as RequestMap['loadSchema']['params'];
        return await loadSchemaFor(this.resolveUri(p.uri), p.ref);
      }
      case 'pickDataFile': {
        const here = this.resolveUri((req.params as RequestMap['pickDataFile']['params']).uri);
        const [picked] = (await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.joinPath(here, '..'), canSelectMany: false, openLabel: 'Compare' })) ?? [];
        if (!picked) return null;
        const name = basename(picked.path);
        return { name, bytes: new Uint8Array(await vscode.workspace.fs.readFile(picked)), format: detectFormat(name) };
      }
      case 'pickSchema':
        return await pickSchema(this.resolveUri((req.params as RequestMap['pickSchema']['params']).uri));
      case 'openExternal': {
        // Only web and mail links: never command:, file: or other schemes from document content.
        const url = (req.params as RequestMap['openExternal']['params']).url;
        if (!/^(?:https?:|mailto:)/i.test(url)) throw new Error('Only web and mail links can be opened.');
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return null;
      }
      case 'setSettings':
        await saveUiSettings(req.params as RequestMap['setSettings']['params']);
        return null;
      case 'notify': {
        const p = req.params as RequestMap['notify']['params'];
        const fn = p.level === 'error' ? vscode.window.showErrorMessage : p.level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void fn(p.message);
        return null;
      }
      default:
        throw new Error(`Unknown request ${(req as RpcRequest).method}`);
    }
  }

  dispose(): void {
    if (this.registerKey && VisualizerPanel.panels.get(this.target.uri) === this) VisualizerPanel.panels.delete(this.target.uri);
    VisualizerPanel.instances.delete(this);
    clearTimeout(this.changeTimer);
    clearTimeout(this.cursorTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
