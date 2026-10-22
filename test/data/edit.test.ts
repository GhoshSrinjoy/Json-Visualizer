import { describe, expect, it } from 'vitest';
import { toPlain } from '../../src/core/data/convert';
import { applyEdits, editCaps, EditError, editsFor, type EditOp } from '../../src/core/data/edit';
import { parseData } from '../../src/core/data/formats';
import type { DataFormat, DataTree } from '../../src/core/data/tree';

/** Finds a node by path segments. */
function at(t: DataTree, ...path: (string | number)[]): number {
  let id = t.root;
  for (const seg of path) {
    const kids = t.children(id);
    id = typeof seg === 'number' && t.type[id] === 2 ? kids[seg] : kids.find((c) => t.key(c) === seg)!;
    if (id === undefined) throw new Error(`no ${seg}`);
  }
  return id;
}

function run(text: string, format: DataFormat, make: (t: DataTree) => EditOp): { text: string; value: unknown } {
  const t = parseData(text, format);
  const out = applyEdits(text, editsFor(t, make(t)));
  const back = parseData(out, format);
  expect(back.errors.filter((e) => (e as { severity?: string }).severity !== 'warning')).toEqual([]);
  return { text: out, value: toPlain(back) };
}

const JSONC = `{
  // settings for the service
  "name": "directory",
  "port": 8080,
  "tags": ["a", "b"],
  "owner": { "id": 1, "email": "ada@example.com" }
}
`;

describe('editsFor (JSON family)', () => {
  it('sets values of every kind, keeping comments and layout', () => {
    const r = run(JSONC, 'jsonc', (t) => ({ kind: 'set', id: at(t, 'port'), type: 'number', value: '9090' }));
    expect(r.text).toBe(JSONC.replace('8080', '9090'));
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'set', id: at(t, 'name'), type: 'string', value: 'say "hi"\n' })).value).toMatchObject({ name: 'say "hi"\n' });
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'set', id: at(t, 'owner'), type: 'json', value: '{"id": 2}' })).value).toMatchObject({ owner: { id: 2 } });
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'set', id: at(t, 'tags', 1), type: 'null', value: '' })).value).toMatchObject({ tags: ['a', null] });
    expect(() => editsFor(parseData(JSONC, 'jsonc'), { kind: 'set', id: 3, type: 'number', value: '12abc' })).toThrow(EditError);
    expect(() => editsFor(parseData(JSONC, 'jsonc'), { kind: 'set', id: 3, type: 'json', value: '{oops' })).toThrow(/Not valid JSON/);
  });

  it('renames keys and refuses duplicates', () => {
    const r = run(JSONC, 'jsonc', (t) => ({ kind: 'rename', id: at(t, 'port'), key: 'listen port' }));
    expect(r.text).toContain('"listen port": 8080');
    expect(r.text).toContain('// settings for the service');
    expect(() => editsFor(parseData(JSONC, 'jsonc'), { kind: 'rename', id: at(parseData(JSONC, 'jsonc'), 'port'), key: 'name' })).toThrow(/already a key/);
  });

  it('deletes first, middle, last and only members', () => {
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'delete', id: at(t, 'name') })).value).toEqual({ port: 8080, tags: ['a', 'b'], owner: { id: 1, email: 'ada@example.com' } });
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'delete', id: at(t, 'owner') })).value).toEqual({ name: 'directory', port: 8080, tags: ['a', 'b'] });
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'delete', id: at(t, 'tags', 1) })).value).toMatchObject({ tags: ['a'] });
    const only = run('{"a": [1]}', 'json', (t) => ({ kind: 'delete', id: at(t, 'a', 0) }));
    expect(only.text).toBe('{"a": []}');
  });

  it('adds properties and items in the document’s own style', () => {
    const r = run(JSONC, 'jsonc', (t) => ({ kind: 'add', id: t.root, key: 'debug', type: 'boolean', value: 'true' }));
    expect(r.text).toContain('"owner": { "id": 1, "email": "ada@example.com" },\n  "debug": true\n}');
    expect(run(JSONC, 'jsonc', (t) => ({ kind: 'add', id: at(t, 'tags'), type: 'string', value: 'c' })).value).toMatchObject({ tags: ['a', 'b', 'c'] });
    expect(run('{"a":{}}', 'json', (t) => ({ kind: 'add', id: at(t, 'a'), key: 'x', type: 'number', value: '1' })).text).toBe('{"a":{"x": 1}}');
    expect(run('{"a":1}', 'json', (t) => ({ kind: 'add', id: t.root, key: 'b', type: 'number', value: '2' })).text).toBe('{"a":1,"b":2}');
  });
});

const YAML = `# service config
name: directory
port: 8080
tags:
  - a
  - b
owner:
  id: 1
  email: "ada@example.com"
flow: {x: 1, y: [1, 2]}
`;

describe('editsFor (YAML)', () => {
  it('sets scalars with YAML-safe quoting', () => {
    expect(run(YAML, 'yaml', (t) => ({ kind: 'set', id: at(t, 'port'), type: 'number', value: '9090' })).text).toBe(YAML.replace('8080', '9090'));
    const s = run(YAML, 'yaml', (t) => ({ kind: 'set', id: at(t, 'owner', 'email'), type: 'string', value: 'yes' }));
    expect(s.text).toContain('email: "yes"');
    expect(s.value).toMatchObject({ owner: { email: 'yes' } });
    expect(run(YAML, 'yaml', (t) => ({ kind: 'set', id: at(t, 'name'), type: 'string', value: 'a: b' })).value).toMatchObject({ name: 'a: b' });
    expect(editCaps(parseData(YAML, 'yaml'), at(parseData(YAML, 'yaml'), 'owner')).set).toBe(false);
  });

  it('renames, deletes and adds in block collections', () => {
    expect(run(YAML, 'yaml', (t) => ({ kind: 'rename', id: at(t, 'port'), key: 'listen' })).text).toContain('listen: 8080');
    const d = run(YAML, 'yaml', (t) => ({ kind: 'delete', id: at(t, 'tags', 0) }));
    expect(d.text).toContain('tags:\n  - b\nowner:');
    expect(run(YAML, 'yaml', (t) => ({ kind: 'delete', id: at(t, 'owner') })).value).not.toHaveProperty('owner');
    expect(run(YAML, 'yaml', (t) => ({ kind: 'add', id: at(t, 'owner'), key: 'role', type: 'string', value: 'admin' })).text).toContain('  email: "ada@example.com"\n  role: admin\nflow:');
    expect(run(YAML, 'yaml', (t) => ({ kind: 'add', id: at(t, 'tags'), type: 'string', value: 'c' })).value).toMatchObject({ tags: ['a', 'b', 'c'] });
  });

  it('edits flow collections like JSON', () => {
    expect(run(YAML, 'yaml', (t) => ({ kind: 'delete', id: at(t, 'flow', 'x') })).value).toMatchObject({ flow: { y: [1, 2] } });
    expect(run(YAML, 'yaml', (t) => ({ kind: 'add', id: at(t, 'flow', 'y'), type: 'number', value: '3' })).value).toMatchObject({ flow: { x: 1, y: [1, 2, 3] } });
  });

  it('refuses formats and nodes it cannot edit safely', () => {
    const csv = parseData('a,b\n1,2\n', 'csv');
    expect(editCaps(csv, csv.children(csv.root)[0])).toEqual({ set: false, rename: false, delete: false, add: false });
    const json = parseData('{"a":1}', 'json');
    expect(editCaps(json, json.root).delete).toBe(false);
  });
});
