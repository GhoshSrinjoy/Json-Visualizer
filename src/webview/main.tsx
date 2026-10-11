/** Entry point: picks the host (VS Code webview, CLI server or plain browser) and mounts the app. */

import { render } from 'preact';
import { App } from './App';
import { BrowserHost } from './host/browser';
import { VsCodeHost, type Host } from './host/host';
import { ServerHost } from './host/server';
import { runtime } from './store';
import './styles/app.css';

function createHost(): Host {
  const kind = window.__STRUCTLENS__?.host ?? (typeof acquireVsCodeApi === 'function' ? 'vscode' : 'browser');
  if (kind === 'vscode') {
    document.body.classList.add('vscode-host');
    return new VsCodeHost();
  }
  if (kind === 'server') return new ServerHost();
  return new BrowserHost();
}

runtime.host = createHost();
render(<App />, document.getElementById('app') ?? document.body);
