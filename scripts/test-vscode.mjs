// Runs test/vscode/suite.js inside a real VS Code with a throw-away profile
// (your settings and extensions are not touched), optionally saving screenshots.
//   node scripts/test-vscode.mjs [--screenshots docs/screenshots] [--shot-width 1600] [--code <VS Code executable>] [--no-build]
//                                [--extension <dir>]   test an unpacked .vsix (its "extension" folder) instead of the sources
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const code = [
  flag('code'),
  process.env.VSCODE_EXECUTABLE,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  'C:/Program Files/Microsoft VS Code/Code.exe',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
  '/snap/code/current/usr/share/code/code',
].find((p) => p && existsSync(p));
if (!code) {
  console.error('VS Code not found. Pass --code <path to the VS Code executable> or set VSCODE_EXECUTABLE.');
  process.exit(2);
}

const extensionPath = flag('extension') ? resolve(flag('extension')) : root;
if (!argv.includes('--no-build') && !flag('extension')) {
  const b = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const tmp = join(root, 'test/.tmp/vscode');
const sync = join(tmp, 'sync');
rmSync(tmp, { recursive: true, force: true });
for (const d of ['user-data/User', 'extensions', 'sync']) mkdirSync(join(tmp, d), { recursive: true });
writeFileSync(
  join(tmp, 'user-data/User/settings.json'),
  JSON.stringify(
    {
      'workbench.startupEditor': 'none',
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.enableExperiments': false,
      'security.workspace.trust.enabled': false,
      'extensions.ignoreRecommendations': true,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'window.restoreWindows': 'none',
      'window.newWindowDimensions': 'maximized',
      'chat.commandCenter.enabled': false,
      'git.openRepositoryInParentFolders': 'never',
    },
    null,
    2,
  ),
);

const shots = flag('screenshots') ? resolve(flag('screenshots')) : undefined;
const port = 9300 + Math.floor(Math.random() * 600);
if (shots) {
  mkdirSync(shots, { recursive: true });
  mkdirSync(join(sync, 'screenshots'));
}

// Don't inherit the variables of a VS Code we may be running inside of.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|VSCODE_)/.test(k)));
const args = [
  root,
  `--extensionDevelopmentPath=${extensionPath}`,
  `--extensionTestsPath=${join(root, 'test/vscode/suite.js')}`,
  `--user-data-dir=${join(tmp, 'user-data')}`,
  `--extensions-dir=${join(tmp, 'extensions')}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-telemetry',
  '--new-window',
  // Keep painting while other windows cover this one (screenshots would stall otherwise).
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  ...(shots ? [`--remote-debugging-port=${port}`] : []),
];
console.log(`Launching ${code}`);
const child = spawn(code, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const relay = (stream, out) =>
  stream.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.includes('[smoke]') || /error/i.test(line)) out.write(`${line}\n`);
  });
relay(child.stdout, process.stdout);
relay(child.stderr, process.stderr);
let exited = false;
const exit = new Promise((r) => child.on('exit', (c) => ((exited = true), r(c ?? 1))));
const killer = setTimeout(() => {
  console.error('Timed out after 5 minutes.');
  child.kill();
}, 5 * 60_000);

async function screenshotLoop() {
  const { default: puppeteer } = await import('puppeteer-core');
  let browser;
  while (!browser && !exited) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    } catch {
      await sleep(500);
    }
  }
  if (!browser) return;
  const workbench = async () => (await browser.pages()).find((p) => p.url().includes('workbench'));
  while (!exited) {
    for (const req of readdirSync(sync).filter((f) => f.endsWith('.req')).sort()) {
      const name = req.replace(/^\d+-/, '').replace(/\.req$/, '');
      try {
        const page = await workbench();
        const clip = await page.evaluate((maxWidth) => {
          const title = document.querySelector('.part.titlebar')?.getBoundingClientRect().height ?? 0;
          const width = window.innerWidth;
          const scale = maxWidth ? Math.min(1, maxWidth / (width * window.devicePixelRatio)) : 1;
          return { x: 0, y: title, width, height: window.innerHeight - title, scale };
        }, Number(flag('shot-width') ?? 0));
        let timer;
        await Promise.race([
          page.screenshot({ path: join(shots, `vscode-${name}.png`), clip }),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out (is the window minimized?)')), 15_000))),
        ]).finally(() => clearTimeout(timer));
        console.log(`  screenshot vscode-${name}.png`);
      } catch (e) {
        console.error(`  screenshot ${name} skipped: ${e.message}`);
      }
      rmSync(join(sync, req));
      writeFileSync(join(sync, req.replace(/\.req$/, '.done')), '');
    }
    await sleep(200);
  }
  await browser.disconnect().catch(() => undefined);
}

if (shots) void screenshotLoop().catch((e) => console.error(`screenshots disabled: ${e.message}`));
const status = await exit;
clearTimeout(killer);
const resultFile = join(tmp, 'result.json');
if (existsSync(resultFile)) {
  const { vscode, results } = JSON.parse(readFileSync(resultFile, 'utf8'));
  console.log(`\nVS Code ${vscode}: ${results.filter((r) => r.ok).length}/${results.length} smoke steps passed`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
} else {
  console.log(`\nNo results written (see ${join(tmp, 'smoke.log')}).`);
}
process.exit(status);
