import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { go } from '../../src/core/code/languages/go';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(go);

type Analysis = NonNullable<Awaited<ReturnType<typeof analyzeFunction>>>;

const { path, text } = fixture('sample.go');
const analyze = async (symbolId: string) => (await analyzeFunction(path, text, { symbolId }))!;

const edgesOf = (r: Analysis) => {
  const label = (id: string) => r.data.nodes.find((n) => n.id === id)?.label;
  return r.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};
/** Labels (or kinds) of the flow edges leaving a node. */
const exits = (r: Analysis, id: number) => r.flow.edges.filter((e) => e.from === id).map((e) => e.label ?? e.kind);
const nodeWith = (r: Analysis, label: string) => r.flow.nodes.find((n) => n.label === label)!;

describe('Go outline', () => {
  it('extracts imports with aliases, types, methods under their receivers, docs and exports', async () => {
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('go');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => i.source)).toEqual(['fmt', 'os', 'strings', 'example.com/app/internal/util', 'image/png', 'math']);
    expect(o.imports[0].names).toEqual([{ name: '*' }]);
    expect(o.imports.slice(2).map((i) => i.names[0].alias)).toEqual(['str', undefined, '_', '.']);
    expect(o.exports).toEqual(['MaxUsers', 'MinAge', 'MaxAge', 'User', 'Greeter', 'LoadUsers', 'Admin', 'Role', 'Classify']);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'constant:MaxUsers', 'constant:MinAge', 'constant:MaxAge', 'variable:verbose', 'variable:cache', 'struct:User',
      'interface:Greeter', 'function:LoadUsers', 'function:cleanup', 'struct:Admin', 'type:Role', 'method:Fetch', 'function:Classify',
    ]);
    const [max, minAge, maxAge, , cache, user, greeter, load, cleanup, admin, role, fetch] = o.symbols;
    expect(max).toMatchObject({ detail: '100', modifiers: ['export'], doc: 'MaxUsers caps how many users are loaded.' });
    expect([minAge.detail, maxAge.detail]).toEqual(['18', '120']);
    expect(maxAge.nameRange!.start.col).toBe(14);
    expect(cache.detail).toBe('map[string]User{}');

    expect(user.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['field:Name', 'field:Age', 'method:Greet']);
    const greet = user.children![2];
    expect(greet).toMatchObject({ id: 'User.Greet', signature: '() string', detail: '(u *User)', params: [], hasBody: true });
    const sprintfLine = text.split('\n').findIndex((l) => l.includes('fmt.Sprintf')); // 0-based
    expect(greet.calls).toEqual([{ name: 'Sprintf', receiver: 'fmt', line: sprintfLine, kind: undefined }]);
    expect(greeter.children!.map((c) => `${c.kind}:${c.name}:${c.hasBody}`)).toEqual(['method:Greet:false']);

    expect(load.signature).toBe('(path string, limit int) ([]User, error)');
    expect(load.params).toEqual(['path', 'limit']);
    expect(load.modifiers).toEqual(['export']);
    expect(load.complexity).toBe(9);
    expect(load.calls!.map((c) => c.name)).toEqual(expect.arrayContaining(['ReadFile', 'Errorf', 'ToUpper', 'append', 'Log', 'cleanup']));
    expect(load.calls!.find((c) => c.name === 'User')).toMatchObject({ kind: 'new' });
    // The goroutine closure is its own scope: its Println is not attributed to LoadUsers.
    expect(load.calls!.filter((c) => c.name === 'Println').length).toBe(3);
    expect(cleanup.modifiers).toBeUndefined();

    // Embedded fields are bases; a method declared before its type still nests under it.
    expect(admin).toMatchObject({ bases: ['User'], doc: 'Admin is a user with extra rights.' });
    expect(admin.children!.map((c) => `${c.kind}:${c.id}`)).toEqual(['field:Admin.Level', 'field:Admin.Rank', 'method:Admin.Rights', 'method:Admin.Promote']);
    expect(admin.children!.find((c) => c.name === 'Rights')!.doc).toBe('Rights is declared before its receiver type.');
    expect(role.detail).toBe('= string');
    // The receiver type is not declared here: the method stays top-level.
    expect(fetch).toMatchObject({ id: 'Fetch', detail: '(c *Client)', params: ['id'], signature: '(id string) error' });
  });
});

describe('Go flow', () => {
  it('handles else-if chains, C-style and range loops, continue/break and returns', async () => {
    const r = await analyze('LoadUsers');
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['err != nil', 'len(data) == 0', 'i%2 == 0', 'len(result) > 5']);
    const loops = n.filter((x) => x.kind === 'loop');
    expect(loops.map((x) => x.label)).toEqual(['for i := 0; i < limit; i++', 'for _, r := range result']);
    expect(exits(r, loops[0].id)).toEqual(['yes', 'no']);
    expect(exits(r, loops[1].id)).toEqual(['each', 'done']);
    const cont = nodeWith(r, 'continue');
    expect(r.flow.edges).toContainEqual({ from: cont.id, to: loops[0].id, kind: 'continue', label: undefined });
    const brk = nodeWith(r, 'break');
    expect(r.flow.edges).toContainEqual({ from: brk.id, to: loops[1].id, kind: 'break', label: undefined });
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return nil, err', 'return nil, fmt.Errorf("empty")', 'return result, nil']);
    expect(n.find((x) => x.label === 'defer cleanup()')!.lines).toEqual(['defer cleanup()', 'go func() { fmt.Println("async") }()']);
    expect(n.some((x) => x.unreachable)).toBe(false);
    expect(r.flow.complexity).toBe(9);
  });

  it('does not fall through switch cases unless told to', async () => {
    const r = await analyze('LoadUsers');
    const sw = r.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('len(result)');
    expect(exits(r, sw.id)).toEqual(['0', '1, 2', 'default']);
    const many = nodeWith(r, 'fmt.Println("many")');
    const ft = r.flow.nodes.find((x) => x.kind === 'jump' && x.label === 'fallthrough')!;
    expect(r.flow.edges).toContainEqual({ from: ft.id, to: many.id, kind: 'normal', label: undefined });
    // `case 0` ends the switch instead of running into `case 1, 2`.
    const none = nodeWith(r, 'fmt.Println("none")');
    expect(r.flow.edges.filter((e) => e.from === none.id).map((e) => r.flow.nodes[e.to].label)).toEqual(['defer cleanup()']);
  });

  it('handles if initializers, type switches, select, labeled loops and panics', async () => {
    const r = await analyze('Classify');
    const n = r.flow.nodes;
    // The initializer runs before the condition.
    const init = nodeWith(r, 's, ok := v.(fmt.Stringer)');
    expect(r.flow.edges.filter((e) => e.from === init.id).map((e) => n[e.to].label)).toEqual(['ok']);
    const [typeSwitch, select, tagless] = n.filter((x) => x.kind === 'switch');
    expect(typeSwitch.label).toBe('t := v.(type)');
    expect(exits(r, typeSwitch.id)).toEqual(['int, int64', 'string', 'otherwise']);
    // `select` waits for a ready case: no "otherwise" path.
    expect(select.label).toBe('select');
    expect(exits(r, select.id)).toEqual(['n := <-ch', '<-done']);
    expect(tagless.label).toBe('switch');
    expect(exits(r, tagless.id)).toEqual(['Sqrt(2) > 1', 'otherwise']);

    const [outer, inner] = n.filter((x) => x.kind === 'loop');
    expect([outer.label, inner.label]).toEqual(['for', 'for n > 0']);
    expect(exits(r, outer.id)).toEqual(['normal']); // infinite: left only by `break outer`
    expect(exits(r, inner.id)).toEqual(['yes', 'no']);
    expect(r.flow.edges).toContainEqual({ from: nodeWith(r, 'continue outer').id, to: outer.id, kind: 'continue', label: undefined });
    expect(r.flow.edges).toContainEqual({ from: nodeWith(r, 'break outer').id, to: tagless.id, kind: 'break', label: undefined });

    const panic = n.find((x) => x.kind === 'throw')!;
    expect(panic.label).toBe('panic("unreachable")');
    expect(r.flow.edges).toContainEqual({ from: panic.id, to: 1, kind: 'exception', label: 'throws' });
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return s.String(), nil', 'return fmt.Sprint(t), nil', 'return t, nil', 'return "", nil']);
  });
});

describe('Go data flow', () => {
  it('traces params through calls, locals, iteration and appends to the return value', async () => {
    const r = await analyze('LoadUsers');
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'path -arg-> os.ReadFile()',
        'os.ReadFile() -result-> data',
        'os.ReadFile() -result-> err',
        'err -return-> return',
        'str.ToUpper() -arg-> new User()',
        'i -arg-> new User()',
        'new User() -result-> u',
        'u -arg-> append()',
        'append() -result-> result',
        'result -iterate-> r',
        'r -arg-> util.Log()',
        'result -return-> return',
      ]),
    );
    const kinds = Object.fromEntries(r.data.nodes.map((x) => [x.label, x.kind]));
    expect(kinds).toMatchObject({ path: 'param', limit: 'param', data: 'local', i: 'local', r: 'local' });
    // The blank identifier is never a variable.
    expect(r.data.nodes.some((x) => x.label === '_')).toBe(false);
  });

  it('binds receivers, if initializers and type-switch aliases', async () => {
    const greet = await analyze('User.Greet');
    expect(edgesOf(greet)).toEqual(['u -arg-> fmt.Sprintf()', 'fmt.Sprintf() -return-> return']);
    expect(greet.data.nodes.find((x) => x.label === 'u')!.kind).toBe('param');
    const r = await analyze('Classify');
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining(['v -assign-> s', 'v -assign-> ok', 's -arg-> s.String()', 'v -assign-> t', 't -arg-> fmt.Sprint()', 't -return-> return']),
    );
    expect(r.data.nodes.find((x) => x.label === 't')!.kind).toBe('local');
  });

  it('records field and map writes as mutations and hides closure parameters', async () => {
    const r = await analyze('Admin.Promote');
    expect(edgesOf(r)).toEqual(['a -mutate-> u', 'u -mutate-> cache', 'a -arg-> util.Log()', 'util.Log() -result-> notify']);
    expect(r.data.nodes.some((x) => x.label === 'msg')).toBe(false);
  });
});
