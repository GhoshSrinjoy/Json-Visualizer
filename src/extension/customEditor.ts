/**
 * "Open With… → StructLens" for data files. A read-only custom editor reads the
 * file directly (no text model), which keeps very large files fast.
 */

import * as vscode from 'vscode';
import { classify, VisualizerPanel } from './panel';
import type { Services } from './services';

export class DataEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'structlens.dataEditor';

  constructor(private readonly services: Services) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.services.context.extensionUri, 'dist', 'webview')] };
    try {
      const { mode, target } = await classify(document.uri);
      // Custom editors are not tracked by URI so the regular panel can coexist.
      new VisualizerPanel(this.services, panel, mode, target, {}, false);
    } catch (e) {
      panel.webview.html = `<body style="font-family: sans-serif; padding: 24px">${(e as Error).message}</body>`;
    }
  }
}
