// Smoke test that runs inside a real VS Code window (launched by scripts/test-vscode.mjs):
// activation, commands, Copilot tools, every webview, the custom editor, and an
// external agent (the MCP server over stdio) opening a view through the bridge.
// When the runner takes screenshots it creates sync/screenshots and answers *.req files.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'test/.tmp/vscode');
const SYNC = path.join(TMP, 'sync');
const file = (rel) => vscode.Uri.file(path.join(ROOT, rel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function log(message) {
  console.log(`[smoke] ${message}`);
  fs.appendFileSync(path.join(TMP, 'smoke.log'), `${message}\n`);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitFor(what, fn, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

let shot = 0;
async function snapshot(name, settle = 1800) {
  if (!fs.existsSync(path.join(SYNC, 'screenshots'))) return;
  await sleep(settle);
  const base = path.join(SYNC, `${String(++shot).padStart(2, '0')}-${name}`);
  fs.writeFileSync(`${base}.req`, '');
  await waitFor(`screenshot ${name}`, () => fs.existsSync(`${base}.done`), 30_000);
}

/** Waits until the named panel is ready and has answered `method` at least `count` times. */
function panel(api, name, method, count = 1) {
  return waitFor(`${name} → ${method}`, () => {
    const p = api.panels().find((x) => x.name === name);
    if (p && p.errors.length) throw new Error(`${name}: ${p.errors.join('; ')}`);
    return p && p.ready && (p.requests[method] ?? 0) >= count ? p : undefined;
  });
}

/** Fails if the panel reported errors after it had time to finish rendering. */
async function settled(api, name, ms = 1200) {
  await sleep(ms);
  const p = api.panels().find((x) => x.name === name);
  assert(p, `panel ${name} is gone`);
  assert(!p.errors.length, `${name}: ${p.errors.join('; ')}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    log(`✓ ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    log(`✗ ${name}: ${e.stack ?? e.message}`);
  }
}

/** Each scenario starts from an empty editor area (clean screenshots, and panels get disposed/re-created). */
const closeAll = () => vscode.commands.executeCommand('workbench.action.closeAllEditors');

async function showEditor(rel, line) {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  const pos = new vscode.Position(line, 4);
  return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos), preview: false });
}

function toolText(result) {
  return result.content.map((p) => (typeof p.value === 'string' ? p.value : '')).join('');
}

/** A minimal MCP client over stdio (newline-delimited JSON-RPC). */
function mcpClient(args) {
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/cli.js'), 'mcp', ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  let seq = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => log(`mcp stderr: ${String(d).trim()}`));
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`MCP ${method} timed out`))), 20_000);
    });
  return {
    async initialize() {
      const r = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'structlens-smoke', version: '0' } });
      send({ method: 'notifications/initialized' });
      return r;
    },
    call,
    close: () => child.kill(),
  };
}

exports.run = async function run() {
  fs.mkdirSync(TMP, { recursive: true });
  const ext = vscode.extensions.getExtension('GhoshSrinjoy.structlens');
  assert(ext, 'StructLens extension not found');
  const api = await ext.activate();
  const manifest = ext.packageJSON;
  log(`VS Code ${vscode.version}, StructLens ${api.version}`);

  await step('activation and commands', async () => {
    assert(api.version === manifest.version, `API version ${api.version} != ${manifest.version}`);
    const commands = new Set(await vscode.commands.getCommands(true));
    const missing = manifest.contributes.commands.map((c) => c.command).filter((c) => !commands.has(c));
    assert(!missing.length, `commands not registered: ${missing.join(', ')}`);
  });

  await step('Copilot language model tools', async () => {
    const tools = vscode.lm.tools.filter((t) => t.name.startsWith('structlens_'));
    assert(tools.length === manifest.contributes.languageModelTools.length, `${tools.length} tools registered, expected ${manifest.contributes.languageModelTools.length}`);
    const overview = toolText(await vscode.lm.invokeTool('structlens_repo_overview', { input: {}, toolInvocationToken: undefined }));
    assert(/files/i.test(overview) && overview.includes('src'), `unexpected repo_overview output: ${overview.slice(0, 200)}`);
    const flow = toolText(await vscode.lm.invokeTool('structlens_code_flow', { input: { path: 'test/fixtures/code/sample.ts', function: 'loadUsers', format: 'mermaid' }, toolInvocationToken: undefined }));
    assert(flow.includes('flowchart'), `unexpected code_flow output: ${flow.slice(0, 200)}`);
    const query = toolText(await vscode.lm.invokeTool('structlens_data_query', { input: { path: 'test/fixtures/data/users.json', query: '$.users[0].name' }, toolInvocationToken: undefined }));
    assert(query.includes('Ada Lovelace'), `unexpected data_query output: ${query.slice(0, 200)}`);
    const bad = toolText(await vscode.lm.invokeTool('structlens_file_structure', { input: { path: '../outside.json' }, toolInvocationToken: undefined }));
    assert(/outside|not found|workspace/i.test(bad), `path confinement not reported: ${bad.slice(0, 200)}`);
  });

  await step('data graph (JSON)', async () => {
    await closeAll();
    await vscode.commands.executeCommand('structlens.openFile', file('test/fixtures/data/users.json'));
    await panel(api, 'users.json', 'getData');
    await snapshot('data-graph');
  });

  await step('code logic flow', async () => {
    await closeAll();
    await showEditor('test/fixtures/code/sample.ts', 12);
    await vscode.commands.executeCommand('structlens.showFlow');
    await panel(api, 'sample.ts', 'getFunction');
    await snapshot('code-flow');
  });

  await step('code data flow', async () => {
    await showEditor('test/fixtures/code/sample.ts', 12);
    await vscode.commands.executeCommand('structlens.showDataFlow');
    await sleep(500);
    await panel(api, 'sample.ts', 'getFunction');
    await snapshot('code-dataflow');
  });

  await step('call graph', async () => {
    await showEditor('test/fixtures/code/sample.ts', 12);
    await vscode.commands.executeCommand('structlens.showCalls');
    await panel(api, 'sample.ts', 'getCallGraph');
    await snapshot('code-calls');
  });

  await step('code structure', async () => {
    await showEditor('test/fixtures/code/sample.ts', 12);
    await vscode.commands.executeCommand('structlens.showStructure');
    await panel(api, 'sample.ts', 'getOutline');
    await snapshot('code-structure');
  });

  const repoName = path.basename(ROOT);
  await step('repository files', async () => {
    await closeAll();
    await vscode.commands.executeCommand('structlens.openFolder', vscode.Uri.file(ROOT));
    await panel(api, repoName, 'getRepo');
    await snapshot('repo-files');
  });

  await step('repository treemap', async () => {
    await vscode.commands.executeCommand('structlens.showTreemap', vscode.Uri.file(ROOT));
    await snapshot('repo-treemap');
  });

  await step('dependency graph', async () => {
    await closeAll();
    await vscode.commands.executeCommand('structlens.showDependencies', file('src'));
    await panel(api, 'src', 'getDeps');
    await snapshot('repo-deps', 2500);
  });

  await step('custom editor (YAML)', async () => {
    const yaml = path.join(TMP, 'deployment.yaml');
    fs.writeFileSync(
      yaml,
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: web',
        '  labels: { app: web, tier: frontend }',
        'spec:',
        '  replicas: 3',
        '  selector:',
        '    matchLabels: { app: web }',
        '  template:',
        '    metadata:',
        '      labels: { app: web }',
        '    spec:',
        '      containers:',
        '        - name: web',
        '          image: nginx:1.27',
        '          ports: [{ containerPort: 80 }]',
        '          resources:',
        '            limits: { cpu: 500m, memory: 256Mi }',
        '        - name: sidecar',
        '          image: busybox',
        '          args: [sh, -c, "tail -f /dev/null"]',
        '',
      ].join('\n'),
    );
    await closeAll();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(yaml), 'structlens.dataEditor');
    await panel(api, 'deployment.yaml', 'getData');
    await snapshot('custom-editor-yaml');
  });

  await step('Excel workbook (custom editor + table)', async () => {
    await closeAll();
    await vscode.commands.executeCommand('vscode.openWith', file('test/fixtures/data/sales.xlsx'), 'structlens.dataEditor');
    await panel(api, 'sales.xlsx', 'getData');
    await settled(api, 'sales.xlsx');
    await closeAll();
    await api.open(file('test/fixtures/data/sales.xlsx'), { view: 'table' });
    await panel(api, 'sales.xlsx', 'getData');
    await settled(api, 'sales.xlsx');
    await snapshot('excel-table', 600);
  });

  await step('external agent opens a view (MCP → bridge)', async () => {
    const bridgeFile = path.join(os.homedir(), '.structlens', 'bridges', `${process.pid}.json`);
    assert(fs.existsSync(bridgeFile), `bridge file missing: ${bridgeFile}`);
    await closeAll();
    await showEditor('test/fixtures/code/sample.py', 10);
    const client = mcpClient(['--root', ROOT, '--no-browser']);
    try {
      const init = await client.initialize();
      assert(init.serverInfo?.name, 'MCP initialize returned no serverInfo');
      const list = await client.call('tools/list', {});
      assert(list.tools.length === manifest.contributes.languageModelTools.length, `MCP lists ${list.tools.length} tools`);
      const r = await client.call('tools/call', { name: 'open_visualizer', arguments: { path: 'test/fixtures/code/sample.py', view: 'flow', function: 'load_users' } });
      const text = r.content.map((c) => c.text ?? '').join('');
      assert(text.includes(vscode.env.appName), `open_visualizer did not reach this window: ${text}`);
    } finally {
      client.close();
    }
    await panel(api, 'sample.py', 'getFunction');
    await snapshot('agent-opened-flow');
  });

  await step('light theme', async () => {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    await closeAll();
    await showEditor('test/fixtures/code/sample.ts', 12);
    await vscode.commands.executeCommand('structlens.showFlow');
    await panel(api, 'sample.ts', 'getFunction');
    await snapshot('code-flow-light', 2200);
    await closeAll();
    await api.open(vscode.Uri.file(ROOT), { view: 'treemap' });
    await panel(api, repoName, 'getRepo');
    await snapshot('repo-treemap-light');
  });

  fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify({ vscode: vscode.version, results, panels: api.panels() }, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${failed.length} smoke step(s) failed: ${failed.map((f) => f.name).join(', ')}`);
};
