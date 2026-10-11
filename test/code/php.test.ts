import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction } from '../../src/core/code/analyze';
import { buildCallGraph } from '../../src/core/code/callgraph';
import { php } from '../../src/core/code/languages/php';
import type { CodeSymbol } from '../../src/core/code/model';
import { registerLanguage } from '../../src/core/code/registry';
import { fixture } from './setup';

registerLanguage(php);

const edgesOf = (r: Awaited<ReturnType<typeof analyzeFunction>>) => {
  const label = (id: string) => r!.data.nodes.find((n) => n.id === id)?.label;
  return r!.data.edges.map((e) => `${label(e.from)} -${e.kind}-> ${label(e.to)}`);
};
const kinds = (symbols: CodeSymbol[] | undefined) => (symbols ?? []).map((s) => `${s.kind}:${s.name}`);
const LOAD = 'App\\Services.UserLoader.load';

describe('PHP outline', () => {
  it('extracts use/require imports, namespaces, classes, members and modifiers', async () => {
    const { path, text } = fixture('sample.php');
    const o = (await analyzeCode(path, text))!;
    expect(o.language).toBe('php');
    expect(o.syntaxErrors).toBe(0);
    expect(o.imports.map((i) => [i.source, i.kind])).toEqual([
      ['App\\Models\\User', 'use'],
      ['App\\Util', 'use'],
      ["__DIR__ . '/helpers.php'", 'require'],
    ]);
    expect(o.imports[0].names).toEqual([{ name: 'User' }]);
    expect(o.imports[1].names).toEqual([{ name: 'Logger' }, { name: 'Formatter' }]);

    // `namespace X;` holds the declarations that follow it.
    expect(kinds(o.symbols)).toEqual(['namespace:App\\Services']);
    const ns = o.symbols[0];
    expect(kinds(ns.children)).toEqual(['interface:Loader', 'class:UserLoader', 'function:helper']);
    expect(ns.range.end.line).toBe(ns.children![2].range.end.line);
    expect(ns.children![0].children![0]).toMatchObject({ kind: 'method', name: 'load', hasBody: false, signature: '(string $path): array' });

    const cls = ns.children![1];
    expect(cls).toMatchObject({ bases: ['BaseLoader', 'Loader', 'LogsTrait'], doc: 'Loads users from disk.' });
    expect(kinds(cls.children)).toEqual([
      'constant:PREFIX',
      'property:count',
      'constructor:__construct',
      'property:root',
      'method:load',
      'method:describe',
      'method:validate',
      'method:read',
    ]);
    const m = Object.fromEntries(cls.children!.map((s) => [s.name, s]));
    expect(m.count).toMatchObject({ modifiers: ['private'], detail: 'int' });
    // Constructor promotion declares a property.
    expect(m.root).toMatchObject({ modifiers: ['private'], detail: 'string' });
    expect(m.__construct.params).toEqual(['root']);
    expect(m.describe.modifiers).toEqual(['public', 'static']);
    expect(m.validate.modifiers).toEqual(['private']);
    expect(m.load).toMatchObject({ signature: '(string $path, int $limit = 10): array', params: ['path', 'limit'], modifiers: ['public'] });
    expect(m.load.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'InvalidArgumentException', kind: 'new' }),
        expect.objectContaining({ name: 'strlen' }),
        expect.objectContaining({ name: 'read', receiver: '$this' }),
        expect.objectContaining({ name: 'User', kind: 'new' }),
        expect.objectContaining({ name: 'error', receiver: 'Logger' }),
        expect.objectContaining({ name: 'getMessage', receiver: '$e' }),
      ]),
    );
    expect(o.exports).toEqual(['App\\Services\\Loader', 'App\\Services\\UserLoader', 'App\\Services\\helper']);
  });

  it('handles braced namespaces, aliases, traits, enums and abstract members', async () => {
    const src = [
      '<?php',
      'namespace App\\Domain {',
      'use App\\Models\\User as U, App\\Models\\Post;',
      'use function App\\Util\\format;',
      'include_once("bootstrap.php");',
      'trait Greets { public function hi() { return "hi"; } }',
      'abstract class Shape implements \\JsonSerializable { abstract protected function area(): float; }',
      'enum Suit: string { case Hearts = "H"; case Spades = "S"; }',
      '}',
    ].join('\n');
    const o = (await analyzeCode('domain.php', src))!;
    expect(o.imports).toEqual([
      { source: 'App\\Models\\User', names: [{ name: 'User', alias: 'U' }], kind: 'use', line: 2 },
      { source: 'App\\Models\\Post', names: [{ name: 'Post' }], kind: 'use', line: 2 },
      { source: 'App\\Util\\format', names: [{ name: 'format' }], kind: 'use', line: 3 },
      { source: 'bootstrap.php', names: [{ name: '*' }], kind: 'include', line: 4 },
    ]);
    const ns = o.symbols[0];
    expect(kinds(ns.children)).toEqual(['trait:Greets', 'class:Shape', 'enum:Suit']);
    expect(ns.children![1]).toMatchObject({ modifiers: ['abstract'], bases: ['\\JsonSerializable'] });
    expect(ns.children![1].children![0]).toMatchObject({ name: 'area', hasBody: false, modifiers: ['abstract', 'protected'] });
    expect(ns.children![2]).toMatchObject({ detail: ': string' });
    expect(kinds(ns.children![2].children)).toEqual(['enumMember:Hearts', 'enumMember:Spades']);
  });
});

describe('PHP flow', () => {
  it('handles elseif chains, foreach, try/catch/finally, throw expressions and jumps', async () => {
    const { path, text } = fixture('sample.php');
    const r = (await analyzeFunction(path, text, { symbolId: LOAD }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual([
      "$path === ''",
      'strlen($path) > 100',
      "$item['disabled']",
      'count($result) >= $limit',
    ]);
    expect(n.filter((x) => x.kind === 'loop').map((x) => x.label)).toEqual([
      'foreach ($this->read($path) as $item)',
      'for ($i = 0; $i < 3; $i++)',
      'while ($this->count > 0)',
    ]);
    expect(n.filter((x) => x.kind === 'catch').map((x) => x.label)).toEqual(['catch (\\Exception $e)']);
    expect(n.some((x) => x.kind === 'finally')).toBe(true);
    expect(n.find((x) => x.kind === 'throw')!.label).toBe("throw new \\InvalidArgumentException('path')");
    expect(n.filter((x) => x.kind === 'return').map((x) => x.label)).toEqual(['return $result;', 'return $result;']);
    const sw = n.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('$limit');
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['1', 'default']);
    const loop = n.find((x) => x.kind === 'loop')!;
    const cont = n.find((x) => x.label === 'continue')!;
    expect(r.flow.edges.some((e) => e.from === cont.id && e.to === loop.id && e.kind === 'continue')).toBe(true);
    const brk = n.find((x) => x.kind === 'jump' && x.label === 'break')!;
    expect(r.flow.edges.find((e) => e.from === brk.id)).toMatchObject({ to: n.find((x) => x.kind === 'try')!.id, kind: 'break' });
    expect(n.some((x) => x.unreachable)).toBe(false);
  });

  it('merges fallthrough cases and handles do/while', async () => {
    const { path, text } = fixture('sample.php');
    const r = (await analyzeFunction(path, text, { symbolId: 'App\\Services.UserLoader.describe' }))!;
    const sw = r.flow.nodes.find((x) => x.kind === 'switch')!;
    expect(sw.label).toBe('$code');
    expect(r.flow.edges.filter((e) => e.from === sw.id).map((e) => e.label)).toEqual(['2, 3', 'default']);
    expect(r.flow.nodes.find((x) => x.kind === 'loop')!.label).toBe('do');
    expect(r.flow.nodes.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['while $code > 0']);
  });

  it('supports the alternative colon syntax, exit and goto', async () => {
    const src = [
      '<?php',
      'function render($items) {',
      '    if (!$items):',
      '        exit(1);',
      '    elseif (count($items) > 9):',
      '        goto done;',
      '    endif;',
      '    foreach ($items as $k => $v):',
      '        echo $v;',
      '    endforeach;',
      '    done:',
      '    echo "ok";',
      '}',
    ].join('\n');
    const r = (await analyzeFunction('render.php', src, { symbolId: 'render' }))!;
    const n = r.flow.nodes;
    expect(n.filter((x) => x.kind === 'decision').map((x) => x.label)).toEqual(['!$items', 'count($items) > 9']);
    expect(n.find((x) => x.kind === 'return')!.label).toBe('exit(1);');
    expect(n.find((x) => x.kind === 'jump')!.label).toBe('goto done');
    expect(n.find((x) => x.kind === 'loop')!.label).toBe('foreach ($items as $k => $v)');
    expect(edgesOf(r)).toEqual(expect.arrayContaining(['items -iterate-> k', 'items -iterate-> v']));
  });
});

describe('PHP data flow', () => {
  it('traces params, foreach bindings, calls and $this fields to the return value', async () => {
    const { path, text } = fixture('sample.php');
    const r = await analyzeFunction(path, text, { symbolId: LOAD });
    expect(edgesOf(r)).toEqual(
      expect.arrayContaining([
        'path -arg-> strlen()',
        'path -arg-> $this.read()',
        '$this.read() -iterate-> item',
        'item -arg-> new User()',
        'new User() -result-> result',
        'result -arg-> count()',
        'result -arg-> $this.validate()',
        'i -assign-> $this.count',
        'result -return-> return',
      ]),
    );
    const kindOf = Object.fromEntries(r!.data.nodes.map((x) => [x.label, x.kind]));
    expect(kindOf).toMatchObject({ path: 'param', limit: 'param', result: 'local', item: 'local', '$this.count': 'field' });
    // Arrow function parameters stay inside the closure.
    expect(r!.data.nodes.some((x) => x.label === 'x')).toBe(false);
  });

  it('reads closure `use` variables and mutates receivers', async () => {
    const { path, text } = fixture('sample.php');
    const r = await analyzeFunction(path, text, { symbolId: 'App\\Services.UserLoader.describe' });
    expect(edgesOf(r)).toEqual(expect.arrayContaining(['label -assign-> wrap', 'label -arg-> $wrap()', '$wrap() -return-> return']));
    expect(r!.data.nodes.some((x) => x.label === 's')).toBe(false);
    const src = '<?php\nfunction add($list, $item) {\n    $list->push($item);\n    $this->items->add($item);\n}\n';
    const add = await analyzeFunction('add.php', src, { symbolId: 'add' });
    expect(edgesOf(add)).toEqual(['item -mutate-> list', 'item -mutate-> $this.items']);
  });
});

describe('PHP call graph', () => {
  it('resolves $this-> calls to sibling methods', async () => {
    const { path, text } = fixture('sample.php');
    const graph = buildCallGraph([{ path, outline: (await analyzeCode(path, text))! }]);
    const name = (id: string) => id.split('#')[1].replace('App\\Services.', '');
    const edges = graph.edges.map((e) => `${name(e.from)} -> ${name(e.to)} (${e.confidence})`);
    expect(edges).toEqual(expect.arrayContaining(['UserLoader.load -> UserLoader.read (exact)', 'UserLoader.load -> UserLoader.validate (exact)']));
  });
});
