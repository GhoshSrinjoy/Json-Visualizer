import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASE_INSENSITIVE_FS, isWithin, relativeTo } from '../../src/node/paths';
import { PathError, Workspace } from '../../src/node/workspace';
import '../../src/core/code/languages';

let base = '';
let root = '';
let outside = '';

/** Creates a link to a directory (a junction on Windows, which needs no privileges); false when the OS refuses. */
function linkDir(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

function linkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false; // Windows without Developer Mode or admin rights
  }
}

const w = (rel: string, text: string) => {
  mkdirSync(join(rel, '..'), { recursive: true });
  writeFileSync(rel, text);
};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'structlens ws '));
  root = join(base, 'ws');
  outside = join(base, 'outside');
  w(join(root, 'data', 'a.json'), '{"ok": true}');
  w(join(root, 'sub', 'inner.json'), '{"inner": "yes"}');
  w(join(root, 'src', 'main.ts'), "import { helper } from './util';\nexport function main() { return helper(); }\n");
  w(join(root, 'src', 'util.ts'), 'export function helper() { return 1; }\n');
  w(join(outside, 'secret.ini'), '[default]\naws_secret_access_key = SUPERSECRET\n');
  w(join(outside, 'secret.ts'), "import 'leaked-package-name';\nexport function topSecretFunction() { return 42; }\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('path helpers', () => {
  it('compare with the file system’s case rules', () => {
    const r = join(base, 'Root');
    expect(isWithin(join(r, 'x'), r)).toBe(true);
    expect(isWithin(r + 'x', r)).toBe(false);
    expect(isWithin(join(base, 'root', 'x'), r)).toBe(CASE_INSENSITIVE_FS);
    expect(relativeTo(r, join(r, 'a', 'b.json'))).toBe('a/b.json');
    expect(relativeTo(r, r)).toBe('.');
  });
});

describe('Workspace.resolvePath', () => {
  it('resolves relative and absolute paths inside the root and rejects others', () => {
    const ws = new Workspace(root);
    expect(ws.resolvePath('data/a.json')).toBe(join(root, 'data', 'a.json'));
    expect(ws.resolvePath(join(root, 'data'))).toBe(join(root, 'data'));
    expect(ws.resolvePath('not/yet/created.json')).toBe(join(root, 'not', 'yet', 'created.json'));
    expect(() => ws.resolvePath('../outside/secret.ini')).toThrow(PathError);
    expect(() => ws.resolvePath(join(outside, 'secret.ini'))).toThrow(/outside the workspace/);
    expect(() => ws.resolvePath(root + 'x')).toThrow(/outside the workspace/);
  });

  it('accepts file:// URLs, including encoded characters', () => {
    const ws = new Workspace(root);
    const url = pathToFileURL(join(root, 'data', 'a.json')).href;
    expect(url).toContain('%20'); // the temp folder name has a space
    expect(ws.resolvePath(url)).toBe(join(root, 'data', 'a.json'));
    expect(() => ws.resolvePath(pathToFileURL(join(outside, 'secret.ini')).href)).toThrow(/outside the workspace/);
    expect(() => ws.resolvePath('file://remote-host/share/x.json')).toThrow(PathError);
  });

  it.runIf(CASE_INSENSITIVE_FS)('ignores letter case on case-insensitive file systems', async () => {
    const ws = new Workspace(root.toUpperCase());
    const abs = ws.resolvePath(join(root, 'data', 'a.json'));
    expect(abs).toBe(join(root, 'data', 'a.json'));
    expect(ws.rel(abs)).toBe('data/a.json');
    expect(ws.rootOf(abs)).toBe(root.toUpperCase());
    expect((await ws.data(join(root.toLowerCase(), 'DATA', 'A.JSON'))).tree.toJS()).toEqual({ ok: true });
  });

  it('maps another spelling of a root (real path, short names) back under the root', () => {
    const ws = new Workspace(root);
    const real = realpathSync.native(root);
    const abs = ws.resolvePath(join(real, 'data', 'a.json'));
    expect(abs).toBe(join(root, 'data', 'a.json'));
    expect(ws.rel(abs)).toBe('data/a.json');
  });
});

describe('Workspace and links', () => {
  it('rejects paths that leave the workspace through a directory link or junction', async (ctx) => {
    if (!linkDir(outside, join(root, 'link'))) return ctx.skip();
    const ws = new Workspace(root);
    await expect(ws.data('link/secret.ini')).rejects.toThrow(/outside the workspace \(through a symbolic link or junction\)/);
    expect(() => ws.resolvePath('link')).toThrow(PathError);
    expect(() => ws.resolvePath('link/not-yet-there.json')).toThrow(PathError);
    expect(() => ws.resolvePath(pathToFileURL(join(root, 'link', 'secret.ini')).href)).toThrow(PathError);
  });

  it('follows links that stay inside the workspace', async (ctx) => {
    if (!linkDir(join(root, 'sub'), join(root, 'inner-link'))) return ctx.skip();
    const ws = new Workspace(root);
    expect((await ws.data('inner-link/inner.json')).tree.toJS()).toEqual({ inner: 'yes' });
  });

  it('rejects file links to the outside and does not read them for symbols or dependencies', async (ctx) => {
    if (!linkFile(join(outside, 'secret.ini'), join(root, 'secret-link.ini')) || !linkFile(join(outside, 'secret.ts'), join(root, 'src', 'evil.ts'))) return ctx.skip();
    const ws = new Workspace(root);
    await expect(ws.data('secret-link.ini')).rejects.toThrow(/outside the workspace/);
    await expect(ws.outline('src/evil.ts')).rejects.toThrow(/outside the workspace/);
    expect(await ws.findSymbols('topSecret')).toEqual([]);
    expect((await ws.findSymbols('helper')).map((h) => h.path)).toEqual(['src/util.ts']);
    const deps = await ws.deps('.');
    expect(deps.nodes.map((n) => n.path)).not.toContain('leaked-package-name');
    expect(deps.nodes.map((n) => n.path)).toContain('src/util.ts');
    const calls = await ws.callGraph(['src']);
    expect(calls.nodes.map((n) => n.name)).not.toContain('topSecretFunction');
  });
});
