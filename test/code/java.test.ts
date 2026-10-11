import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { java } from '../../src/core/code/languages/java';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(java);

type Analysis = Awaited<ReturnType<typeof analyzeFunction>>;

const edgesOf = (r: Analysis) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};

const caseLabels = (r: Analysis) => {
  const sw = r!.flow.nodes.find((n) => n.kind === 'switch')!;
  return r!.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label);
};

describe('Java outline', () => {
  it('extracts the package, imports (static and wildcard), members, modifiers and bases', async () => {
    const { path, text } = fixture('Sample.java');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('java');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => [i.source, i.names.map((n) => n.name).join()])).toEqual([
      ['java.util.List', 'List'],
      ['java.util.ArrayList', 'ArrayList'],
      ['java.lang.Math.max', 'max'],
      ['com.example.util', '*'],
    ]);
    expect(o.exports).toEqual(['Sample']);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['namespace:com.example.app', 'class:Sample']);
    const cls = o.symbols[1];
    expect(cls).toMatchObject({ modifiers: ['public'], bases: ['Base', 'Runnable'], detail: 'extends Base implements Runnable' });
    expect(cls.children!.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'field:count',
      'constructor:Sample',
      'method:run',
      'method:load',
      'method:log',
      'method:validate',
      'interface:Callback',
      'enum:Mode',
    ]);
    const [count, ctor, run, load, log, , callback, mode] = cls.children!;
    expect(count).toMatchObject({ modifiers: ['private'], detail: 'int' });
    expect(ctor).toMatchObject({ signature: '(int count)', params: ['count'], hasBody: true });
    expect(run.modifiers).toEqual(['@Override', 'public']);
    expect(load).toMatchObject({ signature: '(String path, int limit): List<String>', params: ['path', 'limit'], detail: 'throws Exception' });
    expect(log.modifiers).toEqual(['private', 'static']);
    const calls = load.calls!.map((c) => `${c.kind === 'new' ? 'new ' : ''}${c.receiver ? `${c.receiver}.` : ''}${c.name}`);
    expect(calls).toEqual(
      expect.arrayContaining(['new ArrayList', 'new IllegalArgumentException', 'path.isEmpty', 'result.add', 'String.valueOf', 'validate', 'e.getMessage', 'max']),
    );
    // The lambda's `log("lambda")` belongs to the lambda, not to `load`.
    expect(calls.filter((c) => c === 'log')).toHaveLength(5);
    expect(load.complexity).toBeGreaterThanOrEqual(12);
    expect(callback.children!.map((c) => [c.name, c.hasBody])).toEqual([['done', false]]);
    expect(mode.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['enumMember:A', 'enumMember:B']);
  });

  it('handles records, sealed interfaces, compact constructors, annotation types and Javadoc', async () => {
    const { path, text } = fixture('Shapes.java');
    const o = (await analyzeCode(path, text))!;
    expect(o.syntaxErrors).toBe(0);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'namespace:com.example.shapes',
      'interface:Shape',
      'class:Circle',
      'class:Square',
      'interface:Generated',
    ]);
    expect(o.exports).toEqual(['Shape']);
    const [, shape, circle, square, generated] = o.symbols;
    expect(shape).toMatchObject({ modifiers: ['public', 'sealed'], detail: 'permits Circle, Square', doc: 'A closed 2D shape.' });
    expect(shape.children!.map((c) => [c.name, c.hasBody, c.modifiers])).toEqual([
      ['area', false, undefined],
      ['describe', true, ['default']],
      ['of', true, ['static']],
      ['readAll', true, ['static']],
    ]);
    expect(shape.children![2].doc).toBe('Parses one kind:size spec.');
    expect(circle).toMatchObject({ modifiers: ['record'], signature: '(double radius)', bases: ['Shape'] });
    expect(circle.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['field:radius', 'constructor:Circle', 'method:area']);
    // Compact constructors take the record components implicitly.
    expect(circle.children![1].params).toEqual(['radius']);
    expect(square.children!.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'field:side',
      'field:created',
      'constructor:Square',
      'method:area',
      'method:classify',
      'method:find',
    ]);
    expect(square.children![0].modifiers).toEqual(['private', 'final']);
    expect(generated.modifiers).toEqual(['@interface']);
    expect(generated.children!.map((c) => c.signature)).toEqual(['(): String']);
  });
});

describe('Java flow', () => {
  it('handles else-if chains, loops, try/catch/finally, jumps and fall-through switch groups', async () => {
    const { path, text } = fixture('Sample.java');
    const r = (await analyzeFunction(path, text, { symbolId: 'Sample.load' }))!;
    const n = r.flow.nodes;
    const byLabel = (label: string) => n.find((x) => x.label === label)!;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual([
      'path == null',
      'path.isEmpty()',
      'i % 2 == 0',
      'result.size() > 5',
      'while count < 3',
    ]);
    const loops = n.filter((x) => x.kind === 'loop');
    expect(loops.map((x) => x.label)).toEqual(['for (int i = 0; i < limit; i++)', 'for (String s : result)', 'while (count > 0)', 'do']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['catch (IllegalStateException | NullPointerException e)']);
    expect(n.some((x) => x.kind === 'finally')).toBe(true);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('throw new IllegalArgumentException("path");');
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return result;', 'return result;']);
    // continue -> back to the `for` header; break -> on to the for-each loop.
    expect(r.flow.edges.some((e) => e.from === byLabel('continue').id && e.to === loops[0].id && e.kind === 'continue')).toBe(true);
    expect(r.flow.edges.some((e) => e.from === byLabel('break').id && e.to === loops[1].id && e.kind === 'break')).toBe(true);
    expect(byLabel('limit').kind).toBe('switch');
    expect(caseLabels(r)).toEqual(['1', '2, 3', 'default']);
    // `case 3:` has no break, so it falls through into `default`.
    expect(r.flow.edges.some((e) => e.from === byLabel('log("few");').id && e.to === byLabel('log("many");').id)).toBe(true);
    expect(n.some((x) => x.unreachable)).toBe(false);
    // 4 ifs + 4 loops + 1 catch + 2 non-default case groups, + 1.
    expect(r.flow.complexity).toBe(12);
  });

  it('handles switch rules, try-with-resources, labeled jumps, synchronized and compact constructors', async () => {
    const { path, text } = fixture('Shapes.java');
    const classify = (await analyzeFunction(path, text, { symbolId: 'Square.classify' }))!;
    expect(caseLabels(classify)).toEqual(['Circle c when c.radius() > 10', 'Circle c', 'Square sq', 'otherwise']);
    // `case X ->` rules never fall through: each one leaves the switch.
    const ret = classify.flow.nodes.find((x) => x.kind === 'return')!;
    for (const b of classify.flow.nodes.filter((x) => x.label.startsWith('label ='))) {
      expect(classify.flow.edges.filter((e) => e.from === b.id).map((e) => e.to)).toEqual([ret.id]);
    }

    const read = (await analyzeFunction(path, text, { symbolId: 'Shape.readAll' }))!;
    const tryNode = read.flow.nodes.find((x) => x.kind === 'try')!;
    // Resources are acquired inside the try.
    const first = read.flow.edges.find((e) => e.from === tryNode.id && e.kind === 'normal')!;
    expect(read.flow.nodes[first.to].lines).toEqual(['BufferedReader in = new BufferedReader(source)', 'String line;']);
    expect(read.flow.nodes.find((x) => x.kind === 'loop')!.label).toBe('while ((line = in.readLine()) != null)');
    expect(read.flow.nodes.find((x) => x.kind === 'catch')!.label).toBe('catch (IllegalArgumentException e)');

    const find = (await analyzeFunction(path, text, { symbolId: 'Square.find' }))!;
    const outer = find.flow.nodes.find((x) => x.kind === 'loop')!;
    const cont = find.flow.nodes.find((x) => x.label === 'continue outer')!;
    const brk = find.flow.nodes.find((x) => x.label === 'break outer')!;
    const done = find.flow.nodes.find((x) => x.kind === 'return')!;
    expect(find.flow.edges).toContainEqual(expect.objectContaining({ from: cont.id, to: outer.id, kind: 'continue' }));
    expect(find.flow.edges).toContainEqual(expect.objectContaining({ from: brk.id, to: done.id, kind: 'break' }));

    const ctor = (await analyzeFunction(path, text, { symbolId: 'Square.Square' }))!;
    expect(ctor.flow.nodes.filter((x) => x.kind === 'block').map((x) => x.label)).toEqual(['this.side = side;', 'synchronized (Square.class)', 'created++;']);

    const compact = (await analyzeFunction(path, text, { line: 46 }))!;
    expect(compact.symbol.id).toBe('Circle.Circle');
    expect(compact.flow.nodes.find((x) => x.kind === 'throw')!.label).toBe('throw new IllegalArgumentException("radius");');
  });
});

describe('Java data flow', () => {
  it('traces params through calls, locals, iteration and mutation to the return value', async () => {
    const { path, text } = fixture('Sample.java');
    const r = await analyzeFunction(path, text, { symbolId: 'Sample.load' });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'new ArrayList() -result-> result',
        'path -arg-> path.isEmpty()',
        'i -arg-> String.valueOf()',
        'String.valueOf() -mutate-> result',
        'result -iterate-> s',
        's -arg-> log()',
        'result -arg-> validate()',
        'e -arg-> e.getMessage()',
        'result -arg-> result.size()',
        'max() -result-> count',
        'result -return-> return',
      ]),
    );
    const kinds = Object.fromEntries(r!.data.nodes.map((n) => [n.label, n.kind]));
    expect(kinds).toMatchObject({ path: 'param', limit: 'param', result: 'local', e: 'local' });
  });

  it('follows try-with-resources and loop conditions, and hides lambda parameters', async () => {
    const { path, text } = fixture('Shapes.java');
    const r = await analyzeFunction(path, text, { symbolId: 'Shape.readAll' });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'source -arg-> new BufferedReader()',
        'new BufferedReader() -result-> in',
        'in -arg-> in.readLine()',
        'in.readLine() -result-> line',
        'line -arg-> line.trim()',
        'line.trim() -arg-> Shape.of()',
        'Shape.of() -result-> s',
        's -mutate-> shapes',
        'limit -mutate-> shapes',
        'shapes -return-> return',
      ]),
    );
    expect(r!.data.nodes.some((n) => n.label === 'x')).toBe(false);
  });

  it('writes fields in constructors', async () => {
    const sample = fixture('Sample.java');
    expect(edgesOf(await analyzeFunction(sample.path, sample.text, { symbolId: 'Sample.Sample' }))).toEqual(['count -assign-> this.count']);
    const shapes = fixture('Shapes.java');
    expect(edgesOf(await analyzeFunction(shapes.path, shapes.text, { symbolId: 'Square.Square' }))).toEqual(['side -assign-> this.side']);
  });
});
