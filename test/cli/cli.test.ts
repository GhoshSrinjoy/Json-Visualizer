// End-to-end checks of the CLI entry point, bundled the same way as dist/cli.js.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir = '';
let cli = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'structlens-cli-'));
  cli = join(dir, 'cli.js');
  await build({
    entryPoints: [resolve(__dirname, '../../src/cli/main.ts')],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    define: { __STRUCTLENS_VERSION__: '"test"' },
    logLevel: 'error',
  });
  writeFileSync(join(dir, 'data.json'), JSON.stringify({ users: [{ name: 'alpha' }, { name: 'beta' }] }));
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, STRUCTLENS_TOKEN: '' } });

describe('structlens CLI', () => {
  it('refuses --npx instead of writing an npx launch', () => {
    const r = run('setup', 'cursor', '--npx');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not published on npm/);
  });

  it('writes absolute paths of node and cli.js', () => {
    const r = run('setup', 'json');
    expect(r.status).toBe(0);
    const { command, args } = JSON.parse(r.stdout).mcpServers.structlens;
    expect(command).toBe(process.execPath);
    expect(isAbsolute(args[0])).toBe(true);
    expect(args).toEqual([cli, 'mcp']);
  });

  it('does not let boolean flags swallow the next argument', () => {
    const dry = run('setup', '--dry-run', 'cursor');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('Would write to');
    const search = run('search', 'data.json', '--regex', 'al.ha');
    expect(search.status).toBe(0);
    expect(search.stdout).toContain('$.users[0].name');
  });

  it('reports malformed client configs without touching them', () => {
    const project = join(dir, 'proj');
    const path = join(project, '.cursor', 'mcp.json');
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(project, '.cursor'))}, { recursive: true })`]);
    writeFileSync(path, '{ "mcpServers": { "a": {} } "oops": 1 }');
    const r = spawnSync(process.execPath, [cli, 'setup', 'cursor'], { cwd: project, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/syntax error at line 1, column \d+/);
  });

  it('rejects weak or missing HTTP tokens', () => {
    expect(run('mcp', '--http', '0', '--token', 'short').stderr).toMatch(/at least 16 characters/);
    expect(run('mcp', '--http', '0', '--token').stderr).toMatch(/--token needs one value/);
  });

  it('prints the endpoint and the token when serving MCP over HTTP', async () => {
    const token = 'pinned-token-0123456789abcdef';
    const child = spawn(process.execPath, [cli, 'mcp', '--http', '0', '--root', dir], { cwd: dir, env: { ...process.env, STRUCTLENS_TOKEN: token } });
    try {
      const banner = await new Promise<string>((resolvePromise, reject) => {
        let err = '';
        const timer = setTimeout(() => reject(new Error(`no banner: ${err}`)), 20_000);
        child.stderr.on('data', (d) => {
          err += d;
          if (err.includes('Token pinned')) {
            clearTimeout(timer);
            resolvePromise(err);
          }
        });
        child.on('exit', () => reject(new Error(`exited: ${err}`)));
      });
      const url = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(banner)?.[1];
      expect(url).toBeTruthy();
      expect(banner).toContain(`Authorization: Bearer ${token}`);
      expect(banner).toContain(`claude mcp add --transport http structlens ${url} --header "Authorization: Bearer ${token}"`);
      expect((await fetch(url!, { method: 'POST', body: '{}' })).status).toBe(401);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
    }
  });
});
