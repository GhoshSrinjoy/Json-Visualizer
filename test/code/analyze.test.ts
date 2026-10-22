import { describe, expect, it } from 'vitest';
import { analyzeCode } from '../../src/core/code/analyze';
import './setup';

describe('outline cache', () => {
  it('holds the outlines of a whole workspace call graph (bounded by size, not by 200 entries)', async () => {
    const src = (k: number) => `export function f${k}(x: number) {\n  return x > ${k} ? x : ${k};\n}\n`;
    const first = await analyzeCode('src/f0.ts', src(0));
    for (let k = 1; k < 1000; k++) await analyzeCode(`src/f${k}.ts`, src(k));
    // The first outline is still cached: a second (focused) pass does not parse again.
    expect(await analyzeCode('src/f0.ts', src(0))).toBe(first);
    // A changed file is analysed again.
    expect(await analyzeCode('src/f0.ts', src(0) + '\n')).not.toBe(first);
  });
});
