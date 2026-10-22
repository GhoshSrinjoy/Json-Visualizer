// The extension activates in every VS Code window, so its entry bundle must stay small: everything
// heavy lives in dist/features.js and is required on first use (see scripts/build.mjs).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/tools';

const root = resolve(__dirname, '../..');

describe('extension entry bundle', () => {
  it('stays small and leaves the implementation to features.js', async () => {
    const result = await build({
      entryPoints: [join(root, 'src/extension/extension.ts')],
      bundle: true,
      write: false,
      minify: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode', './features.js'],
      define: { __STRUCTLENS_VERSION__: '"test"' },
      metafile: true,
      logLevel: 'error',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((p) => p.includes('node_modules'))).toEqual([]);
    expect(inputs.filter((p) => /src[\\/](core|mcp|cli)[\\/]|panel|services|agents/.test(p))).toEqual([]);
    expect(result.outputFiles[0].text).toContain('require("./features.js")');
    expect(result.outputFiles[0].contents.length).toBeLessThan(16 * 1024);
  });

  it('has a handler in features.ts for every contributed command (they are registered from package.json)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { contributes: { commands: { command: string }[] } };
    const features = readFileSync(join(root, 'src/extension/features.ts'), 'utf8');
    const missing = pkg.contributes.commands.map((c) => c.command).filter((id) => id !== 'structlens.showLog' && !features.includes(`'${id}':`));
    expect(missing).toEqual([]);
  });

  it('registers Copilot tools from package.json, which must list every tool', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { contributes: { languageModelTools: { name: string; displayName: string }[] } };
    const manifest = pkg.contributes.languageModelTools;
    expect(manifest.map((t) => t.name)).toEqual(TOOLS.map((t) => `structlens_${t.name}`));
    expect(manifest.map((t) => t.displayName)).toEqual(TOOLS.map((t) => `StructLens: ${t.title}`));
  });
});
