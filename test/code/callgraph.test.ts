import { describe, expect, it } from 'vitest';
import { analyzeCode } from '../../src/core/code/analyze';
import { buildCallGraph, callGraphNodeId, type ImportTargets } from '../../src/core/code/callgraph';
import './setup';

const main = `import { helper, Store } from './lib';
import * as util from './util';

export function run(input: string) {
  const s = new Store();
  s.save(input);
  helper(input);
  util.log('done');
  return local(input);
}

function local(x: string) { return x.trim(); }
`;

const lib = `export function helper(x: string) { return inner(x); }
function inner(x: string) { return x; }
export class Store {
  constructor() { this.reset(); }
  reset() {}
  save(v: string) { this.validate(v); helper(v); }
  private validate(v: string) {}
}
`;

const util = `export function log(m: string) { console.log(m); }
export function helper() {}
`;

describe('buildCallGraph', async () => {
  const files = await Promise.all(
    [['src/main.ts', main], ['src/lib.ts', lib], ['src/util.ts', util]].map(async ([path, text]) => ({ path, outline: (await analyzeCode(path, text))! })),
  );
  const imports: ImportTargets = new Map([['src/main.ts', [{ line: 0, files: ['src/lib.ts'] }, { line: 1, files: ['src/util.ts'] }]]]);
  const graph = buildCallGraph(files, imports, { externals: true });
  const name = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    return n.file ? `${n.file.replace('src/', '')}:${n.container ? n.container + '.' : ''}${n.name}` : n.name;
  };
  const edges = graph.edges.map((e) => `${name(e.from)} -> ${name(e.to)} (${e.confidence})`);

  it('resolves constructors, imports, aliases, this-calls and same-file calls', () => {
    expect(edges).toEqual(
      expect.arrayContaining([
        'main.ts:run -> lib.ts:Store.constructor (exact)',
        'main.ts:run -> lib.ts:helper (exact)',
        'main.ts:run -> util.ts:log (exact)',
        'main.ts:run -> main.ts:local (exact)',
        'lib.ts:helper -> lib.ts:inner (exact)',
        'lib.ts:Store.constructor -> lib.ts:Store.reset (exact)',
        'lib.ts:Store.save -> lib.ts:Store.validate (exact)',
        'lib.ts:Store.save -> lib.ts:helper (exact)',
        'util.ts:log -> console.log (exact)',
      ]),
    );
    // util.helper must not be confused with lib.helper from main.ts
    expect(edges).not.toContain('main.ts:run -> util.ts:helper (exact)');
  });

  it('counts callers and focuses on a node', () => {
    const helper = graph.nodes.find((n) => n.name === 'helper' && n.file === 'src/lib.ts')!;
    expect(helper.callers).toBe(2);
    const focused = buildCallGraph(files, imports, { focus: callGraphNodeId('src/lib.ts', 'helper'), depth: 1, direction: 'callers' });
    expect(focused.nodes.map((n) => n.name).sort()).toEqual(['helper', 'run', 'save']);
  });
});

const graphOf = async (sources: [string, string][], imports?: ImportTargets, options = {}) => {
  const files = await Promise.all(sources.map(async ([path, text]) => ({ path, outline: (await analyzeCode(path, text))! })));
  const g = buildCallGraph(files, imports, options);
  const label = (id: string) => (id.startsWith('ext:') ? id : id.split('#')[1]);
  return { g, edges: g.edges.map((e) => `${label(e.from)} -> ${label(e.to)} (${e.confidence})`) };
};

describe('bare calls inside a class', () => {
  it('are functions where methods need a receiver (Python, JS, PHP)', async () => {
    const py = await graphOf(
      [['coll.py', 'def save(x):\n    return x\n\nclass Repo:\n    def save(self, x):\n        return x\n    def flush(self):\n        save(1)\n        open("f")\n        self.save(2)\n    def open(self, p):\n        return p\n']],
      undefined,
      { externals: true },
    );
    expect(py.edges).toEqual(expect.arrayContaining(['Repo.flush -> save (exact)', 'Repo.flush -> ext:open (exact)', 'Repo.flush -> Repo.save (exact)']));
    expect(py.edges).not.toContain('Repo.flush -> Repo.open (exact)');
    const js = await graphOf([['a.js', 'function save() {}\nclass A {\n  save() {}\n  run() { save(); this.save(); }\n}\n']]);
    expect(js.edges.sort()).toEqual(['A.run -> A.save (exact)', 'A.run -> save (exact)']);
    const php = await graphOf([['a.php', '<?php\nfunction save() {}\nclass A {\n  function save() {}\n  function run() { save(); $this->save(); }\n}\n']]);
    expect(php.edges.sort()).toEqual(['A.run -> A.save (exact)', 'A.run -> save (exact)']);
  });

  it('can be methods where the receiver is implicit (Java, C#, C++, Ruby)', async () => {
    const java = await graphOf([['A.java', 'class A {\n  void save() {}\n  void run() { save(); }\n}\n']]);
    expect(java.edges).toEqual(['A.run -> A.save (exact)']);
    const cs = await graphOf([['A.cs', 'class A {\n  void Save() {}\n  void Run() { Save(); }\n}\n']]);
    expect(cs.edges).toEqual(['A.Run -> A.Save (exact)']);
    const cpp = await graphOf([['a.cpp', 'class A {\n  void save() {}\n  void run() { save(); }\n};\n']]);
    expect(cpp.edges).toEqual(['A.run -> A.save (exact)']);
    const rb = await graphOf([['a.rb', 'class A\n  def save(x)\n  end\n  def run\n    save(1)\n    nil\n  end\nend\n']]);
    expect(rb.edges).toEqual(['A.run -> A.save (exact)']);
  });
});

describe('module imports', () => {
  it('resolves `mod.fn()` after `from pkg import mod`', async () => {
    const sources: [string, string][] = [
      ['py/main.py', 'from app import models, views\n\ndef run():\n    models.save(1)\n    views.render()\n'],
      ['py/app/__init__.py', ''],
      ['py/app/models.py', 'def save(x):\n    return x\n'],
      ['py/app/views.py', 'def save(x):\n    return x\n\ndef render():\n    pass\n'],
    ];
    // The dependency graph links the package and each imported module, all from line 0.
    const imports: ImportTargets = new Map([
      ['py/main.py', [{ line: 0, files: ['py/app/__init__.py'] }, { line: 0, files: ['py/app/models.py'] }, { line: 0, files: ['py/app/views.py'] }]],
    ]);
    const { edges } = await graphOf(sources, imports);
    expect(edges.sort()).toEqual(['run -> render (exact)', 'run -> save (exact)']);
    const { g } = await graphOf(sources, imports);
    expect(g.edges.map((e) => e.to).sort()).toEqual(['py/app/models.py#save', 'py/app/views.py#render']);
  });
});

describe('file limit', () => {
  it('marks the graph truncated when more files than the limit were passed', async () => {
    const sources: [string, string][] = [['a.ts', 'export function a() { b(); }'], ['b.ts', 'export function b() {}'], ['c.ts', 'export function c() {}']];
    const cut = (await graphOf(sources, undefined, { maxFiles: 2 })).g;
    expect(cut.truncated).toBe(true);
    expect(cut.files).toEqual(['a.ts', 'b.ts']);
    expect(cut.nodes.map((n) => n.name)).toEqual(['a', 'b']);
    const all = (await graphOf(sources, undefined, { maxFiles: 3 })).g;
    expect(all.truncated).toBeUndefined();
    expect(all.files).toHaveLength(3);
  });
});
