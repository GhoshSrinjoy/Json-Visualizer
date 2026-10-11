import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoChildren, repoIndex, repoPath, K_DIR } from '../../src/core/repo/model';
import { scanRepo } from '../../src/core/repo/scan';
import { nodeFs } from '../../src/node/fs';

let root = '';

function write(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'structlens-scan-'));
  write('.gitignore', 'dist/\n*.log\n!keep.log\n');
  write('src/index.ts', 'export const a = 1;\nexport const b = 2;\n');
  write('src/util/strings.ts', 'export {}\n');
  write('src/util/.gitignore', 'secret.ts\n');
  write('src/util/secret.ts', 'nope');
  write('src/app.py', 'print(1)\nprint(2)\nprint(3)');
  write('dist/out.js', 'ignored');
  write('debug.log', 'ignored');
  write('keep.log', 'kept\n');
  write('node_modules/x/index.js', 'ignored');
  write('README.md', '# hi\n');
  write('assets/logo.png', '\x89PNG\x00\x00binary');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanRepo', () => {
  it('honors .gitignore (nested + negation) and default excludes', async () => {
    const repo = await scanRepo(root, nodeFs);
    const idx = repoIndex(repo);
    const paths = [...idx.keys()].filter(Boolean).sort();
    expect(paths).toEqual(['.gitignore', 'README.md', 'assets', 'assets/logo.png', 'keep.log', 'src', 'src/app.py', 'src/index.ts', 'src/util', 'src/util/.gitignore', 'src/util/strings.ts']);
    expect(repo.stats.ignored).toBe(4);
    expect(repo.stats.files).toBe(8);
    expect(repo.stats.dirs).toBe(3);
  });

  it('orders entries (dirs first), aggregates sizes/lines and detects languages', async () => {
    const repo = await scanRepo(root, nodeFs);
    const top = repoChildren(repo, 0).map((i) => repo.names[i]);
    expect(top).toEqual(['assets', 'src', '.gitignore', 'keep.log', 'README.md']);
    const idx = repoIndex(repo);
    const src = idx.get('src')!;
    expect(repo.kind[src]).toBe(K_DIR);
    expect(repo.files[src]).toBe(4);
    expect(repo.lines[idx.get('src/index.ts')!]).toBe(2);
    expect(repo.lines[idx.get('src/app.py')!]).toBe(3);
    expect(repo.lines[idx.get('assets/logo.png')!]).toBe(-1);
    expect(repo.lines[src]).toBe(2 + 1 + 3 + 1);
    expect(repoPath(repo, idx.get('src/util/strings.ts')!)).toBe('src/util/strings.ts');
    expect(repo.size[0]).toBe(repo.stats.bytes);
    const ts = repo.languages.find((l) => l.id === 'typescript')!;
    expect(ts.files).toBe(2);
    expect(repo.languages[repo.lang[idx.get('src/app.py')!]].name).toBe('Python');
    // subtree ranges are consistent
    expect(repo.subtree[0]).toBe(repo.names.length);
  });

  it('can ignore .gitignore and stop at maxFiles', async () => {
    const all = await scanRepo(root, nodeFs, { respectGitignore: false });
    expect(repoIndex(all).has('dist/out.js')).toBe(true);
    expect(repoIndex(all).has('node_modules/x/index.js')).toBe(false);
    const capped = await scanRepo(root, nodeFs, { maxFiles: 3 });
    expect(capped.stats.files).toBe(3);
    expect(capped.stats.truncated).toBe(true);
  });
});
