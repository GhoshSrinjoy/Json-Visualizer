import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, setJsonEntry, setTomlTable } from '../../src/cli/config-edit';
import { defaultLaunch, NPX_UNSUPPORTED, setupClient } from '../../src/cli/setup';

const launch = { command: '/usr/bin/node', args: ['/opt/structlens/dist/cli.js', 'mcp'] };
const entry = { command: launch.command, args: launch.args };
const entryText = (indent: string) =>
  JSON.stringify(entry, null, 2)
    .split('\n')
    .join('\n' + indent);

let project = '';
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'structlens-setup-'));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function cursorConfig(text: string | undefined): string {
  const path = join(project, '.cursor', 'mcp.json');
  if (text !== undefined) {
    mkdirSync(join(project, '.cursor'), { recursive: true });
    writeFileSync(path, text);
  }
  return path;
}

describe('setup writes absolute launch commands', () => {
  it('uses the absolute Node.js and cli.js paths, never npx', () => {
    const l = defaultLaunch('dist/cli.js');
    expect(l.command).toBe(process.execPath);
    expect(isAbsolute(l.command)).toBe(true);
    expect(l.args).toEqual([resolve('dist/cli.js'), 'mcp']);
    expect(JSON.stringify(setupClient('json', { launch: defaultLaunch('dist/cli.js') }))).not.toContain('npx');
    expect(NPX_UNSUPPORTED).toMatch(/not published on npm/);
  });
});

describe('setup edits JSON configs minimally', () => {
  it('adds the server and keeps comments, trailing commas and formatting', () => {
    const before = [
      '// Cursor MCP servers',
      '{',
      '  /* keep this */',
      '  "mcpServers": {',
      '    "other": { "command": "x", "args": ["a"] } // trailing comment',
      '  },',
      '  "keepMe": true, // and this',
      '}',
      '',
    ].join('\n');
    const path = cursorConfig(before);
    expect(setupClient('cursor', { project, launch })).toEqual([`Added "structlens" in ${path}`]);
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '// Cursor MCP servers',
        '{',
        '  /* keep this */',
        '  "mcpServers": {',
        '    "other": { "command": "x", "args": ["a"] }, // trailing comment',
        `    "structlens": ${entryText('    ')}`,
        '  },',
        '  "keepMe": true, // and this',
        '}',
        '',
      ].join('\n'),
    );
    // Running it again changes nothing.
    expect(setupClient('cursor', { project, launch })[0]).toMatch(/already up to date/);
  });

  it('replaces only the value of an existing entry', () => {
    const before = '{\n  "mcpServers": {\n    "structlens": { "command": "npx", "args": ["-y", "structlens@latest", "mcp"] }, // old\n    "b": {}\n  }\n}\n';
    const path = cursorConfig(before);
    expect(setupClient('cursor', { project, launch })).toEqual([`Updated "structlens" in ${path}`]);
    expect(readFileSync(path, 'utf8')).toBe(`{\n  "mcpServers": {\n    "structlens": ${entryText('    ')}, // old\n    "b": {}\n  }\n}\n`);
  });

  it('adds the section when it is missing, with the file’s indentation and line endings', () => {
    const tabs = '{\r\n\t"theme": "dark"\r\n}\r\n';
    const out = setJsonEntry(tabs, 'mcpServers', 'structlens', entry, 'settings.json');
    expect(out.text).toBe(`{\r\n\t"theme": "dark",\r\n\t"mcpServers": ${JSON.stringify({ structlens: entry }, null, '\t').split('\n').join('\r\n\t')}\r\n}\r\n`);
    expect(out).toMatchObject({ existed: false, changed: true });
  });

  it('handles empty files, empty objects, comment-only objects and one-line objects', () => {
    expect(setJsonEntry('', 'servers', 'structlens', entry, 'f').text).toBe(JSON.stringify({ servers: { structlens: entry } }, null, 2) + '\n');
    expect(setJsonEntry('{}\n', 'servers', 'structlens', entry, 'f').text).toBe(JSON.stringify({ servers: { structlens: entry } }, null, 2) + '\n');
    expect(setJsonEntry('{ // nothing yet\n}\n', 'servers', 'structlens', entry, 'f').text).toBe(
      `{ // nothing yet\n  "servers": ${JSON.stringify({ structlens: entry }, null, 2).split('\n').join('\n  ')}\n}\n`,
    );
    expect(setJsonEntry('{"a": 1}', 'servers', 'structlens', entry, 'f').text).toBe(`{"a": 1, "servers": ${JSON.stringify({ structlens: entry })}}`);
    expect(setJsonEntry('// just a comment\n', 'servers', 'structlens', entry, 'f').text).toBe(`// just a comment\n${JSON.stringify({ servers: { structlens: entry } }, null, 2)}\n`);
  });

  it('keeps the comments of a VS Code mcp.json', () => {
    const before = '{\n  // keep this comment\n  "servers": { "x": { "command": "a" } }, // trailing comment\n}\n';
    mkdirSync(join(project, '.vscode'));
    writeFileSync(join(project, '.vscode', 'mcp.json'), before);
    setupClient('vscode', { project, launch });
    const after = readFileSync(join(project, '.vscode', 'mcp.json'), 'utf8');
    expect(after).toContain('// keep this comment');
    expect(after).toContain('}, // trailing comment');
    expect(after.startsWith('{\n  // keep this comment\n  "servers": { "x": { "command": "a" }, "structlens": {')).toBe(true);
  });

  it.each([
    ['a missing comma', '{\n  // my servers\n  "mcpServers": {\n    "other": { "command": "x", "args": ["a"] }\n    "another": { "command": "y" }\n  },\n  "keepMe": true\n}\n', /line 5, column 5/],
    ['a stray word', '{\n  "mcpServers": { "other": { "command": "x" } },\n  oops\n  "keepMe": true\n}\n', /line 4, column 3/],
    ['an unclosed array', '{\n  "mcpServers": { "other": { "command": "x" } },\n  "a": [1, 2,\n  "keepMe": true\n}\n', /syntax error at line/],
    ['an unterminated string', '{\n  "mcpServers": { "other": { "command": "x" } },\n  "keepMe": "unterminated\n}\n', /line 3, column 13/],
    ['two documents', '{}\n{}\n', /more than one JSON value/],
    ['an array', '[]\n', /does not contain a JSON object/],
  ])('refuses to touch a config with %s', (_, before, message) => {
    const path = cursorConfig(before);
    expect(() => setupClient('cursor', { project, launch })).toThrow(ConfigError);
    expect(() => setupClient('cursor', { project, launch })).toThrow(message);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses when the servers section is not an object', () => {
    const before = '{ "mcpServers": [] }';
    const path = cursorConfig(before);
    expect(() => setupClient('cursor', { project, launch })).toThrow(/"mcpServers" .* is not an object/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('creates missing files and folders', () => {
    const path = cursorConfig(undefined);
    expect(existsSync(path)).toBe(false);
    setupClient('cursor', { project, launch });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { structlens: entry } });
  });
});

describe('setup edits TOML (Codex) configs minimally', () => {
  const body = { command: launch.command, args: launch.args };
  const block = '[mcp_servers.structlens]\ncommand = "/usr/bin/node"\nargs = ["/opt/structlens/dist/cli.js", "mcp"]';

  it('appends the table and keeps the rest byte for byte', () => {
    const before = '# Codex settings\nmodel = "o4" # inline comment\n\n[mcp_servers.other]\ncommand = "x"\nargs = [\n  "a", # why\n]\n';
    const out = setTomlTable(before, ['mcp_servers', 'structlens'], body, 'config.toml');
    expect(out.text).toBe(`${before}\n${block}\n`);
    expect(out).toMatchObject({ existed: false, changed: true });
    expect(setTomlTable('model = "o4"', ['mcp_servers', 'structlens'], body, 'f').text).toBe(`model = "o4"\n\n${block}\n`);
    expect(setTomlTable('', ['mcp_servers', 'structlens'], body, 'f').text).toBe(`${block}\n`);
  });

  it('replaces only the table, its keys and its sub-tables', () => {
    const before = [
      '# top',
      '[mcp_servers.structlens]',
      'command = "npx" # old',
      'args = [',
      '  "-y",',
      '  "structlens@latest",',
      ']',
      '',
      '[mcp_servers.structlens.env]',
      'OLD = "1"',
      '',
      '# The next server',
      '[mcp_servers.other]',
      'command = "x"',
      '',
    ].join('\n');
    const out = setTomlTable(before, ['mcp_servers', 'structlens'], body, 'config.toml');
    expect(out.text).toBe(['# top', block, '', '', '# The next server', '[mcp_servers.other]', 'command = "x"', ''].join('\n'));
    expect(parseToml(out.text)).toEqual({ mcp_servers: { structlens: body, other: { command: 'x' } } });
    expect(out.existed).toBe(true);
    expect(setTomlTable(out.text, ['mcp_servers', 'structlens'], body, 'f').changed).toBe(false);
    // A byte order mark (Windows editors) stays, and the table right behind it is still found.
    const bom = setTomlTable('﻿[mcp_servers.structlens]\ncommand = "old"\n', ['mcp_servers', 'structlens'], body, 'f');
    expect(bom.text).toBe(`﻿${block}\n`);
  });

  it('writes Codex configs through setup, with CRLF line endings kept', () => {
    const home = join(project, 'codex-home');
    mkdirSync(home);
    const before = '[mcp_servers.other]\r\ncommand = "x"\r\n';
    writeFileSync(join(home, 'config.toml'), before);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(setupClient('codex', { launch })[0]).toMatch(/^Added \[mcp_servers\.structlens\]/);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(`${before}\r\n${block.split('\n').join('\r\n')}\r\n`);
  });

  it('refuses malformed TOML and definitions it cannot replace safely', () => {
    expect(() => setTomlTable('[mcp_servers.other]\ncommand = \n', ['mcp_servers', 'structlens'], body, 'config.toml')).toThrow(/config\.toml has a syntax error at line 2/);
    expect(() => setTomlTable('[mcp_servers]\nstructlens.command = "x"\n', ['mcp_servers', 'structlens'], body, 'config.toml')).toThrow(/dotted keys or an inline table/);
    expect(() => setTomlTable('mcp_servers = { other = { command = "x" } }\n', ['mcp_servers', 'structlens'], body, 'config.toml')).toThrow(/could not update config\.toml safely/i);
  });
});
