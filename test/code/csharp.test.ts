import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { csharp } from '../../src/core/code/languages/csharp';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(csharp);

type Analysis = Awaited<ReturnType<typeof analyzeFunction>>;

const SERVICE = 'MyApp.Services.UserService';
const CANVAS = 'Demo.Geometry.Canvas';

const edgesOf = (r: Analysis) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};

const caseLabels = (r: Analysis) => {
  const sw = r!.flow.nodes.find((n) => n.kind === 'switch')!;
  return r!.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label);
};

describe('C# outline', () => {
  it('extracts usings (incl. aliases), namespaces, types, members, modifiers and bases', async () => {
    const { path, text } = fixture('Sample.cs');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('csharp');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => [i.source, i.kind])).toEqual([
      ['System', 'using'],
      ['System.Collections.Generic', 'using'],
      ['MyApp.Utilities', 'using'],
    ]);
    expect(o.imports[0].names).toEqual([{ name: '*' }]);
    expect(o.imports[2].names).toEqual([{ name: '*', alias: 'Util' }]);
    expect(o.exports).toEqual(['IService', 'UserService', 'Point', 'Mode']);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['namespace:MyApp.Services']);
    const [iface, svc, point, mode] = o.symbols[0].children!;
    expect(o.symbols[0].children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['interface:IService', 'class:UserService', 'struct:Point', 'enum:Mode']);
    expect(svc).toMatchObject({ id: SERVICE, modifiers: ['public'], bases: ['BaseService', 'IService'] });
    expect(svc.children!.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'field:_names',
      'property:Count',
      'constructor:UserService',
      'method:Run',
      'method:LoadAsync',
      'method:Log',
      'method:Validate',
    ]);
    const [names, count, ctor, run, load, log] = svc.children!;
    expect(names).toMatchObject({ modifiers: ['private', 'readonly'], detail: 'List<string>' });
    expect(count).toMatchObject({ modifiers: ['public'], detail: 'int { get; set; }' });
    expect(ctor).toMatchObject({ signature: '(int count)', params: ['count'], hasBody: true });
    // Expression-bodied members have a body too.
    expect(run).toMatchObject({ signature: '(): void', hasBody: true });
    expect(load).toMatchObject({ signature: '(string path, int limit = 10): Task<List<string>>', params: ['path', 'limit'], modifiers: ['public', 'async'] });
    expect(log.modifiers).toEqual(['private', 'static']);
    const calls = load.calls!.map((c) => `${c.kind === 'new' ? 'new ' : ''}${c.receiver ? `${c.receiver}.` : ''}${c.name}`);
    expect(calls).toEqual(
      expect.arrayContaining(['new List', 'new ArgumentNullException', 'nameof', 'result.Add', 'i.ToString', 'Log', 'Validate', 'Math.Max']),
    );
    expect(load.complexity).toBeGreaterThanOrEqual(10);
    expect(iface.children!.map((c) => [c.name, c.hasBody])).toEqual([['Run', false]]);
    expect(point.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['field:X', 'field:Y']);
    expect(mode.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['enumMember:A', 'enumMember:B']);
  });

  it('handles file-scoped namespaces, records, accessors, events and XML docs', async () => {
    const { path, text } = fixture('Geometry.cs');
    const o = (await analyzeCode(path, text))!;
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => i.source)).toEqual(['System.Text', 'System.Math']);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['namespace:Demo.Geometry']);
    const ns = o.symbols[0];
    expect(ns.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['class:Point', 'struct:Size', 'class:Canvas']);
    const [point, size, canvas] = ns.children!;
    // `namespace X;` owns the rest of the file.
    expect(ns.range.end).toEqual(canvas.range.end);
    expect(point).toMatchObject({ id: 'Demo.Geometry.Point', modifiers: ['public', 'record'], signature: '(double X, double Y)', doc: 'An immutable 2D point.' });
    expect(point.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['property:X', 'property:Y', 'property:Length']);
    expect(point.children![2]).toMatchObject({ hasBody: true, calls: [expect.objectContaining({ name: 'Sqrt' })] });
    expect(size).toMatchObject({ modifiers: ['public', 'record'], signature: '(int Width, int Height)' });
    expect(canvas.bases).toEqual(['IDisposable']);
    const members = Object.fromEntries(canvas.children!.map((c) => [c.name, c]));
    expect(members._sync).toMatchObject({ kind: 'field', modifiers: ['private', 'readonly'] });
    expect(members.Changed).toMatchObject({ kind: 'field', modifiers: ['public', 'event'] });
    expect(members.Title).toMatchObject({ kind: 'property', detail: 'string { get; private set; }' });
    // Accessors with bodies are callable children; setters get the implicit `value`.
    expect(members.Version.children!.map((c) => [c.name, c.kind, c.params])).toEqual([
      ['get', 'method', []],
      ['set', 'method', ['value']],
    ]);
    expect(members.Render.doc).toBe('Renders the points scaled by a factor.');
    // Target-typed `new(…)` is named after the type it creates.
    expect(members.Scale.calls).toEqual([expect.objectContaining({ name: 'Point', kind: 'new' })]);
    expect(o.exports).toEqual(['Point', 'Size', 'Canvas']);
  });
});

describe('C# flow', () => {
  it('handles else-if chains, loops, try/catch/finally, jumps and merges empty switch sections', async () => {
    const { path, text } = fixture('Sample.cs');
    const r = (await analyzeFunction(path, text, { symbolId: `${SERVICE}.LoadAsync` }))!;
    const n = r.flow.nodes;
    const byLabel = (label: string) => n.find((x) => x.label === label)!;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['path == null', 'path.Length == 0', 'i % 2 == 0', 'result.Count > 5']);
    const loops = n.filter((x) => x.kind === 'loop');
    expect(loops.map((x) => x.label)).toEqual(['for (int i = 0; i < limit; i++)', 'foreach (var name in _names)']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['catch (InvalidOperationException ex)']);
    expect(n.some((x) => x.kind === 'finally')).toBe(true);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('throw new ArgumentNullException(nameof(path));');
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return result;', 'return result;']);
    expect(r.flow.edges.some((e) => e.from === byLabel('continue').id && e.to === loops[0].id && e.kind === 'continue')).toBe(true);
    expect(r.flow.edges.some((e) => e.from === byLabel('break').id && e.to === loops[1].id && e.kind === 'break')).toBe(true);
    expect(byLabel('limit').kind).toBe('switch');
    expect(caseLabels(r)).toEqual(['1', '2, 3', 'default']);
    // Non-empty sections end in `break`: nothing falls into the next section.
    expect(r.flow.edges.some((e) => e.from === byLabel('Log("few");').id && e.to === byLabel('Log("many");').id)).toBe(false);
    expect(n.filter((x) => x.label === 'break').length).toBe(4);
    expect(n.some((x) => x.unreachable)).toBe(false);
  });

  it('treats expression bodies as implicit returns', async () => {
    const { path, text } = fixture('Sample.cs');
    const r = (await analyzeFunction(path, text, { symbolId: `${SERVICE}.Run` }))!;
    expect(r.flow.nodes.map((x) => `${x.kind}:${x.label}`)).toEqual(['start:Run(): void', 'end:end', 'return:return Console.WriteLine("run")']);
  });

  it('handles pattern sections, yield, using/lock blocks and do/while loops', async () => {
    const { path, text } = fixture('Geometry.cs');
    const desc = (await analyzeFunction(path, text, { symbolId: `${CANVAS}.Describe` }))!;
    expect(caseLabels(desc)).toEqual(['Point { X: 0, Y: 0 }', 'Point p when p.X > 0, Size', 'null', 'default']);
    expect(desc.flow.nodes.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return "origin";', 'return "positive";', 'return "other";']);
    expect(desc.flow.nodes.find((x) => x.kind === 'throw')!.label).toBe('throw new ArgumentNullException(nameof(shape));');

    const visible = (await analyzeFunction(path, text, { symbolId: `${CANVAS}.Visible` }))!;
    // `yield break` ends the iterator; `yield return` continues the loop.
    expect(visible.flow.nodes.find((x) => x.label === 'yield break;')!.kind).toBe('return');
    const loop = visible.flow.nodes.find((x) => x.kind === 'loop')!;
    const produce = visible.flow.nodes.find((x) => x.label === 'yield return p;')!;
    expect(visible.flow.edges).toContainEqual(expect.objectContaining({ from: produce.id, to: loop.id, kind: 'back' }));

    const render = (await analyzeFunction(path, text, { symbolId: `${CANVAS}.Render` }))!;
    expect(render.flow.nodes.filter((x) => x.kind === 'block').map((x) => x.label)).toEqual(
      expect.arrayContaining(['using (var writer = new StringWriter())', 'writer.Write(labels);', 'lock (_sync)', '_version++;']),
    );

    const clamp = (await analyzeFunction(path, text, { symbolId: `${CANVAS}.Clamp` }))!;
    expect(clamp.flow.nodes.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual(['while (value > max)', 'do']);
    expect(clamp.flow.nodes.find((x) => x.kind === 'decision')!.label).toBe('while value < 0');
  });
});

describe('C# data flow', () => {
  it('traces params through calls, locals, iteration and mutation to the return value', async () => {
    const { path, text } = fixture('Sample.cs');
    const r = await analyzeFunction(path, text, { symbolId: `${SERVICE}.LoadAsync` });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'new List() -result-> result',
        'path -arg-> nameof()',
        'nameof() -arg-> new ArgumentNullException()',
        'i -arg-> i.ToString()',
        'i.ToString() -mutate-> result',
        '_names -iterate-> name',
        'name -arg-> Log()',
        'result -arg-> Validate()',
        'ex -arg-> Log()',
        'result -arg-> Math.Max()',
        'Math.Max() -result-> Count',
        'result -return-> return',
      ]),
    );
    const kinds = Object.fromEntries(r!.data.nodes.map((n) => [n.label, n.kind]));
    expect(kinds).toMatchObject({ path: 'param', limit: 'param', result: 'local', ex: 'local', _names: 'external' });
    // `x => x + 1` binds its own x.
    expect(r!.data.nodes.some((n) => n.label === 'x')).toBe(false);
  });

  it('follows foreach, using headers and target-typed new, and hides lambda locals', async () => {
    const { path, text } = fixture('Geometry.cs');
    const render = await analyzeFunction(path, text, { symbolId: `${CANVAS}.Render` });
    expect(edgesOf(render)).toEqual(
      expect.arrayContaining([
        'points -iterate-> p',
        'p -arg-> Scale()',
        'scale -arg-> Scale()',
        'Scale() -result-> scaled',
        'scaled -mutate-> sb',
        'points -arg-> points.Select()',
        'points.Select() -result-> labels',
        'new StringWriter() -result-> writer',
        'labels -mutate-> writer',
        'sb -arg-> sb.ToString()',
        'sb.ToString() -return-> return',
      ]),
    );
    expect(render!.data.nodes.some((n) => n.label === 'q' || n.label === 'text')).toBe(false);
    // `p.X * factor` arguments (which the grammar reads as declarations) still read both operands.
    const scale = await analyzeFunction(path, text, { symbolId: `${CANVAS}.Scale` });
    expect(edgesOf(scale)).toEqual(['p -arg-> new Point()', 'factor -arg-> new Point()', 'new Point() -return-> return']);
  });

  it('writes fields in constructors and passes `value` through setters', async () => {
    const geometry = fixture('Geometry.cs');
    const ctor = await analyzeFunction(geometry.path, geometry.text, { symbolId: `${CANVAS}.Canvas` });
    expect(edgesOf(ctor)).toEqual(['title -assign-> this.Title']);
    const setter = await analyzeFunction(geometry.path, geometry.text, { symbolId: `${CANVAS}.Version.set` });
    expect(edgesOf(setter)).toContain('value -assign-> _version');
    // Unqualified members are plain names: there is no symbol table to resolve them to fields.
    const sample = fixture('Sample.cs');
    const svc = await analyzeFunction(sample.path, sample.text, { symbolId: `${SERVICE}.UserService` });
    expect(edgesOf(svc)).toEqual(['count -assign-> Count']);
  });
});
