import { describe, expect, it } from 'vitest';
import { analyzeFunction } from '../../src/core/code/analyze';
import type { FlowGraph } from '../../src/core/code/model';
import './setup';

const flowOf = async (path: string, text: string, symbolId: string): Promise<FlowGraph> => (await analyzeFunction(path, text, { symbolId }))!.flow;
const node = (g: FlowGraph, label: string) => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node "${label}" in ${g.nodes.map((x) => x.label).join(' | ')}`);
  return n;
};
/** Edges as `from -kind(label)-> to`, by node label. */
const edges = (g: FlowGraph) => g.edges.map((e) => `${g.nodes[e.from].label} -${e.kind}${e.label ? `(${e.label})` : ''}-> ${g.nodes[e.to].label}`);
const outOf = (g: FlowGraph, label: string) => edges(g).filter((e) => e.startsWith(`${label} -`));
const unreachable = (g: FlowGraph) => g.nodes.filter((n) => n.unreachable).map((n) => n.label);
/** No two edges join the same pair of nodes unless they are a decision's branches. */
const parallel = (g: FlowGraph) => {
  const seen = new Map<string, string[]>();
  for (const e of g.edges) seen.set(`${e.from}>${e.to}`, [...(seen.get(`${e.from}>${e.to}`) ?? []), e.kind]);
  return [...seen.values()].filter((kinds) => kinds.length > 1 && !kinds.every((k) => k === 'true' || k === 'false' || k === 'case'));
};

describe('finally', () => {
  it('runs on returns from the try body and the catch clause', async () => {
    const g = await flowOf('a.ts', 'function f(x: number) {\n  try {\n    return compute(x);\n  } catch (e) {\n    return null;\n  } finally {\n    cleanup();\n  }\n}', 'f');
    expect(unreachable(g)).toEqual([]);
    expect(edges(g)).toEqual(
      expect.arrayContaining([
        'return compute(x); -return-> finally',
        'return null; -return-> finally',
        'finally -normal-> cleanup();',
        // The block goes on to the jump's target, once for both returns.
        'cleanup(); -return(return)-> end',
      ]),
    );
    expect(outOf(g, 'cleanup();')).toHaveLength(1);
    expect(edges(g).filter((e) => e.endsWith('-> end'))).toEqual(['cleanup(); -return(return)-> end']);
  });

  it('runs on a Python return inside try', async () => {
    const g = await flowOf('a.py', 'def f(path):\n    fh = open(path)\n    try:\n        return fh.read()\n    finally:\n        fh.close()\n', 'f');
    expect(unreachable(g)).toEqual([]);
    expect(edges(g)).toEqual(expect.arrayContaining(['return fh.read() -return-> finally', 'fh.close() -return(return)-> end']));
  });

  it('runs before a break leaves the loop, and before the loop goes on', async () => {
    const src = 'class A {\n  void f(int[] xs) {\n    for (int x : xs) {\n      try {\n        if (x == 0) break;\n        use(x);\n      } finally {\n        log(x);\n      }\n    }\n    done();\n  }\n}';
    const g = await flowOf('A.java', src, 'A.f');
    expect(edges(g)).toEqual(
      expect.arrayContaining(['break -break-> finally', 'use(x); -normal-> finally', 'log(x); -back-> for (int x : xs)', 'log(x); -break(break)-> done();']),
    );
    expect(edges(g)).not.toContain('break -break-> done();');
    expect(parallel(g)).toEqual([]);
  });

  it('chains nested finally blocks and lets an outer catch take a rethrow', async () => {
    const src = [
      'function f(a, b) {',
      '  try {',
      '    try {',
      '      if (a) return 1;',
      '      if (b) throw new Error("x");',
      '      work();',
      '    } finally {',
      '      inner();',
      '    }',
      '  } catch (e) {',
      '    handle(e);',
      '  } finally {',
      '    outer();',
      '  }',
      '  after();',
      '}',
    ].join('\n');
    const g = await flowOf('n.js', src, 'f');
    const [innerFin, outerFin] = g.nodes.filter((n) => n.kind === 'finally');
    expect(edges(g)).toEqual(
      expect.arrayContaining([
        'return 1; -return-> finally',
        'throw new Error("x"); -exception-> finally',
        // The rethrow reaches the outer catch after the inner block.
        'inner(); -exception(throw)-> catch (e)',
        'handle(e); -normal-> finally',
        'outer(); -return(return)-> end',
        'outer(); -normal-> after();',
      ]),
    );
    // The inner block reaches the outer one (normally and for the return): one edge.
    expect(g.edges.filter((e) => e.to === outerFin.id && g.nodes[e.from].label === 'inner();')).toHaveLength(1);
    expect(g.edges.some((e) => e.to === innerFin.id && g.nodes[e.from].label === 'return 1;')).toBe(true);
    expect(parallel(g)).toEqual([]);
    expect(unreachable(g)).toEqual([]);
  });

  it('runs when an except clause re-raises, and when a continue goes back', async () => {
    const src = 'def f(items):\n    for x in items:\n        try:\n            if x:\n                continue\n            a()\n        except ValueError:\n            raise\n        finally:\n            c()\n    d()\n';
    const g = await flowOf('r.py', src, 'f');
    expect(edges(g)).toEqual(
      expect.arrayContaining(['continue -continue-> finally', 'raise -exception-> finally', 'c() -exception(throw)-> end', 'c() -back-> for x in items']),
    );
    // `continue` and the normal end of the body both go back to the loop: one edge.
    expect(parallel(g)).toEqual([]);
    expect(unreachable(g)).toEqual([]);
  });

  it('runs before the ensure clause of a Ruby method', async () => {
    const g = await flowOf('a.rb', 'def f(x)\n  return 1 if x\n  work\nensure\n  cleanup\nend\n', 'f');
    expect(unreachable(g)).toEqual([]);
    // The return and the end of the body both leave through `cleanup`: one edge to `end`.
    expect(edges(g)).toEqual(expect.arrayContaining(['return 1 -return-> finally', 'work -normal-> finally', 'cleanup -normal-> end']));
    expect(parallel(g)).toEqual([]);
  });
});

describe('goto', () => {
  it('jumps to the labeled statement in C, forward and back', async () => {
    const src = 'int f(int x) {\nagain:\n  if (x < 0) goto fail;\n  do_work(x);\n  if (more()) goto again;\n  return 0;\nfail:\n  cleanup();\n  return -1;\n}';
    const g = await flowOf('a.c', src, 'f');
    expect(unreachable(g)).toEqual([]);
    expect(edges(g)).toEqual(expect.arrayContaining(['goto fail -break-> cleanup();', 'goto again -continue-> x < 0']));
  });

  it('ends the path at an unknown label', async () => {
    const g = await flowOf('a.c', 'void f(void) {\n  goto nowhere;\n  never();\n}', 'f');
    expect(edges(g)).toContain('goto nowhere -break-> end');
    expect(unreachable(g)).toEqual(['never();']);
  });

  it('jumps to a PHP label and a Go label', async () => {
    const php = await flowOf('a.php', '<?php\nfunction f($x) {\n  if ($x) goto end;\n  echo 1;\n  end:\n  echo 2;\n}', 'f');
    expect(edges(php)).toEqual(expect.arrayContaining(['goto end -break-> end:', 'end: -normal-> echo 2;']));
    expect(unreachable(php)).toEqual([]);
    const go = await flowOf('a.go', 'package main\nfunc f(x int) int {\n\tif x > 0 {\n\t\tgoto done\n\t}\n\tx++\ndone:\n\treturn x\n}', 'f');
    expect(edges(go)).toContain('goto done -break-> return x');
    expect(unreachable(go)).toEqual([]);
  });
});

describe('loops that only exit through break', () => {
  const cases: [string, string, string, string][] = [
    ['Python while True', 'w.py', 'def f(q):\n    while True:\n        if q.empty():\n            break\n    done()\n', 'while True'],
    ['JS while (true)', 'w.js', 'function f(q) {\n  while (true) {\n    if (q.empty()) break;\n  }\n  done();\n}', 'while (true)'],
    ['JS for (;;)', 'f.js', 'function f(q) {\n  for (;;) {\n    if (q.empty()) break;\n  }\n  done();\n}', 'for (;;)'],
    ['TS do … while (true)', 'd.ts', 'function f(q: Q) {\n  do {\n    if (q.empty()) break;\n  } while (true);\n  done();\n}', 'do … while (true)'],
    ['Java for (;;)', 'A.java', 'class A {\n  void f(Q q) {\n    for (;;) {\n      if (q.empty()) break;\n    }\n    done();\n  }\n}', 'for (;;)'],
    ['C while (1)', 'w.c', 'void f(Q* q) {\n  while (1) {\n    if (empty(q)) break;\n  }\n  done();\n}', 'while (1)'],
    ['C# while (true)', 'A.cs', 'class A {\n  void F(Q q) {\n    while (true) {\n      if (q.Empty()) break;\n    }\n    Done();\n  }\n}', 'while (true)'],
    ['PHP for (;;)', 'w.php', '<?php\nfunction f($q) {\n  for (;;) {\n    if ($q->empty()) break;\n  }\n  done();\n}', 'for (;;)'],
    ['Ruby while true', 'w.rb', 'def f(q)\n  while true\n    break if q.empty?\n  end\n  done\nend\n', 'while true'],
    ['Go for true', 'w.go', 'package main\nfunc f(q Q) {\n\tfor true {\n\t\tif q.Empty() {\n\t\t\tbreak\n\t\t}\n\t}\n\tdone()\n}', 'for true'],
    ['Rust loop', 'w.rs', 'fn f(q: Q) {\n    loop {\n        if q.empty() { break; }\n    }\n    done();\n}', 'loop'],
  ];
  for (const [name, path, src, label] of cases) {
    it(name, async () => {
      const g = await flowOf(path, src, path.endsWith('.java') ? 'A.f' : path.endsWith('.cs') ? 'A.F' : 'f');
      const loop = g.nodes.find((n) => n.kind === 'loop' && n.label === label)!;
      expect(loop).toBeTruthy();
      expect(g.edges.filter((e) => e.from === loop.id && e.kind !== 'back').map((e) => e.kind)).toEqual(['normal']);
      // `done` follows only the break.
      const done = g.nodes.find((n) => /\bdone\b/i.test(n.label))!;
      expect(g.edges.filter((e) => e.to === done.id).map((e) => e.kind)).toEqual(['break']);
    });
  }

  it('never runs the else clause of a Python while True', async () => {
    const g = await flowOf('w.py', 'def f(q):\n    while True:\n        if q.empty():\n            break\n    else:\n        never()\n    done()\n', 'f');
    expect(unreachable(g)).toEqual(['never()']);
  });
});

describe('labeled blocks', () => {
  it('leave the block on break label (JS and Java)', async () => {
    const js = await flowOf('b.js', 'function f(x) {\n  outer: {\n    if (x) break outer;\n    a();\n  }\n  b();\n}', 'f');
    expect(edges(js)).toEqual(expect.arrayContaining(['break outer -break-> b();', 'a(); -normal-> b();']));
    const java = await flowOf('B.java', 'class B {\n  void f(int x) {\n    outer: {\n      if (x > 0) break outer;\n      a();\n    }\n    b();\n  }\n}', 'B.f');
    expect(edges(java)).toContain('break outer -break-> b();');
  });

  it('do not catch an unlabeled break, which leaves the loop', async () => {
    const g = await flowOf('b.js', 'function f(xs) {\n  for (const x of xs) {\n    blk: {\n      if (x) break;\n      a();\n    }\n    b();\n  }\n  c();\n}', 'f');
    expect(outOf(g, 'break')).toEqual(['break -break-> c();']);
  });
});

describe('Rust', () => {
  it('draws `?` as a decision that returns early', async () => {
    const src = 'fn f(p: &str) -> Result<i32, E> {\n    let s = read(p)?;\n    let n = parse(&s).map_err(wrap)?.len();\n    Ok(n)\n}';
    const g = await flowOf('a.rs', src, 'f');
    expect(edges(g)).toEqual(
      expect.arrayContaining([
        'read(p)? -return(Err)-> end',
        'read(p)? -true(ok)-> let s = read(p)?;',
        'parse(&s).map_err(wrap)? -return(Err)-> end',
      ]),
    );
    const opt = await flowOf('a.rs', 'fn g(v: &[i32]) -> Option<i32> {\n    let x = v.first()?;\n    Some(*x)\n}', 'g');
    expect(edges(opt)).toContain('v.first()? -return(None)-> end');
    // A `?` inside a closure returns from the closure.
    const closure = await flowOf('a.rs', 'fn h(v: Vec<&str>) -> Vec<i32> {\n    v.iter().filter_map(|s| s.parse().ok()?).collect()\n}', 'h');
    expect(closure.nodes.some((n) => n.kind === 'decision')).toBe(false);
  });

  it('checks `?` in conditions and match subjects', async () => {
    const g = await flowOf('a.rs', 'fn f(p: &str) -> Result<(), E> {\n    if exists(p)? {\n        go();\n    }\n    match kind(p)? {\n        1 => a(),\n        _ => b(),\n    }\n    Ok(())\n}', 'f');
    expect(g.nodes.filter((n) => n.kind === 'decision').map((n) => n.label)).toEqual(['exists(p)?', 'exists(p)?', 'kind(p)?']);
    expect(edges(g)).toContain('kind(p)? -true(ok)-> kind(p)?');
  });

  it('expands match/if/loop initializers of let into their own flow', async () => {
    const src = 'fn f(x: Option<i32>) -> i32 {\n    let v = match x {\n        Some(n) => n,\n        None => return -1,\n    };\n    let w = if v > 0 { v } else { -v };\n    let z = loop {\n        if ready() { break 7; }\n    };\n    v + w + z\n}';
    const g = await flowOf('a.rs', src, 'f');
    expect(edges(g)).toEqual(
      expect.arrayContaining([
        'x -case(Some(n))-> n',
        'x -case(None)-> return -1',
        'return -1 -return-> end',
        'n -normal-> let v = …',
        'v > 0 -true(yes)-> v',
        'v -normal-> let w = …',
        '-v -normal-> let w = …',
        'break -break-> let z = …',
        'let z = … -normal-> return v + w + z',
      ]),
    );
    expect(node(g, 'break').range!.start.line).toBe(7); // `break 7;`
    // The loop only leaves through `break 7`.
    expect(outOf(g, 'loop')).toEqual(['loop -normal-> ready()']);
  });

  it('expands assignments and blocks with jumps, and leaves labeled blocks on break', async () => {
    const src = "fn f(x: Option<i32>) -> i32 {\n    let mut v = 0;\n    v = match x { Some(n) => n, None => return 0 };\n    let w = 'a: {\n        if v > 9 { break 'a 9; }\n        v\n    };\n    w\n}";
    const g = await flowOf('a.rs', src, 'f');
    expect(edges(g)).toEqual(expect.arrayContaining(['x -case(None)-> return 0', 'n -normal-> v = …', 'break a -break-> let w = …', 'v -normal-> let w = …']));
    const plain = await flowOf('a.rs', 'fn g() -> i32 {\n    let v = { let a = 1; a + 1 };\n    v\n}', 'g');
    expect(plain.nodes.find((n) => n.kind === 'block')!.lines).toEqual(['let v = { let a = 1; a + 1 };']);
  });
});
