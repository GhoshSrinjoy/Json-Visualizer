import { describe, expect, it } from 'vitest';
import { analyzeCode, analyzeFunction, findById, MODULE_SYMBOL } from '../../src/core/code/analyze';
import './setup';

/**
 * One McCabe count (decision points + 1) for the outline and the flow view: if / else-if,
 * loops that test a condition (not `loop`, `for (;;)`, `while (true)`), each case branch but the
 * default (labels sharing a body count once), catch clauses, `&&` `||` `and` `or` `??`,
 * conditional expressions, comprehension filters and Rust `?`. Nested functions do not count.
 */
const cases: { lang: string; path: string; fn: string; expected: number; src: string }[] = [
  {
    lang: 'TypeScript',
    path: 'c.ts',
    fn: 'f',
    // ?? + && + ?: + if + || + for-of + if (in while (true)) + 2 case branches + catch = 10
    expected: 11,
    src: `function f(a: any, b: any, xs: any[]) {
  const v = a ?? b;
  const w = a && b ? 1 : 2;
  if (a || b) return v;
  for (const x of xs) {}
  while (true) { if (xs.length) break; }
  switch (a) { case 1: case 2: g(); break; case 3: h(); break; default: k(); }
  try { k(); } catch (e) {}
  const nested = () => (a ? 1 : 2);
  return w;
}`,
  },
  {
    lang: 'Python',
    path: 'c.py',
    fn: 'f',
    // or + conditional + and + if + elif + for + if (in while True) + filter + 2 cases (a guarded `_` is not
    // the default; guards and `case _` do not count) + except = 11
    expected: 12,
    src: `def f(a, b, xs):
    v = a or b
    w = 1 if a and b else 2
    if a:
        pass
    elif b:
        pass
    for x in xs:
        pass
    while True:
        if xs:
            break
    ys = [x for x in xs if x]
    match a:
        case 1 | 2:
            pass
        case _ if b:
            pass
        case _:
            pass
    try:
        pass
    except ValueError:
        pass
    g = lambda: 1 if a else 2
    return w
`,
  },
  {
    lang: 'Java',
    path: 'C.java',
    fn: 'C.f',
    // && + ?: + if + || + for-each + if (in for (;;)) + do-while + 2 case groups + catch = 10
    expected: 11,
    src: `class C {
  int f(int a, boolean b, int[] xs) {
    int w = b && a > 0 ? 1 : 2;
    if (a > 1 || b) {}
    for (int x : xs) {}
    for (;;) { if (b) break; }
    do {} while (a-- > 0);
    switch (a) { case 1: case 2: w = 3; break; case 3: w = 4; break; default: w = 5; }
    try { g(); } catch (RuntimeException e) {}
    Runnable r = () -> { if (b) g(); };
    return w;
  }
}`,
  },
  {
    lang: 'C#',
    path: 'C.cs',
    fn: 'C.F',
    // 2 switch-expression arms (not `_`) + ?: + ?? + foreach + if (in while (true)) + 1 case section + catch = 8
    expected: 9,
    src: `class C {
  int F(int a, bool b, int[] xs, string s) {
    var n = a switch { 1 => 2, 2 => 3, _ => 0 };
    var m = b ? 1 : 2;
    var o = s ?? "x";
    foreach (var x in xs) {}
    while (true) { if (b) break; }
    switch (a) { case 1: case 2: n = 3; break; default: n = 4; break; }
    try { G(); } catch (Exception) {}
    return n;
  }
}`,
  },
  {
    lang: 'Go',
    path: 'c.go',
    fn: 'f',
    // if + && + range + if (in for {}) + for clause + 2 cases + 1 select case (the last is the catch-all) = 8
    expected: 9,
    src: `package main
func f(a int, xs []int, ch chan int) int {
	if a > 0 && a < 10 {
	}
	for _, x := range xs {
		_ = x
	}
	for {
		if a > 1 {
			break
		}
	}
	for i := 0; i < a; i++ {
	}
	switch a {
	case 1, 2:
	case 3:
	default:
	}
	select {
	case v := <-ch:
		_ = v
	case ch <- 1:
	}
	return a
}`,
  },
  {
    lang: 'Rust',
    path: 'c.rs',
    fn: 'f',
    // ? + if + && + for + if (in loop) + while + let-else + 2 match arms (not `_`) = 9
    expected: 10,
    src: `fn f(a: i32, xs: &[i32]) -> Result<i32, E> {
    let v = read()?;
    if a > 0 && a < 10 {}
    for x in xs {}
    loop { if a > 1 { break; } }
    while a < 0 {}
    let Some(y) = xs.first() else { return Err(e()); };
    match a { 1 | 2 => {}, 3 => {}, _ => {} }
    let c = |z: i32| if z > 0 { 1 } else { 2 };
    Ok(v)
}`,
  },
  {
    lang: 'C',
    path: 'c.c',
    fn: 'f',
    // && + ?: + if + || + for + if (in for (;;)) + if (in while (1)) + do-while + 1 case branch = 9
    expected: 10,
    src: `int f(int a, int n) {
  int w = a > 0 && n > 0 ? 1 : 2;
  if (a || n) {}
  for (int i = 0; i < n; i++) {}
  for (;;) { if (a) break; }
  while (1) { if (n) break; }
  do {} while (a--);
  switch (a) { case 1: case 2: w = 3; break; default: w = 4; }
  goto done;
done:
  return w;
}`,
  },
  {
    lang: 'C++',
    path: 'c.cpp',
    fn: 'f',
    // 2 catch clauses; the lambda is its own scope
    expected: 3,
    src: `int f(int a) {
  try { g(); } catch (const std::exception& e) {} catch (...) {}
  auto l = [](int x) { return x ? 1 : 2; };
  return a;
}`,
  },
  {
    lang: 'PHP',
    path: 'c.php',
    fn: 'f',
    // ?? + && + ?: + if + elseif + foreach + if (in while (true)) + 1 case branch + 2 match arms + catch = 11
    expected: 12,
    src: `<?php
function f($a, $xs) {
  $v = $a ?? 1;
  $w = $a && $v ? 1 : 2;
  if ($a) {} elseif ($v) {}
  foreach ($xs as $x) {}
  while (true) { if ($a) break; }
  switch ($a) { case 1: case 2: $w = 3; break; default: $w = 4; }
  $m = match($a) { 1 => 'a', 2 => 'b', default => 'c' };
  try { g(); } catch (Exception $e) {}
  return $w;
}`,
  },
  {
    lang: 'Ruby',
    path: 'c.rb',
    fn: 'f',
    // || + && + ?: + if + elsif + each + next-if + break-if (in loop do) + 2 when + rescue + unless = 12
    expected: 13,
    src: `def f(a, xs)
  v = a || 1
  w = a && v ? 1 : 2
  if a then x elsif v then y end
  xs.each do |x|
    next if x.nil?
  end
  loop do
    break if a
  end
  case a
  when 1, 2 then p 1
  when 3 then p 2
  else p 3
  end
  begin
    g
  rescue ArgumentError
    nil
  end
  unless a then z end
  w
end`,
  },
];

describe('cyclomatic complexity', () => {
  for (const c of cases) {
    it(`is the same in the outline and the flow view (${c.lang})`, async () => {
      const outline = (await analyzeCode(c.path, c.src))!;
      const flow = (await analyzeFunction(c.path, c.src, { symbolId: c.fn }))!.flow;
      expect(findById(outline.symbols, c.fn)!.complexity).toBe(c.expected);
      expect(flow.complexity).toBe(c.expected);
    });
  }

  it('counts top-level code the same way', async () => {
    const src = 'import sys\nif len(sys.argv) > 1 and sys.argv[1]:\n    run()\ndef f(x):\n    return x if x else 0\n';
    const mod = (await analyzeFunction('m.py', src, { symbolId: MODULE_SYMBOL }))!;
    expect(mod.flow.complexity).toBe(3); // if + and; the function body is not top-level code
    expect(mod.symbol.complexity).toBe(3);
  });
});
