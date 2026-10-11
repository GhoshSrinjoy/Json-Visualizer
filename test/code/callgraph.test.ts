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
