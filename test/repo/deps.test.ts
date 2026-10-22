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

  const specs = (text: string, path: string) => extractImports(text, path).map((i) => i.specifier);

  it('reads strings, template literals and regexes before looking for comments (JS)', () => {
    // `'lib/*.js'` and `'*/*'` used to open or close a block comment and hide the imports.
    expect(specs("const files = glob.sync('lib/*.js');\nconst helper = require('./helper');\n/** docs */\n", 'a.js')).toEqual(['./helper']);
    expect(specs("const h = { Accept: '*/*' };\nconst lazy = () => import('./lazy');\n/** doc */\nexport const y = 1;\n", 'a.ts')).toEqual(['./lazy']);
    expect(specs("const q = s.replace(/'/g, ''); import z from './z';\nconst re = /\\/\\*/; import w from './w';\n", 'a.js')).toEqual(['./z', './w']);
    expect(specs("const t = `${a}/*`; import q from './q';\nconst g = `import fake from './fake'`;\n", 'a.ts')).toEqual(['./q']);
    expect(specs("const u = `${ require('./inner') }`;\nconst d = a / b; // import no from './no'\n", 'a.js')).toEqual(['./inner']);
  });

  it('skips docstrings and strings where imports never use them (Python, Java, C#)', () => {
    expect(specs('"""\nExample:\n    from app import views\n"""\nx = "# no comment"\nimport os  # import sys\n', 'doc.py')).toEqual(['os']);
    expect(specs('String t = """\nimport a.b.C;\n""";\nimport java.util.List;\n', 'A.java')).toEqual(['java.util.List']);
    expect(specs('var p = @"C:\\dir\\"; // using No;\nusing System.Text;\n', 'A.cs')).toEqual(['System.Text']);
  });

  it('keeps string specifiers and skips comment markers inside strings (Go, C, Lua, CSS)', () => {
    expect(specs('package main\nimport (\n\t"fmt" // fmt\n\t"example.com/x"\n)\nvar s = `/* raw`\nimport "after"\n', 'a.go').sort()).toEqual(['after', 'example.com/x', 'fmt']);
    expect(specs('#include "a//b.h"\n/* #include "no.h" */\nchar c = \'"\';\nconst char* r = R"x(/* )x";\n#include "after.h"\n', 'a.c')).toEqual([
      '"a//b.h"',
      '"after.h"',
    ]);
    expect(specs("local s = '--'; require('y')\n--[[ require('no') ]]\nrequire 'z'\n", 'a.lua')).toEqual(['y', 'z']);
    expect(specs("@import url(//fonts.example.com/x.css);\n// @import 'no';\n@use 'sass:math';\n", 'a.scss')).toEqual(['//fonts.example.com/x.css', 'sass:math']);
  });

  it('reads Rust chars, lifetimes, raw strings and nested comments, and local module paths', () => {
    const src = "fn f<'a>(x: &'a str) -> char { 'x' }\nlet s = r#\"/* \"#;\nmod config;\n/* /* nested */ mod no; */\nuse config::Settings;\nmod inline { }\nuse inline::Thing;\nuse serde::Deserialize;\n";
    expect(specs(src, 'src/main.rs')).toEqual(['config', 'self::config::Settings', 'serde::Deserialize']);
  });

  it('ignores trait `use` in class bodies and inline HTML (PHP)', () => {
    const src = "<?php\nnamespace App;\nuse App\\Concerns\\HasName;\n# use No\\Thing;\n#[Attr]\nclass User {\n    use HasName;\n    use A, B { A::x insteadof B; }\n}\n?>\n<p>Don't</p>\n<?php require 'footer.php'; ?>\n";
    expect(specs(src, 'src/User.php')).toEqual(['App\\Concerns\\HasName', 'footer.php']);
    expect(specs('<?php\nnamespace App {\n    use App\\Models\\User;\n    class A { use T; }\n}\n', 'b.php')).toEqual(['App\\Models\\User']);
  });
});

describe('buildDependencyGraph: packages, strings and local modules', () => {
  let dir = '';
  let g: DepGraph;
  const BS = '\\';
  const sources: Record<string, string> = {
    'py/app/__init__.py': '',
    'py/app/models.py': 'def save(x):\n    return x\n',
    'py/app/views.py': 'def render():\n    pass\n',
    'py/main.py': 'from app import models, views\n',
    'py/doc.py': '"""\nExample:\n    from app import views\n"""\nx = 1\n',
    'py/app/sub.py': 'from . import models\n',
    'js/a.js': "const files = glob.sync('lib/*.js');\nconst helper = require('./helper');\n",
    'js/helper.js': 'module.exports = 1;\n',
    'js/accept.ts': "const h = { Accept: '*/*' };\nconst lazy = () => import('./lazy');\n",
    'js/lazy.ts': 'export default 1;\n',
    'rs/Cargo.toml': '[package]\nname = "x"\n',
    'rs/src/main.rs': 'mod config;\nuse config::Settings;\nfn main() {}\n',
    'rs/src/config.rs': 'pub struct Settings;\n',
    'php/composer.json': JSON.stringify({ autoload: { 'psr-4': { [`App${BS}`]: 'src/' } } }),
    'php/src/User.php': `<?php\nnamespace App;\nuse App${BS}Concerns${BS}HasName;\nclass User {\n    use HasName;\n}\n`,
    'php/src/Concerns/HasName.php': `<?php\nnamespace App${BS}Concerns;\ntrait HasName {}\n`,
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'structlens-deps2-'));
    for (const [rel, content] of Object.entries(sources)) {
      const p = join(dir, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
    }
    g = await buildDependencyGraph(await scanRepo(dir, nodeFs), nodeFs);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const out = (from: string) => {
    const f = g.nodes.find((n) => n.path === from);
    return f ? g.edges.filter((e) => e.from === f.id).map((e) => `${g.nodes[e.to].kind}:${g.nodes[e.to].path}`).sort() : [];
  };

  it('links `from pkg import mod` to the package and to each module', () => {
    expect(out('py/main.py')).toEqual(['file:py/app/__init__.py', 'file:py/app/models.py', 'file:py/app/views.py']);
    expect(out('py/app/sub.py')).toEqual(['file:py/app/models.py']);
    expect(out('py/doc.py')).toEqual([]);
  });

  it('finds imports after strings that look like comments', () => {
    expect(out('js/a.js')).toEqual(['file:js/helper.js']);
    expect(out('js/accept.ts')).toEqual(['file:js/lazy.ts']);
  });

  it('resolves `use` of a declared module, and drops trait `use` in a class', () => {
    expect(out('rs/src/main.rs')).toEqual(['file:rs/src/config.rs']);
    expect(out('php/src/User.php')).toEqual(['file:php/src/Concerns/HasName.php']);
    expect(g.nodes.some((n) => n.path === 'config' || n.path === 'HasName')).toBe(false);
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
