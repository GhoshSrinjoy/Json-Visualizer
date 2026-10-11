import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction, flattenSymbols, MODULE_SYMBOL } from '../../src/core/code/analyze';
import { fixture } from './setup';

describe('TypeScript outline', () => {
  it('extracts imports, exports and nested symbols', async () => {
    const { path, text } = fixture('sample.ts');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('typescript');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => [i.source, i.kind])).toEqual([
      ['node:fs/promises', 'import'],
      ['path', 'import'],
      ['./util', 'import'],
      ['./other', 'export-from'],
    ]);
    expect(o.imports[2].names).toEqual([{ name: 'default', alias: 'Default' }, { name: 'helper', alias: 'h' }]);
    expect(o.exports).toEqual(expect.arrayContaining(['other', 'Shape', 'Color', 'loadUsers', 'User']));
    const top = o.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(top).toEqual(['interface:Shape', 'type:Id', 'enum:Color', 'function:loadUsers', 'class:User', 'function:validate', 'function:format']);
    const load = o.symbols.find((s) => s.name === 'loadUsers')!;
    expect(load.doc).toBe('Loads users and keeps the active ones.');
    expect(load.signature).toBe('(file: string, limit = 10): Promise<User[]>');
    expect(load.modifiers).toEqual(['export', 'async']);
    expect(load.params).toEqual(['file', 'limit']);
    expect(load.complexity).toBeGreaterThanOrEqual(7);
    expect(load.calls!.map((c) => c.name)).toEqual(expect.arrayContaining(['readFile', 'parse', 'isArray', 'User', 'push', 'validate', 'error', 'h']));
    const user = o.symbols.find((s) => s.name === 'User')!;
    expect(user.bases).toEqual(['Base', 'Shape']);
    expect(user.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['property:count', 'constructor:constructor', 'method:area', 'property:label', 'method:describe']);
    expect(flattenSymbols(o.symbols).find((s) => s.id === 'User.describe')).toBeTruthy();
  });
});

describe('TypeScript flow', () => {
  it('builds a control-flow graph with decisions, loops, jumps and try/catch', async () => {
    const { path, text } = fixture('sample.ts');
    const r = (await analyzeFunction(path, text, { symbolId: 'loadUsers' }))!;
    const kinds = r.flow.nodes.map((n) => n.kind);
    expect(kinds.filter((k) => k === 'decision').length).toBe(4);
    expect(kinds).toContain('loop');
    expect(kinds).toContain('try');
    expect(kinds).toContain('catch');
    expect(kinds).toContain('finally');
    expect(r.flow.nodes.filter((n) => n.kind === 'return').map((n) => n.label)).toEqual(['return [];', 'return result;']);
    expect(r.flow.nodes.find((n) => n.kind === 'throw')!.label).toBe("throw new Error('bad data');");
    const loop = r.flow.nodes.find((n) => n.kind === 'loop')!;
    expect(loop.label).toBe('for (const item of data)');
    // continue -> back to the loop header; break -> leaves the loop
    const cont = r.flow.nodes.find((n) => n.label === 'continue')!;
    expect(r.flow.edges.some((e) => e.from === cont.id && e.to === loop.id && e.kind === 'continue')).toBe(true);
    const brk = r.flow.nodes.find((n) => n.label === 'break')!;
    expect(r.flow.edges.some((e) => e.from === brk.id && e.kind === 'break')).toBe(true);
    expect(r.flow.nodes.some((n) => n.unreachable)).toBe(false);
    // Straight-line statements are merged into blocks.
    const first = r.flow.nodes.find((n) => n.kind === 'block')!;
    expect(first.lines).toEqual(["const raw = await readFile(file, 'utf8');", 'const data = JSON.parse(raw);', 'let result: User[] = [];']);
    expect(r.flow.complexity).toBeGreaterThanOrEqual(7);
  });

  it('handles switch fallthrough by merging case labels', async () => {
    const { path, text } = fixture('sample.ts');
    const r = (await analyzeFunction(path, text, { symbolId: 'User.describe' }))!;
    const sw = r.flow.nodes.find((n) => n.kind === 'switch')!;
    expect(sw.label).toBe('kind');
    const labels = r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label);
    expect(labels).toEqual(["'short'", "'long', 'full'", 'default']);
  });

  it('finds the function at a line and supports module-level flow', async () => {
    const { path, text } = fixture('sample.ts');
    const r = (await analyzeFunction(path, text, { line: 60 }))!;
    expect(r.symbol.name).toBe('validate');
    expect(r.flow.nodes.some((n) => n.kind === 'loop' && n.label.startsWith('while'))).toBe(true);
    expect(r.flow.nodes.some((n) => n.kind === 'loop' && n.label === 'do')).toBe(true);
    const mod = (await analyzeFunction(path, text, { symbolId: MODULE_SYMBOL }))!;
    expect(mod.flow.nodes.length).toBeGreaterThan(3);
  });
});

describe('TypeScript data flow', () => {
  it('traces params through calls and locals to the return value', async () => {
    const { path, text } = fixture('sample.ts');
    const r = (await analyzeFunction(path, text, { symbolId: 'loadUsers' }))!;
    const label = (id: string) => r.data.nodes.find((n) => n.id === id)?.label;
    const edges = r.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'file -arg-> readFile()',
        'readFile() -result-> raw',
        'raw -arg-> JSON.parse()',
        'JSON.parse() -result-> data',
        'data -iterate-> item',
        'item -arg-> new User()',
        'new User() -result-> user',
        'user -mutate-> result',
        'result -arg-> validate()',
        'result -return-> return',
      ]),
    );
    const kinds = Object.fromEntries(r.data.nodes.map((n) => [n.label, n.kind]));
    expect(kinds.file).toBe('param');
    expect(kinds.limit).toBe('param');
    expect(kinds.raw).toBe('local');
  });

  it('tracks fields written in constructors', async () => {
    const { path, text } = fixture('sample.js');
    const r = (await analyzeFunction(path, text, { symbolId: 'Cache.constructor' }))!;
    const label = (id: string) => r.data.nodes.find((n) => n.id === id)?.label;
    expect(r.data.edges.map((e) => `${label(e.from)}->${label(e.to)}`)).toContain('limit->this.limit');
  });
});

describe('JavaScript CommonJS', () => {
  it('detects require/dynamic imports and module.exports', async () => {
    const { path, text } = fixture('sample.js');
    const o = (await analyzeCode(path, text))!;
    expect(o.imports.map((i) => `${i.kind}:${i.source}`)).toEqual(['require:fs', 'require:path', 'dynamic:./lazy.js']);
    expect(o.imports[1].names).toEqual([{ name: 'join' }]);
    expect(o.exports.sort()).toEqual(['Cache', 'readAll']);
    expect(o.symbols.map((s) => s.name)).toEqual(['fs', 'join', 'Cache', 'readAll']);
  });
});
