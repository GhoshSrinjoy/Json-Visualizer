import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateByFolder, buildDependencyGraph, extractImports, type DepGraph } from '../../src/core/repo/deps';
import { scanRepo } from '../../src/core/repo/scan';
import { nodeFs } from '../../src/node/fs';

let root = '';
let graph: DepGraph;

const files: Record<string, string> = {
  'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }',
  'src/index.ts': "import { a } from './a';\nimport b from '@lib/b';\nimport fs from 'node:fs';\nimport React from 'react';\nimport { x } from '@acme/ui/button';\nexport * from './c.js';\n// import nope from './commented';\n",
  'src/a.ts': "import { c } from './c';\nexport const a = 1;",
  'src/c.ts': "import { a } from './a';\nexport const c = 2;", // cycle a <-> c
  'src/lib/b.ts': "const p = require('path');\nexport default p;",
  'packages/ui/package.json': '{ "name": "@acme/ui", "main": "src/index.ts" }',
  'packages/ui/src/index.ts': 'export {}',
  'packages/ui/button.tsx': 'export const x = 1;',
  'py/src/app/__init__.py': '',
  'py/src/app/main.py': 'import os, json\nfrom app.models import User\nfrom . import util\nfrom .missing import thing\nimport numpy as np\n',
  'py/src/app/models.py': 'class User: pass',
  'py/src/app/util.py': '',
  'go/go.mod': 'module example.com/svc\n\ngo 1.22\n',
  'go/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/svc/internal/db"\n\t"github.com/pkg/errors"\n)\n',
  'go/internal/db/db.go': 'package db',
  'jvm/com/acme/App.java': 'package com.acme;\nimport com.acme.util.Strings;\nimport java.util.List;\nimport com.acme.model.*;\n',
  'jvm/com/acme/util/Strings.java': 'package com.acme.util;',
  'jvm/com/acme/model/User.java': 'package com.acme.model;',
  'c/main.c': '#include <stdio.h>\n#include "util/log.h"\n',
  'c/util/log.h': '#pragma once',
  'rs/Cargo.toml': '[package]\nname = "x"',
  'rs/src/main.rs': 'mod parser;\nuse crate::parser::lexer;\nuse std::io;\nuse serde::Deserialize;\n',
  'rs/src/parser/mod.rs': 'pub mod lexer;',
  'rs/src/parser/lexer.rs': '',
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'structlens-deps-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  const repo = await scanRepo(root, nodeFs);
  graph = await buildDependencyGraph(repo, nodeFs);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const targets = (from: string) => {
  const f = graph.nodes.find((n) => n.path === from)!;
  return graph.edges.filter((e) => e.from === f.id).map((e) => graph.nodes[e.to].path).sort();
};

describe('extractImports', () => {
  it('skips comments and finds multi-line imports', () => {
    const r = extractImports("import {\n  a,\n  b\n} from './x';\n/* import y from 'y' */\nconst z = require('z');", 'f.ts');
    expect(r.map((i) => [i.specifier, i.line])).toEqual([['./x', 0], ['z', 5]]);
  });
});

describe('buildDependencyGraph', () => {
  it('resolves TS relative, tsconfig paths, workspaces, builtins and packages', () => {
    expect(targets('src/index.ts')).toEqual(['node:fs', 'packages/ui/button.tsx', 'react', 'src/a.ts', 'src/c.ts', 'src/lib/b.ts']);
    expect(targets('src/lib/b.ts')).toEqual(['node:path']);
  });
  it('resolves Python roots, relative imports and submodules', () => {
    expect(targets('py/src/app/main.py')).toEqual(['json', 'numpy', 'os', 'py/src/app/models.py', 'py/src/app/util.py']);
    expect(graph.unresolved.map((u) => u.specifier)).toContain('.missing');
    expect(graph.nodes.find((n) => n.path === 'numpy')!.group).toBe('pypi');
    expect(graph.nodes.find((n) => n.path === 'os')!.group).toBe('python');
  });
  it('resolves Go modules, Java packages, C includes and Rust modules', () => {
    expect(targets('go/main.go')).toEqual(['fmt', 'github.com/pkg/errors', 'go/internal/db']);
    expect(targets('jvm/com/acme/App.java')).toEqual(['java', 'jvm/com/acme/model', 'jvm/com/acme/util/Strings.java']);
    expect(targets('c/main.c')).toEqual(['c/util/log.h', 'stdio.h']);
    expect(targets('rs/src/main.rs')).toEqual(['rs/src/parser/lexer.rs', 'rs/src/parser/mod.rs', 'serde', 'std']);
  });
  it('detects cycles and rolls up by folder', () => {
    const cyc = graph.cycles.map((c) => c.map((id) => graph.nodes[id].path).sort());
    expect(cyc).toContainEqual(['src/a.ts', 'src/c.ts']);
    const byTop = aggregateByFolder(graph, 1);
    const src = byTop.nodes.find((n) => n.path === 'src')!;
    const outs = byTop.edges.filter((e) => e.from === src.id).map((e) => byTop.nodes[e.to].path).sort();
    expect(outs).toEqual(['node', 'npm', 'packages']);
  });
});
