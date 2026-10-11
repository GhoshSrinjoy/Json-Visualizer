import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction, flattenSymbols } from '../../src/core/code/analyze';
import { buildCallGraph } from '../../src/core/code/callgraph';
import { c, cpp } from '../../src/core/code/languages/cpp';
import type { CodeSymbol } from '../../src/core/code/model';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(cpp);
registerLanguage(c);

const edgesOf = (r: Awaited<ReturnType<typeof analyzeFunction>>) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};
const kinds = (symbols: CodeSymbol[] | undefined) => (symbols ?? []).map((s) => `${s.kind}:${s.name}`);

describe('C++ outline', () => {
  it('extracts includes, macros, namespaces, classes with access sections and templates', async () => {
    const { path, text } = fixture('sample.cpp');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('cpp');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => [i.source, i.kind])).toEqual([
      ['<iostream>', 'include'],
      ['<vector>', 'include'],
      ['util/log.h', 'include'],
      ['models.hpp', 'include'],
    ]);
    expect(kinds(o.symbols)).toEqual(['macro:MAX_USERS', 'macro:SQUARE', 'namespace:app', 'function:main']);
    expect(o.symbols[1]).toMatchObject({ signature: '(x)', detail: '((x) * (x))' });

    const app = o.symbols[2];
    expect(kinds(app.children)).toEqual(['enum:Role', 'class:User', 'struct:Point', 'function:loadUsers', 'function:clamp']);
    expect(app.children![0]).toMatchObject({ detail: 'enum class' });
    expect(kinds(app.children![0].children)).toEqual(['enumMember:Admin', 'enumMember:Guest']);

    const user = app.children![1];
    expect(user.bases).toEqual(['Base']);
    expect(kinds(user.children)).toEqual(['constructor:User', 'method:greet', 'method:rename', 'field:count', 'field:name_', 'field:age_']);
    expect(user.children!.map((s) => s.modifiers)).toEqual([['public'], ['public', 'const'], ['public'], ['public', 'static'], ['private'], ['private']]);
    expect(user.children![0]).toMatchObject({ signature: '(std::string name, int age)', params: ['name', 'age'] });
    expect(user.children![1].signature).toBe('() -> std::string');
    expect(kinds(app.children![2].children)).toEqual(['field:x', 'field:y']);

    const load = app.children![3];
    expect(load.doc).toBe('Loads users from a file.');
    expect(load.signature).toBe('(const std::string& path, int limit) -> std::vector<User>');
    expect(load.params).toEqual(['path', 'limit']);
    expect(load.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'empty', receiver: 'path' }),
        expect.objectContaining({ name: 'runtime_error', receiver: 'std' }),
        expect.objectContaining({ name: 'User', kind: 'new' }),
        expect.objectContaining({ name: 'push_back', receiver: 'result' }),
        expect.objectContaining({ name: 'greet', receiver: 'u' }),
        expect.objectContaining({ name: 'validate' }),
      ]),
    );
    expect(app.children![4]).toMatchObject({ detail: 'template <typename T>', signature: '(T value, T lo, T hi) -> T', params: ['value', 'lo', 'hi'] });
    expect(o.symbols[3].calls).toEqual([expect.objectContaining({ name: 'loadUsers', receiver: 'app' })]);
    expect(o.exports).toEqual(['app::Role', 'app::User', 'app::Point', 'app::loadUsers', 'app::clamp', 'main']);
  });

  it('completes in-class declarations with their out-of-class definitions', async () => {
    const { path, text } = fixture('sample.cpp');
    const o = (await analyzeCode(path, text))!;
    const rename = flattenSymbols(o.symbols).filter((s) => s.name === 'rename');
    expect(rename).toHaveLength(1);
    expect(rename[0]).toMatchObject({ id: 'app.User.rename', kind: 'method', hasBody: true, signature: '(const std::string& name) -> void' });
    expect(text.split('\n')[rename[0].range.start.line]).toBe('void User::rename(const std::string& name) {');
  });

  it('parses declaration-only members, qualified definitions and typedefs', async () => {
    const src = [
      'class Shape {',
      'public:',
      '    virtual ~Shape() = default;',
      '    virtual double area() const = 0;',
      '    static Shape* make(int sides);',
      '};',
      'double Circle::area() const { return 3.14 * r * r; }',
      'typedef unsigned long ulong;',
      'using std::string;',
    ].join('\n');
    const o = (await analyzeCode('shape.hpp', src))!;
    expect(kinds(o.symbols)).toEqual(['class:Shape', 'function:Circle::area', 'type:ulong']);
    const [dtor, area, make] = o.symbols[0].children!;
    expect(dtor).toMatchObject({ name: '~Shape', hasBody: false, modifiers: ['public', 'virtual', 'default'] });
    expect(area).toMatchObject({ name: 'area', hasBody: false, modifiers: ['public', 'virtual', 'const', 'abstract'], signature: '() -> double' });
    expect(make).toMatchObject({ hasBody: false, modifiers: ['public', 'static'], signature: '(int sides) -> Shape*', params: ['sides'] });
    expect(o.symbols[1].hasBody).toBe(true);
    expect(o.symbols[2].detail).toBe('unsigned long');
    expect(o.imports).toEqual([{ source: 'std::string', names: [{ name: 'string' }], kind: 'using', line: 8 }]);
    expect((await analyzeCode('util.h', '#define LIMIT 3\n'))!.language).toBe('cpp');
  });
});

describe('C++ flow', () => {
  it('handles else-if chains, loops, try/catch, jumps, returns and throws', async () => {
    const { path, text } = fixture('sample.cpp');
    const r = (await analyzeFunction(path, text, { symbolId: 'app.loadUsers' }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['path.empty()', 'path.size() > 100', 'i % 2 == 0', 'result.size() > 5', 'while n > 0']);
    expect(n.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual(['for (int i = 0; i < limit; ++i)', 'for (auto& u : result)', 'while (n < 3)', 'do']);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['catch (const std::exception& e)']);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe('throw std::runtime_error("empty");');
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return result;', 'return result;']);
    // continue -> back to the loop header; break -> leaves for the range-for loop.
    const [loop, range] = n.filter((x) => x.kind === 'loop');
    const cont = n.find((x) => x.label === 'continue')!;
    expect(r.flow.edges.some((e) => e.from === cont.id && e.to === loop.id && e.kind === 'continue')).toBe(true);
    const brk = n.find((x) => x.kind === 'jump' && x.label === 'break')!;
    expect(r.flow.edges.find((e) => e.from === brk.id)).toMatchObject({ to: range.id, kind: 'break' });
    expect(n.find((x) => x.label === 'User u("x", i);')!.lines).toEqual(['User u("x", i);', 'result.push_back(u);']);
    expect(n.some((x) => x.unreachable)).toBe(false);
  });

  it('merges fallthrough case labels and falls into the next case', async () => {
    const { path, text } = fixture('sample.cpp');
    const r = (await analyzeFunction(path, text, { symbolId: 'app.loadUsers' }))!;
    const sw = r.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('limit');
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['1', '2, 3', 'default']);
    const few = r.flow.nodes.find((x) => x.label === 'log("few");')!;
    const many = r.flow.nodes.find((x) => x.label === 'log("many");')!;
    expect(r.flow.edges.some((e) => e.from === few.id && e.to === many.id && e.kind === 'normal')).toBe(true);
  });

  it('turns #ifdef blocks in function bodies into branches', async () => {
    const src = 'int f(int x) {\n#ifdef DEBUG\n  log(x);\n#else\n  return 0;\n#endif\n  for (;;) { if (x) break; }\n  return x;\n}\n';
    const r = (await analyzeFunction('f.cpp', src, { symbolId: 'f' }))!;
    const d = r.flow.nodes.find((x) => x.kind === 'decision')!;
    expect(d.label).toBe('#ifdef DEBUG');
    expect(r.flow.edges.filter((e) => e.from === d.id).map((e) => r.flow.nodes[e.to].label)).toEqual(['log(x);', 'return 0;']);
    // `for (;;)` only exits through break.
    const loop = r.flow.nodes.find((x) => x.kind === 'loop')!;
    expect(r.flow.edges.filter((e) => e.from === loop.id).map((e) => e.kind)).toEqual(['normal']);
  });
});

describe('C++ data flow', () => {
  it('traces params through calls, declarations, iteration and mutation to the return value', async () => {
    const { path, text } = fixture('sample.cpp');
    const r = await analyzeFunction(path, text, { symbolId: 'app.loadUsers' });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'path -arg-> path.empty()',
        'path -arg-> path.size()',
        'i -assign-> u',
        'u -mutate-> result',
        'result -iterate-> u',
        'u -arg-> u.greet()',
        'u.greet() -arg-> log()',
        'result -arg-> validate()',
        'result -return-> return',
      ]),
    );
    const kindOf = Object.fromEntries(r!.data.nodes.map((x) => [x.label, x.kind]));
    expect(kindOf).toMatchObject({ path: 'param', limit: 'param', result: 'local', i: 'local' });
    // Lambda parameters stay inside the lambda.
    expect(r!.data.nodes.some((x) => x.label === 'x')).toBe(false);
  });

  it('writes fields through this->', async () => {
    const { path, text } = fixture('sample.cpp');
    const r = await analyzeFunction(path, text, { symbolId: 'app.User.rename' });
    expect(edgesOf(r)).toEqual(['name -assign-> this.name_']);
    expect(r!.data.nodes.find((x) => x.label === 'this.name_')!.kind).toBe('field');
  });
});

describe('C', () => {
  it('analyzes .c files with the C spec', async () => {
    const { path, text } = fixture('sample.c');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('c');
    expect(o.languageName).toBe('C');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => i.source)).toEqual(['<stdio.h>', 'config.h']);
    expect(kinds(o.symbols)).toEqual(['macro:BUF_SIZE', 'macro:MIN', 'struct:Record', 'enum:Status', 'variable:counter', 'function:parse', 'function:main']);
    expect(kinds(o.symbols[2].children)).toEqual(['field:id', 'field:name']);
    expect(o.symbols[5]).toMatchObject({
      modifiers: ['static'],
      doc: 'Parses one record and returns a status code.',
      signature: '(const char* line, Record* out) -> int',
      params: ['line', 'out'],
    });
    // `static` functions and globals have internal linkage.
    expect(o.exports).toEqual(['Record', 'Status', 'main']);
  });

  it('builds flow and data flow for C functions, including goto', async () => {
    const { path, text } = fixture('sample.c');
    const parse = (await analyzeFunction(path, text, { symbolId: 'parse' }))!;
    const n = parse.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['!line']);
    const jump = n.find((x) => x.kind === 'jump')!;
    expect(jump.label).toBe('goto fail');
    expect(parse.flow.edges.some((e) => e.from === jump.id)).toBe(false);
    expect(n.find((x) => x.kind === 'loop')!.label).toBe('while (*line)');
    expect(edgesOf(parse)).toEqual(expect.arrayContaining(['n -mutate-> out', 'n -assign-> counter']));

    const main = (await analyzeFunction(path, text, { symbolId: 'main' }))!;
    const sw = main.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('parse(argv[i], &r)');
    expect(main.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['OK', 'default']);
    expect(edgesOf(main)).toEqual(expect.arrayContaining(['argv -arg-> parse()', 'r -arg-> printf()']));
  });
});

describe('C++ call graph', () => {
  it('resolves direct-initialisation to the constructor', async () => {
    const { path, text } = fixture('sample.cpp');
    const graph = buildCallGraph([{ path, outline: (await analyzeCode(path, text))! }]);
    const name = (id: string) => id.split('#')[1];
    expect(graph.edges.map((e) => `${name(e.from)} -> ${name(e.to)} (${e.confidence})`)).toContain('app.loadUsers -> app.User.User (exact)');
  });
});
