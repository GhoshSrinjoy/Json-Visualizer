// Captures UI screenshots through the real CLI server (dev aid + README images).
//   node scripts/screenshot.mjs --path test/fixtures/data/users.json --view graph --out shot.png [--theme light] [--size 1440x900]
//   node scripts/screenshot.mjs --batch shots.json    (array of {path, view, out, theme, size, eval, waitFor})
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function startCli(root) {
  const child = spawn(process.execPath, [resolve('dist/cli.js'), 'open', root, '--no-browser', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((res, rej) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/.exec(buf);
      if (m) res(m[1]);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => rej(new Error(`cli exited ${code}`)));
    setTimeout(() => rej(new Error('cli did not start')), 15000);
  });
  return { child, url };
}

const jobs = flag('batch') ? JSON.parse(readFileSync(flag('batch'), 'utf8')) : [{ path: flag('path', '.'), view: flag('view'), out: flag('out', 'screenshot.png'), theme: flag('theme'), size: flag('size'), wait: Number(flag('wait', '1200')) }];
const root = resolve(flag('root', '.'));
const { child, url } = await startCli(root);
const browser = await puppeteer.launch({ executablePath: BROWSERS.find((b) => existsSync(b)), headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
try {
  for (const job of jobs) {
    const [w, h] = (job.size ?? '1440x900').split('x').map(Number);
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: Number(job.scale ?? 1) });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    if (job.theme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: job.theme }]);
    const u = new URL(url);
    u.searchParams.set('path', job.path);
    if (job.view) u.searchParams.set('view', job.view);
    if (job.symbol) u.searchParams.set('symbol', job.symbol);
    // The live-reload SSE stream keeps the network busy, so wait for load + content instead.
    await page.goto(u.toString(), { waitUntil: 'load' });
    await page.waitForSelector(job.waitFor ?? '.graph-canvas, .vlist, .schema, .welcome, .center-msg, .stats, textarea', { timeout: 15000 }).catch(() => undefined);
    if (job.waitFor) await page.waitForSelector(job.waitFor, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, job.wait ?? 1200));
    if (job.eval) {
      await page.evaluate(job.eval);
      await new Promise((r) => setTimeout(r, job.evalWait ?? 800));
    }
    mkdirSync(dirname(resolve(job.out)), { recursive: true });
    await page.screenshot({ path: job.out });
    console.log(`saved ${job.out}${errors.length ? `  (page errors: ${errors.join(' | ')})` : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  child.kill();
}
