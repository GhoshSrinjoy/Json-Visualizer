import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/tools';
import { Workspace } from '../../src/node/workspace';

let root = '';
let ws: Workspace;
const run = (name: string, args: Record<string, unknown>, cli = false) => TOOLS.find((t) => t.name === name)!.run(ws, args, { cli });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'structlens-data-tools-'));
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w('old.json', JSON.stringify({ name: 'svc', port: 80, users: [{ id: 1, role: 'a' }, { id: 2, role: 'b' }] }));
  w('new.yaml', 'name: svc\nport: 8080\nusers:\n  - id: 2\n    role: b\n  - id: 1\n    role: a\n  - id: 3\n    role: c\n');
  w('schemas/common.json', JSON.stringify({ $defs: { role: { enum: ['a', 'b'] } } }));
  w('schemas/config.json', JSON.stringify({ type: 'object', required: ['name', 'port'], properties: { port: { type: 'integer', maximum: 1024 }, users: { type: 'array', items: { properties: { role: { $ref: 'common.json#/$defs/role' } } } } } }));
  w('data/config.json', JSON.stringify({ $schema: '../schemas/config.json', name: 'svc', port: 8080, users: [{ role: 'a' }, { role: 'z' }] }, null, 2));
  w('data/plain.json', JSON.stringify({ a: 1 }));
  w('data/escape.json', JSON.stringify({ $schema: '../../outside.json' }));
  ws = new Workspace(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('data tools', () => {
  it('diffs files across formats, matching records by id', async () => {
    const text = await run('data_diff', { left: 'old.json', right: 'new.yaml' });
    expect(text).toContain('old.json → new.yaml');
    expect(text).toMatch(/~ \$\.port: 80 → 8080/);
    expect(text).toMatch(/\+ \$\.users\[2\]/);
    expect(text).not.toMatch(/role/);
  });

  it("validates against the document's $schema, following $ref across files", async () => {
    const text = await run('data_validate', { path: 'data/config.json' });
    expect(text).toContain('2 errors');
    expect(text).toMatch(/\$\.port \(line \d+\): must be ≤ 1024|\$\.port \(line \d+\): .*1024/);
    expect(text).toMatch(/\$\.users\[1\]\.role/);
    expect(await run('data_validate', { path: 'data/plain.json' })).toContain('has no $schema');
    expect(await run('data_validate', { path: 'data/plain.json', schema: 'schemas/config.json' })).toContain('2 errors');
  });

  it('keeps schema references inside the workspace', async () => {
    await expect(run('data_validate', { path: 'data/escape.json' })).rejects.toThrow(/outside the workspace/);
  });

  it('generates types and converts formats', async () => {
    const go = await run('data_types', { path: 'old.json', language: 'go' });
    expect(go).toContain('type Old struct');
    expect(go).toContain('`json:"users"`');
    const csv = await run('data_convert', { path: 'new.yaml', to: 'csv', at: '$.users' });
    expect(csv).toBe('id,role\n2,b\n1,a\n3,c\n');
    const big = await run('data_convert', { path: 'old.json', to: 'yaml', maxChars: 10 });
    expect(big).toContain('more characters');
    // The CLI prints everything unless asked otherwise.
    expect(await run('data_convert', { path: 'old.json', to: 'yaml' }, true)).not.toContain('more characters');
  });
});
