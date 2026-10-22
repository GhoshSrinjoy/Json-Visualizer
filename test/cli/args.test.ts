import { describe, expect, it } from 'vitest';
import { BOOLEAN_FLAGS, parseArgs } from '../../src/cli/args';

describe('parseArgs', () => {
  it('does not let boolean flags swallow the next argument', () => {
    expect(parseArgs(['open', '--no-browser', 'file.json'])).toEqual({ command: 'open', positional: ['file.json'], flags: { browser: false } });
    expect(parseArgs(['setup', '--dry-run', 'codex'])).toEqual({ command: 'setup', positional: ['codex'], flags: { dryRun: true } });
    expect(parseArgs(['search', 'data.json', '--regex', 'a.*b'])).toEqual({ command: 'search', positional: ['data.json', 'a.*b'], flags: { regex: true } });
    expect(parseArgs(['calls', '--externals', 'src', 'lib']).positional).toEqual(['src', 'lib']);
    expect(parseArgs(['tree', '--dirs-only', 'src', '--show-size']).flags).toEqual({ dirsOnly: true, showSize: true });
    expect(parseArgs(['outline', '--show-calls', 'a.ts']).positional).toEqual(['a.ts']);
    expect(parseArgs(['--help', 'mcp'])).toEqual({ command: 'mcp', positional: [], flags: { help: true } });
  });

  it('derives boolean flags from the tool schemas', () => {
    for (const f of ['dirsOnly', 'showSize', 'showCalls', 'regex', 'caseSensitive', 'externals', 'dryRun', 'browser', 'help']) expect(BOOLEAN_FLAGS.has(f)).toBe(true);
    for (const f of ['root', 'format', 'depth', 'http', 'port', 'view', 'token', 'scope']) expect(BOOLEAN_FLAGS.has(f)).toBe(false);
  });

  it('still reads values for other flags', () => {
    expect(parseArgs(['mcp', '--root', 'a', '--root=b', '--http', '7811', '--token', 's3cret'])).toEqual({
      command: 'mcp',
      positional: [],
      flags: { root: ['a', 'b'], http: '7811', token: 's3cret' },
    });
    expect(parseArgs(['mcp', '--http', '--no-browser']).flags).toEqual({ http: true, browser: false });
    expect(parseArgs(['schema', 'x.json', '--format', 'typescript']).flags).toEqual({ format: 'typescript' });
    expect(parseArgs(['setup', 'claude', '--dry-run=false']).flags).toEqual({ dryRun: false });
    expect(parseArgs(['query', 'x.json', '--', '--literal']).positional).toEqual(['x.json', '--literal']);
  });

  it('only treats the first word as a command', () => {
    expect(parseArgs(['data/tree']).command).toBeUndefined();
    expect(parseArgs(['data/tree']).positional).toEqual(['data/tree']);
    expect(parseArgs(['find', 'tree', 'src'])).toEqual({ command: 'find', positional: ['tree', 'src'], flags: {} });
  });
});
