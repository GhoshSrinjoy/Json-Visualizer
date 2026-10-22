import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupClient } from '../../src/cli/setup';
import { findNode, quoteForCmd, runSync, which } from '../../src/node/exec';

describe('quoteForCmd', () => {
  it('quotes spaces and escapes cmd metacharacters', () => {
    expect(quoteForCmd('C:\\Users\\Srinjoy Ghosh\\cli.js')).toBe('^"C:\\Users\\Srinjoy^ Ghosh\\cli.js^"');
    expect(quoteForCmd('a&calc')).toBe('^"a^&calc^"');
    expect(quoteForCmd('100%')).toBe('^"100^%^"');
  });

  it('keeps embedded quotes and trailing backslashes intact for the program', () => {
    expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(quoteForCmd('C:\\dir\\')).toBe('^"C:\\dir\\\\^"');
  });
});

describe('which', () => {
  it('finds node on PATH and ignores missing commands', () => {
    expect(which(process.platform === 'win32' ? 'node.exe' : 'node')).toBeTruthy();
    expect(which('definitely-not-a-real-command-xyz')).toBeUndefined();
  });
});

describe('findNode', () => {
  it('returns the absolute path of a recent enough node on PATH', () => {
    const node = findNode(18);
    expect(node && isAbsolute(node)).toBe(true);
    expect(existsSync(node!)).toBe(true);
    expect(findNode(10_000)).toBeUndefined();
  });

  it('finds nothing when PATH has no node', () => {
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    process.env.PATH = '';
    delete process.env.Path;
    try {
      expect(findNode()).toBeUndefined();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.Path !== undefined) process.env.Path = saved.Path;
    }
  });
});

describe('setup claude (user scope)', () => {
  it('passes the launch environment and keeps paths with spaces as single arguments', () => {
    const lines = setupClient('claude', {
      scope: 'user',
      dryRun: true,
      launch: { command: 'C:\\Program Files\\Code\\Code.exe', args: ['C:\\Users\\A B\\cli.js', 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    });
    expect(lines[0]).toBe('Would run: claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 structlens -- "C:\\Program Files\\Code\\Code.exe" "C:\\Users\\A B\\cli.js" mcp');
  });
});

describe.runIf(process.platform === 'win32')('runSync through a .cmd shim', () => {
  it('delivers arguments with spaces and cmd metacharacters unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'structlens exec '));
    try {
      writeFileSync(join(dir, 'print.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      // Same shape as the shims npm generates for global commands.
      writeFileSync(join(dir, 'tool.cmd'), `@"${process.execPath}" "%~dp0\\print.js" %*\r\n`);
      const args = ['C:\\Users\\A B\\cli.js', 'a&b', '(x)', 'semi;colon', 'mcp'];
      const r = runSync(join(dir, 'tool.cmd'), args);
      expect(r?.status).toBe(0);
      expect(JSON.parse(r!.stdout)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
