import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { fixture } from './setup';

const edgesOf = (r: Awaited<ReturnType<typeof analyzeFunction>>) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};

describe('Python outline', () => {
  it('extracts imports (incl. relative), classes, methods, decorators and docstrings', async () => {
    const { path, text } = fixture('sample.py');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('python');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => i.source)).toEqual(['os', 'json', 'typing', '.models', '..core']);
    expect(o.imports[1].names).toEqual([{ name: '*', alias: 'j' }]);
    expect(o.imports[3]).toMatchObject({ relative: 1, names: [{ name: 'User' }, { name: 'Account' }] });
    expect(o.imports[4]).toMatchObject({ relative: 2, names: [{ name: 'utils', alias: 'u' }] });
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['constant:CONSTANT', 'function:load_users', 'class:Service', 'function:validate']);
    const load = o.symbols[1];
    expect(load.doc).toBe('Load users from a JSON file.');
    expect(load.signature).toBe('(path: str, limit: int = 10) -> List[User]');
    expect(load.params).toEqual(['path', 'limit']);
    const svc = o.symbols[2];
    expect(svc.bases).toEqual(['Base']);
    expect(svc.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['field:count', 'constructor:__init__', 'method:make', 'method:run']);
    expect(svc.children![2].modifiers).toEqual(['staticmethod']);
    expect(svc.children![3].modifiers).toEqual(['async']);
    expect(svc.children![1].params).toEqual(['name']);
  });
});

describe('Python flow', () => {
  it('handles elif chains, for/else, with, try/except/finally and raise', async () => {
    const { path, text } = fixture('sample.py');
    const r = (await analyzeFunction(path, text, { symbolId: 'load_users' }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['not data', 'len(data) > 1000', 'item.get("disabled")', 'len(result) >= limit']);
    expect(n.find((x) => x.kind === 'block' && x.label.startsWith('with'))!.label).toBe('with open(path) as fh');
    expect(n.find((x) => x.kind === 'loop')!.label).toBe('for item in data');
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['except ValueError as e', 'except Exception']);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('raise ValueError("empty")');
    // for/else: the else branch runs when the loop finishes normally.
    const loop = n.find((x) => x.kind === 'loop')!;
    const done = r.flow.edges.find((e) => e.from === loop.id && e.label === 'done')!;
    expect(n[done.to].label).toBe('print("done")');
    // `raise` inside except re-raises to the caller.
    expect(n.filter((x) => x.kind === 'throw').length).toBe(2);
  });

  it('handles while loops and match statements', async () => {
    const { path, text } = fixture('sample.py');
    const r = (await analyzeFunction(path, text, { symbolId: 'Service.run' }))!;
    const sw = r.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('total');
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['0', '1 | 2', '_']);
    expect(r.flow.nodes.find((x) => x.kind === 'loop')!.label).toBe('while n > 0');
  });
});

describe('Python data flow', () => {
  it('traces with-as, calls, iteration, mutation and returns', async () => {
    const { path, text } = fixture('sample.py');
    const r = await analyzeFunction(path, text, { symbolId: 'load_users' });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'path -arg-> open()',
        'open() -result-> fh',
        'fh -arg-> j.load()',
        'j.load() -result-> data',
        'data -iterate-> item',
        'item -arg-> User()',
        'User() -result-> user',
        'user -mutate-> result',
        'result -arg-> validate()',
        'result -return-> return',
      ]),
    );
  });

  it('writes fields in constructors and hides comprehension/lambda bindings', async () => {
    const { path, text } = fixture('sample.py');
    const init = await analyzeFunction(path, text, { symbolId: 'Service.__init__' });
    expect(edgesOf(init)).toEqual(['name -assign-> self.name']);
    const run = await analyzeFunction(path, text, { symbolId: 'Service.run' });
    const e = edgesOf(run);
    expect(e).toEqual(expect.arrayContaining(['n -assign-> total', 'n -arg-> range()', 'range() -result-> squares', 'total -arg-> fn()', 'fn() -return-> return']));
    expect(run!.data.nodes.some((x) => x.label === 'x')).toBe(false);
  });
});
