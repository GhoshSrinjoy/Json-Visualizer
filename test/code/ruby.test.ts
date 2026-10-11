import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { buildCallGraph } from '../../src/core/code/callgraph';
import { ruby } from '../../src/core/code/languages/ruby';
import type { CodeSymbol } from '../../src/core/code/model';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(ruby);

const edgesOf = (r: Awaited<ReturnType<typeof analyzeFunction>>) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};
const kinds = (symbols: CodeSymbol[] | undefined) => (symbols ?? []).map((s) => `${s.kind}:${s.name}`);

describe('Ruby outline', () => {
  it('extracts requires, modules, classes, methods, visibility and docs', async () => {
    const { path, text } = fixture('sample.rb');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('ruby');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports).toEqual([
      { source: 'json', names: [{ name: '*' }], kind: 'require', line: 0 },
      { source: 'models/user', names: [{ name: '*' }], kind: 'require', line: 1 },
    ]);
    expect(kinds(o.symbols)).toEqual(['module:App']);
    expect(o.exports).toEqual(['App']);

    const cls = o.symbols[0].children![0];
    expect(cls).toMatchObject({ id: 'App.UserLoader', kind: 'class', bases: ['Base', 'Enumerable'], doc: 'Loads users from a JSON file.' });
    expect(kinds(cls.children)).toEqual([
      'property:path',
      'constructor:initialize',
      'method:build',
      'method:default',
      'method:load',
      'method:validate',
      'method:fetch',
    ]);
    const m = Object.fromEntries(cls.children!.map((s) => [s.name, s]));
    expect(m.path.detail).toBe('attr_reader');
    expect(m.initialize.params).toEqual(['path']);
    expect(m.build.modifiers).toEqual(['static']);
    expect(m.default.modifiers).toEqual(['static']);
    expect(m.load.modifiers).toBeUndefined();
    expect(m.validate.modifiers).toEqual(['private']);
    expect(m.fetch.modifiers).toEqual(['private']);
    expect(m.load).toMatchObject({ signature: '(limit = 10)', params: ['limit'], hasBody: true });
    expect(m.load.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'parse', receiver: 'JSON' }),
        expect.objectContaining({ name: 'read', receiver: 'File' }),
        expect.objectContaining({ name: 'each', receiver: 'data' }),
        expect.objectContaining({ name: '<<', receiver: 'result' }),
        // `User.new(…)` is named like the class so the call graph finds `initialize`.
        expect.objectContaining({ name: 'User', receiver: undefined }),
        expect.objectContaining({ name: 'raise' }),
        expect.objectContaining({ name: 'validate' }),
      ]),
    );
  });

  it('handles visibility arguments, attribute lists, writers, constants and class variables', async () => {
    const src = [
      'VERSION = "1.0"',
      'class Account < Struct::Base',
      '  attr_accessor :name, :email',
      '  @@count = 0',
      '  LIMIT = 3',
      '  def save; end',
      '  def touch',
      '    self.updated = now',
      '  end',
      '  private :save',
      '  protected def audit(entry) = log(entry)',
      'end',
    ].join('\n');
    const o = (await analyzeCode('account.rb', src))!;
    expect(kinds(o.symbols)).toEqual(['constant:VERSION', 'class:Account']);
    const cls = o.symbols[1];
    expect(cls.bases).toEqual(['Struct::Base']);
    expect(kinds(cls.children)).toEqual(['property:name', 'property:email', 'field:@@count', 'constant:LIMIT', 'method:save', 'method:touch', 'method:audit']);
    const m = Object.fromEntries(cls.children!.map((s) => [s.name, s]));
    expect(m.save).toMatchObject({ modifiers: ['private'], hasBody: false });
    expect(m.audit).toMatchObject({ modifiers: ['protected'], params: ['entry'], hasBody: true });
    // `self.updated = x` calls the writer `updated=`.
    expect(m.touch.calls!.map((c) => `${c.receiver}.${c.name}`)).toEqual(['self.updated=']);
  });
});

describe('Ruby flow', () => {
  it('handles elsif chains, iterator loops with next/break, begin/rescue/ensure and case/when', async () => {
    const { path, text } = fixture('sample.rb');
    const r = (await analyzeFunction(path, text, { symbolId: 'App.UserLoader.load' }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual([
      'data.nil?',
      'data.empty?',
      'item["disabled"]',
      'result.size >= limit',
      'not (result.empty?)',
    ]);
    expect(n.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual(['data.each do |item|', 'while limit > 0']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['rescue StandardError => e']);
    expect(n.some((x) => x.kind === 'finally')).toBe(true);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('raise ArgumentError, "nil"');
    // The last expression is the method's value.
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return []', 'return result']);
    const sw = n.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('result.size');
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['0', '1, 2', 'else']);
    // next -> back to the iterator; break -> leaves it.
    const each = n.find((x) => x.kind === 'loop')!;
    const next = n.find((x) => x.label === 'next')!;
    expect(r.flow.edges.some((e) => e.from === next.id && e.to === each.id && e.kind === 'continue')).toBe(true);
    const brk = n.find((x) => x.label === 'break')!;
    expect(r.flow.edges.find((e) => e.from === brk.id)).toMatchObject({ to: n.find((x) => x.kind === 'try')!.id, kind: 'break' });
    expect(n.some((x) => x.unreachable)).toBe(false);
  });

  it('treats method-level rescue/ensure as an implicit begin and negates until', async () => {
    const { path, text } = fixture('sample.rb');
    const r = (await analyzeFunction(path, text, { symbolId: 'App.UserLoader.fetch' }))!;
    const n = r.flow.nodes;
    const tryNode = n.find((x) => x.kind === 'try')!;
    expect(r.flow.edges.find((e) => e.from === 0)!.to).toBe(tryNode.id);
    expect(n.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual(['while not (tries >= attempts)', 'for n in 1..attempts']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['rescue IOError => e']);
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['attempts > 1']);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('raise');
    expect(n.some((x) => x.kind === 'finally')).toBe(true);
    // Statements inside begin/rescue are not implicit returns.
    expect(n.some((x) => x.kind === 'return')).toBe(false);
  });

  it('converts statement modifiers, loop do, do-while and case/in', async () => {
    const src = [
      'def run(queue)',
      '  loop do',
      '    job = queue.pop',
      '    break unless job',
      '    job.call rescue nil',
      '  end',
      '  begin',
      '    tick',
      '  end while busy?',
      '  wait until ready?',
      '  case queue.first',
      '  in Integer => n if n > 0 then n',
      '  in [a, *]',
      '    a',
      '  end',
      'end',
    ].join('\n');
    const r = (await analyzeFunction('run.rb', src, { symbolId: 'run' }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual(['loop', 'do', 'while not (ready?)']);
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['not (job)', 'while busy?']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['rescue']);
    const sw = n.find((x) => x.kind === 'switch')!;
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['Integer => n if n > 0', '[a, *]', 'otherwise']);
    // `loop do … end` only exits through break.
    const loop = n.find((x) => x.label === 'loop')!;
    expect(r.flow.edges.some((e) => e.from === loop.id && e.kind === 'false')).toBe(false);
  });
});

describe('Ruby data flow', () => {
  it('traces params and fields through calls, iteration and appends to the implicit return', async () => {
    const { path, text } = fixture('sample.rb');
    const r = await analyzeFunction(path, text, { symbolId: 'App.UserLoader.load' });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        '@path -arg-> File.read()',
        'File.read() -arg-> JSON.parse()',
        'JSON.parse() -result-> data',
        'data -iterate-> item',
        'item -arg-> User()',
        'User() -mutate-> result',
        'result -arg-> validate()',
        'result -return-> return',
      ]),
    );
    const kindOf = Object.fromEntries(r!.data.nodes.map((x) => [x.label, x.kind]));
    expect(kindOf).toMatchObject({ limit: 'param', data: 'local', item: 'local', result: 'local', '@path': 'field' });
  });

  it('writes instance variables and hides block parameters', async () => {
    const { path, text } = fixture('sample.rb');
    const init = await analyzeFunction(path, text, { symbolId: 'App.UserLoader.initialize' });
    expect(edgesOf(init)).toEqual(['path -assign-> @path']);
    const validate = await analyzeFunction(path, text, { symbolId: 'App.UserLoader.validate' });
    expect(edgesOf(validate)).toEqual(expect.arrayContaining(['users -arg-> users.all?()', 'users.all?() -return-> return']));
    expect(validate!.data.nodes.some((x) => x.label === 'u')).toBe(false);
    const fetch = await analyzeFunction(path, text, { symbolId: 'App.UserLoader.fetch' });
    expect(edgesOf(fetch)).toEqual(expect.arrayContaining(['attempts -iterate-> n', 'n -arg-> log()']));
  });
});

describe('Ruby call graph', () => {
  it('resolves constructors, implicit-self calls and class methods', async () => {
    const { path, text } = fixture('sample.rb');
    const graph = buildCallGraph([{ path, outline: (await analyzeCode(path, text))! }]);
    const name = (id: string) => id.split('#')[1];
    const edges = graph.edges.map((e) => `${name(e.from)} -> ${name(e.to)} (${e.confidence})`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'App.UserLoader.build -> App.UserLoader.initialize (exact)',
        'App.UserLoader.default -> App.UserLoader.build (exact)',
        'App.UserLoader.load -> App.UserLoader.validate (exact)',
      ]),
    );
  });
});
