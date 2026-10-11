import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { rust } from '../../src/core/code/languages/rust';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(rust);

type Analysis = NonNullable<Awaited<ReturnType<typeof analyzeFunction>>>;

const { path, text } = fixture('sample.rs');
const analyze = async (symbolId: string) => (await analyzeFunction(path, text, { symbolId }))!;

const edgesOf = (r: Analysis) => {
  const label = (id: string) => r.data.nodes.find((n) => n.id === id)?.label;
  return r.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};
/** Labels (or kinds) of the flow edges leaving a node. */
const exits = (r: Analysis, id: number) => r.flow.edges.filter((e) => e.from === id).map((e) => e.label ?? e.kind);
const nodeWith = (r: Analysis, label: string) => r.flow.nodes.find((n) => n.label === label)!;
const returns = (r: Analysis) => r.flow.nodes.filter((n) => n.kind === 'return').map((n) => n.label);

describe('Rust outline', () => {
  it('flattens use paths, groups impl members and reads visibility, modifiers and docs', async () => {
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('rust');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => `${i.kind}:${i.source}`)).toEqual([
      'use:std::collections::HashMap', 'use:std::fs', 'use:std::fs::File', 'use:crate::util::log', 'use:std::io::prelude',
      'use:std::io::Result', 'use:models::Role', 'mod:models',
    ]);
    expect(o.imports[1].names).toEqual([{ name: 'fs' }]); // `{self, …}` imports the module itself
    expect(o.imports[4].names).toEqual([{ name: '*' }]);
    expect(o.imports[5].names).toEqual([{ name: 'Result', alias: 'IoResult' }]);
    expect(o.imports[1].line).toBe(o.imports[2].line);
    expect(o.exports).toEqual(['Role', 'User', 'Greeter', 'Mode', 'load_users', 'MAX_USERS', 'UserMap', 'square', 'admin', 'find_adult']);
    expect(o.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'struct:User', 'trait:Greeter', 'impl:User', 'impl:User', 'enum:Mode', 'function:load_users', 'constant:MAX_USERS',
      'variable:COUNTER', 'type:UserMap', 'macro:square', 'module:admin', 'function:describe', 'function:find_adult', 'function:drain',
    ]);
    const [user, greeter, traitImpl, inherent, mode, load] = o.symbols;
    expect(user.children!.map((c) => `${c.kind}:${c.name}:${c.detail}:${c.modifiers ?? ''}`)).toEqual(['field:name:String:pub', 'field:age:u32:']);
    expect(greeter.children!.map((c) => `${c.kind}:${c.name}:${c.signature}:${c.hasBody}`)).toEqual(['method:greet:(&self) -> String:false']);

    expect(traitImpl).toMatchObject({ id: 'User@17', detail: 'impl Greeter for User', bases: ['Greeter'] });
    expect(traitImpl.children!.map((c) => c.id)).toEqual(['User@17.greet']);
    expect(inherent.detail).toBe('impl User');
    expect(inherent.children!.map((c) => `${c.kind}:${c.name}`)).toEqual(['method:new', 'method:rename']);
    const ctor = inherent.children![0];
    expect(ctor).toMatchObject({ signature: '(name: &str, age: u32) -> Self', params: ['name', 'age'], modifiers: ['pub'] });
    expect(ctor.calls!.map((c) => `${c.kind ?? 'call'}:${c.name}`)).toEqual(['new:User', 'call:to_string']);
    expect(inherent.children![1].params).toEqual(['name']); // `&mut self` is not a parameter

    expect(mode.children!.map((c) => `${c.kind}:${c.name}${c.detail ?? ''}`)).toEqual(['enumMember:A', 'enumMember:B(u32)']);
    expect(load.signature).toBe('(path: &str, limit: usize) -> Result<Vec<User>, String>');
    expect(load.params).toEqual(['path', 'limit']);
    expect(load.modifiers).toEqual(['pub']);
    expect(load.complexity).toBe(13);
    expect(load.calls!.find((c) => c.name === 'vec')).toMatchObject({ kind: 'macro' });
    expect(load.calls!.find((c) => c.name === 'push')).toMatchObject({ receiver: 'result' });
    expect(load.calls!.filter((c) => c.name === 'new').map((c) => c.receiver)).toEqual(['Vec', 'User']);
    // The `map_err` closure is its own scope.
    expect(load.calls!.some((c) => c.name === 'to_string')).toBe(false);

    const byName = Object.fromEntries(o.symbols.map((s) => [s.name, s]));
    expect(byName.COUNTER.modifiers).toEqual(['mut']);
    expect(byName.UserMap.detail).toBe('HashMap<String, User>');
    expect(byName.admin.children!.map((c) => `${c.kind}:${c.id}:${c.doc}`)).toEqual(['function:admin.grant:Grants access to adults.']);
    expect(byName.find_adult).toMatchObject({ modifiers: ['pub(crate)', 'async'], doc: 'Finds the first adult that is not banned.', params: ['users', 'banned'] });
  });
});

describe('Rust flow', () => {
  it('handles if/else-if, for/while/loop, match arms, jumps and implicit returns', async () => {
    const r = await analyze('load_users');
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual([
      'data.is_empty()', 'data.len() > 1000', "line.starts_with('#')", 'result.len() >= limit', 'n == 0',
    ]);
    const [forLoop, whileLoop, infinite] = n.filter((x) => x.kind === 'loop');
    expect([forLoop.label, whileLoop.label, infinite.label]).toEqual(['for (i, line) in data.lines().enumerate()', 'while n < 3', 'loop']);
    expect(exits(r, forLoop.id)).toEqual(['each', 'done']);
    expect(exits(r, whileLoop.id)).toEqual(['yes', 'no']);
    expect(exits(r, infinite.id)).toEqual(['normal']); // only `break` leaves it
    expect(r.flow.edges).toContainEqual({ from: nodeWith(r, 'continue').id, to: forLoop.id, kind: 'continue', label: undefined });

    // Arms never fall through and the match is exhaustive (no "otherwise").
    const sw = n.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('result.len()');
    expect(exits(r, sw.id)).toEqual(['0', '1 | 2', '_']);
    const breaks = n.filter((x) => x.label === 'break');
    expect(r.flow.edges).toContainEqual({ from: breaks[1].id, to: sw.id, kind: 'break', label: undefined });

    // The final expression without `;` is the return value; expression-level `if` stays a statement.
    expect(returns(r)).toEqual(['return Err("empty".into())', 'return Ok(vec![])', 'return Ok(result)']);
    expect(n.find((x) => x.lines?.includes('let total = if n > 0 { n } else { 0 };'))).toBeTruthy();
    expect(n.some((x) => x.unreachable)).toBe(false);
    expect(r.flow.complexity).toBe(10);
    expect(returns(await analyze('User@17.greet'))).toEqual(['return format!("hi {}", self.name)']);
  });

  it('supports loop labels, let-else, panics and tail if/match arms', async () => {
    const r = await analyze('find_adult');
    const [outer, inner] = r.flow.nodes.filter((x) => x.kind === 'loop');
    expect([outer.label, inner.label]).toEqual(['for user in users', 'for name in banned']);
    expect(r.flow.edges).toContainEqual({ from: nodeWith(r, 'continue outer').id, to: outer.id, kind: 'continue', label: undefined });
    const letElse = nodeWith(r, 'let Some(first) = users.first()');
    expect(letElse.kind).toBe('decision');
    expect(r.flow.edges).toContainEqual({ from: nodeWith(r, 'break outer').id, to: letElse.id, kind: 'break', label: undefined });
    expect(r.flow.edges.filter((e) => e.from === letElse.id).map((e) => `${e.label}:${r.flow.nodes[e.to].label}`)).toEqual([
      'no:return None',
      'yes:let label = describe(first, checked);',
    ]);
    const sw = r.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(exits(r, sw.id)).toEqual(['0', 'a if a > 100', '_']);
    expect(returns(r)).toEqual(['return None', 'return None', 'return Some(label)', 'return Some(shout(&first.name))']);

    const d = await analyze('drain');
    expect(d.flow.nodes.find((x) => x.kind === 'loop')!.label).toBe('while let Some(top) = stack.pop()');
    const panic = d.flow.nodes.find((x) => x.kind === 'throw')!;
    expect(panic.label).toBe('panic!("zero");');
    expect(d.flow.edges).toContainEqual({ from: panic.id, to: 1, kind: 'exception', label: 'throws' });
    expect(returns(d)).toEqual(['return sum + first', 'return sum']);
  });
});

describe('Rust data flow', () => {
  it('traces iteration, calls, mutation and the implicit return value', async () => {
    const r = await analyze('load_users');
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'Vec.new() -result-> result',
        'data -arg-> data.enumerate()',
        'data.enumerate() -iterate-> i',
        'data.enumerate() -iterate-> line',
        'line -arg-> User.new()',
        'i -arg-> User.new()',
        'User.new() -result-> user',
        'user -mutate-> result',
        'n -assign-> total',
        'result -arg-> Ok()',
        'Ok() -return-> return',
      ]),
    );
    const kinds = Object.fromEntries(r.data.nodes.map((x) => [x.label, x.kind]));
    expect(kinds).toMatchObject({ path: 'param', limit: 'param', data: 'local', line: 'local', user: 'local' });
    // Closure parameters stay inside the closure.
    expect(r.data.nodes.some((x) => x.label === 'e')).toBe(false);
  });

  it('follows params into struct literals, macros, field writes and pattern bindings', async () => {
    expect(edgesOf(await analyze('User@23.new'))).toEqual([
      'name -arg-> name.to_string()', 'name.to_string() -arg-> new User()', 'age -arg-> new User()', 'new User() -return-> return',
    ]);
    expect(edgesOf(await analyze('User@23.rename'))).toEqual(['name -arg-> name.to_string()', 'name.to_string() -result-> self.name']);
    // Macro tokens: `user.name` reads `user`, not a variable called `name`.
    const desc = await analyze('describe');
    expect(edgesOf(desc)).toEqual(['user -arg-> format!()', 'n -arg-> format!()', 'format!() -return-> return']);

    const find = await analyze('find_adult');
    expect(edgesOf(find)).toEqual(
      expect.arrayContaining([
        'users -iterate-> user',
        'banned -iterate-> name',
        'users.first() -result-> first',
        'first -arg-> describe()',
        'describe() -result-> label',
        'label -arg-> Some()',
        'Some() -return-> return',
      ]),
    );
    expect(find.data.nodes.some((x) => x.label === 's')).toBe(false);

    expect(edgesOf(await analyze('drain'))).toEqual(
      expect.arrayContaining(['stack.pop() -result-> top', 'top -assign-> sum', 'stack.first() -result-> first', 'sum -return-> return', 'first -return-> return']),
    );
  });
});
