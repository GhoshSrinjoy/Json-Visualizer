import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { schemaUriOf, validateTree, type ValidateOptions, type ValidationResult } from '../../src/core/data/validate';

const DRAFT4 = 'http://json-schema.org/draft-04/schema#';
const DRAFT7 = 'http://json-schema.org/draft-07/schema#';
const DRAFT2019 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT2020 = 'https://json-schema.org/draft/2020-12/schema';

const doc = (v: unknown) => parseData(JSON.stringify(v, null, 2), 'json');
const check = (schema: unknown, data: unknown, options?: ValidateOptions) => validateTree(doc(data), schema, options);
/** `path message` per error: the compact form most assertions compare. */
const lines = (r: ValidationResult) => r.errors.map((e) => `${e.path} ${e.message}`);
const errorsOf = (schema: unknown, data: unknown, options?: ValidateOptions) => lines(check(schema, data, options));
const ok = (schema: unknown, data: unknown) => check(schema, data).valid;

describe('validateTree: values', () => {
  it('checks type, enum and const', () => {
    expect(errorsOf({ type: 'integer' }, 1.5)).toEqual(['$ must be integer']);
    expect(validateTree(parseData('1.0', 'json'), { type: 'integer' }).valid).toBe(true);
    expect(errorsOf({ type: ['string', 'null'] }, 5)).toEqual(['$ must be string or null']);
    expect(errorsOf({ enum: ['a', 'b', 'c'] }, 'd')).toEqual(['$ must be one of: "a", "b", "c"']);
    const many = Array.from({ length: 20 }, (_, i) => `v${i}`);
    expect(errorsOf({ enum: many }, 'x')[0]).toMatch(/^\$ must be one of: "v0", "v1", .*, … \(20 values\)$/);
    expect(ok({ enum: [{ a: [1, 2] }, null] }, { a: [1, 2] })).toBe(true);
    expect(ok({ const: { a: [1, 2], b: null } }, { b: null, a: [1, 2] })).toBe(true);
    expect(errorsOf({ const: { a: [1, 2] } }, { a: [1, 3] })).toEqual(['$ must be equal to {"a":[1,2]}']);
  });

  it('checks numeric bounds and float-safe multipleOf', () => {
    const range = { minimum: 0, exclusiveMaximum: 10 };
    expect(errorsOf(range, -1)).toEqual(['$ must be ≥ 0']);
    expect(errorsOf(range, 10)).toEqual(['$ must be < 10']);
    expect(ok(range, 9.99)).toBe(true);
    for (const v of [0.3, 0.7, 1.1, 2.2, 1e308]) expect(ok({ multipleOf: 0.1 }, v)).toBe(true);
    expect(errorsOf({ multipleOf: 0.1 }, 0.35)).toEqual(['$ must be a multiple of 0.1']);
    expect(ok({ multipleOf: 0.01 }, 19.99)).toBe(true);
  });

  it('reads draft-04 boolean exclusiveMinimum / exclusiveMaximum', () => {
    const schema = { $schema: DRAFT4, minimum: 5, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false };
    expect(errorsOf(schema, 5)).toEqual(['$ must be > 5']);
    expect(ok(schema, 5.1)).toBe(true);
    expect(ok(schema, 10)).toBe(true);
    expect(errorsOf(schema, 11)).toEqual(['$ must be ≤ 10']);
  });

  it('counts string length in code points and matches unicode patterns', () => {
    expect(ok({ minLength: 2, maxLength: 2 }, '😀😀')).toBe(true);
    expect(errorsOf({ minLength: 2 }, '😀')).toEqual(['$ must have at least 2 characters']);
    expect(errorsOf({ maxLength: 1 }, 'ab')).toEqual(['$ must have at most 1 character']);
    expect(ok({ pattern: '^\\p{Lu}' }, 'Émile')).toBe(true);
    expect(errorsOf({ pattern: '^[a-z]+$' }, 'abc1')).toEqual(['$ must match pattern "^[a-z]+$"']);
    // Not anchored: `pattern` searches.
    expect(ok({ pattern: 'b' }, 'abc')).toBe(true);
  });

  it('reports an invalid pattern once instead of throwing', () => {
    const r = check({ items: { pattern: '(' } }, ['a', 'b', 'c']);
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ path: '$[0]', keyword: 'pattern', schemaPath: '#/items/pattern' });
    expect(r.errors[0].message).toMatch(/^invalid pattern "\(" in the schema/);
  });
});

describe('validateTree: arrays', () => {
  it('checks size, uniqueness and contains', () => {
    expect(errorsOf({ maxItems: 3 }, [1, 2, 3, 4])).toEqual(['$ must have at most 3 items']);
    expect(errorsOf({ minItems: 1 }, [])).toEqual(['$ must have at least 1 item']);
    expect(errorsOf({ uniqueItems: true }, [1, 2, 1])).toEqual(['$[2] must be unique (same as item [0])']);
    expect(errorsOf({ uniqueItems: true }, [{ a: 1, b: [2] }, { b: [2], a: 1 }])).toEqual(['$[1] must be unique (same as item [0])']);
    expect(ok({ uniqueItems: true }, [1, '1', true, null, [1], { a: 1 }])).toBe(true);
    const some = { contains: { type: 'string' }, minContains: 2, maxContains: 3 };
    expect(errorsOf(some, [1, 'a'])).toEqual(['$ must contain at least 2 matching items']);
    expect(errorsOf(some, ['a', 'b', 'c', 'd'])).toEqual(['$ must contain at most 3 matching items']);
    expect(errorsOf({ contains: { const: 5 } }, [1, 2])).toEqual(['$ must contain at least 1 matching item']);
  });

  it('validates tuple items and additionalItems (draft-07)', () => {
    const tuple = { $schema: DRAFT7, items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false };
    expect(ok(tuple, ['a', 1])).toBe(true);
    expect(errorsOf(tuple, [1])).toEqual(['$[0] must be string']);
    expect(errorsOf(tuple, ['a', 1, true])).toEqual(['$[2] must NOT have additional item [2] (at most 2 items)']);
    expect(errorsOf({ ...tuple, additionalItems: { type: 'boolean' } }, ['a', 1, true, 'x'])).toEqual(['$[3] must be boolean']);
    // A schema-form `items` applies to every item and ignores additionalItems.
    expect(errorsOf({ $schema: DRAFT7, items: { type: 'number' }, additionalItems: false }, [1, 'x'])).toEqual(['$[1] must be number']);
  });

  it('validates prefixItems (2020-12)', () => {
    const schema = { $schema: DRAFT2020, prefixItems: [{ type: 'string' }], items: { type: 'number' } };
    expect(ok(schema, ['a', 1, 2])).toBe(true);
    expect(errorsOf(schema, ['a', 1, 'b'])).toEqual(['$[2] must be number']);
    expect(errorsOf({ ...schema, items: false }, ['a', 1])).toEqual(['$[1] must NOT have additional item [1] (at most 1 item)']);
    expect(errorsOf({ $schema: DRAFT2020, items: false }, [1])).toEqual(['$[0] must NOT have any items']);
  });

  it('tracks evaluated items for unevaluatedItems', () => {
    const schema = { $schema: DRAFT2020, prefixItems: [{ type: 'string' }], allOf: [{ prefixItems: [true, { type: 'number' }] }], unevaluatedItems: false };
    expect(ok(schema, ['a', 1])).toBe(true);
    expect(errorsOf(schema, ['a', 1, null])).toEqual(['$[2] must NOT have unevaluated item [2]']);
    expect(ok({ $schema: DRAFT2020, contains: { type: 'string' }, unevaluatedItems: { type: 'number' } }, ['a', 1, 'b'])).toBe(true);
  });
});

describe('validateTree: objects', () => {
  it('pins required errors on the object and additional properties on the property', () => {
    const schema = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' } }, additionalProperties: false };
    const tree = doc({ id: 1, extra: true });
    const r = validateTree(tree, schema);
    expect(lines(r)).toEqual(['$ missing required property "name"', '$.extra must NOT have additional property "extra"']);
    expect(tree.typeName(r.errors[0].id)).toBe('object');
    expect(r.errors[0]).toMatchObject({ keyword: 'required', schemaPath: '#/required' });
    expect(tree.key(r.errors[1].id)).toBe('extra');
    expect(r.errors[1]).toMatchObject({ keyword: 'additionalProperties', schemaPath: '#/additionalProperties' });
  });

  it('checks patternProperties, property names and property counts', () => {
    const schema = { patternProperties: { '^x-': { type: 'string' } }, additionalProperties: { type: 'number' }, propertyNames: { pattern: '^[a-z-]+$' }, maxProperties: 3 };
    expect(ok(schema, { 'x-a': 'ok', b: 1 })).toBe(true);
    expect(errorsOf(schema, { 'x-a': 1, b: 'no', Bad: 2, c: 3 })).toEqual([
      '$ must have at most 3 properties',
      '$[\'x-a\'] must be string',
      '$.b must be number',
      '$.Bad property name "Bad" must match pattern "^[a-z-]+$"',
    ]);
    expect(errorsOf({ minProperties: 1 }, {})).toEqual(['$ must have at least 1 property']);
  });

  it('checks dependencies, dependentRequired and dependentSchemas', () => {
    const legacy = { $schema: DRAFT7, dependencies: { card: ['billing'], vip: { required: ['tier'] } } };
    expect(errorsOf(legacy, { card: 1 })).toEqual(['$ missing property "billing" required by "card"']);
    expect(errorsOf(legacy, { vip: true })).toEqual(['$ missing required property "tier"']);
    const modern = { $schema: DRAFT2020, dependentRequired: { card: ['billing'] }, dependentSchemas: { vip: { properties: { tier: { minimum: 1 } } } } };
    expect(errorsOf(modern, { card: 1, billing: 2, vip: true, tier: 0 })).toEqual(['$.tier must be ≥ 1']);
    expect(check(modern, { card: 1 }).errors[0]).toMatchObject({ keyword: 'dependentRequired', schemaPath: '#/dependentRequired/card' });
  });

  it('tracks evaluated properties through applicators for unevaluatedProperties', () => {
    const schema = {
      $schema: DRAFT2020,
      properties: { a: true },
      allOf: [{ properties: { b: true } }],
      anyOf: [{ properties: { c: { const: 1 } }, required: ['c'] }, { properties: { d: true } }],
      if: { properties: { kind: { const: 'x' } }, required: ['kind'] },
      then: { properties: { x: true } },
      unevaluatedProperties: false,
    };
    expect(ok(schema, { a: 1, b: 2, c: 1, d: 4 })).toBe(true);
    expect(ok(schema, { kind: 'x', x: 1 })).toBe(true);
    expect(errorsOf(schema, { a: 1, x: 1, e: 5 })).toEqual(['$.x must NOT have unevaluated property "x"', '$.e must NOT have unevaluated property "e"']);
    // Annotations of a failed anyOf branch do not count: `c` is unevaluated when c != 1.
    expect(errorsOf(schema, { c: 2 })).toEqual(['$.c must NOT have unevaluated property "c"']);
  });

  it('handles boolean schemas', () => {
    expect(ok(true, { anything: [1] })).toBe(true);
    expect(errorsOf(false, 1)).toEqual(['$ is not allowed (schema is false)']);
    expect(errorsOf({ properties: { secret: false } }, { secret: 1, ok: 2 })).toEqual(['$.secret must NOT have property "secret"']);
    expect(check({ properties: { secret: false } }, { secret: 1 }).errors[0]).toMatchObject({ keyword: 'properties', schemaPath: '#/properties/secret' });
  });
});

describe('validateTree: references', () => {
  it('follows $ref into $defs and definitions, with escaped pointers', () => {
    const schema = {
      $schema: DRAFT2020,
      properties: { a: { $ref: '#/$defs/positive' }, b: { $ref: '#/definitions/name' }, c: { $ref: '#/$defs/a~1b' }, d: { $ref: '#/$defs/c~0d' }, e: { $ref: '#/$defs/e%20f' } },
      $defs: { positive: { type: 'number', minimum: 0 }, 'a/b': { type: 'string' }, 'c~d': { type: 'boolean' }, 'e f': { type: 'null' } },
      definitions: { name: { type: 'string', minLength: 1 } },
    };
    expect(ok(schema, { a: 1, b: 'x', c: 'y', d: true, e: null })).toBe(true);
    const r = check(schema, { a: -1, b: '', c: 1, d: 1, e: 1 });
    expect(lines(r)).toEqual(['$.a must be ≥ 0', '$.b must have at least 1 character', '$.c must be string', '$.d must be boolean', '$.e must be null']);
    expect(r.errors[0].schemaPath).toBe('#/$defs/positive/minimum');
    expect(r.errors[2].schemaPath).toBe('#/$defs/a~1b/type');
  });

  it('validates a recursive tree schema', () => {
    const schema = {
      $schema: DRAFT2020,
      $ref: '#/$defs/node',
      $defs: { node: { type: 'object', required: ['value'], properties: { value: { type: 'number' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } } } },
    };
    const tree = { value: 1, children: [{ value: 2 }, { value: 3, children: [{ value: 'x' }, { children: [] }] }] };
    expect(errorsOf(schema, tree)).toEqual(['$.children[1].children[0].value must be number', '$.children[1].children[1] missing required property "value"']);
  });

  it('resolves $id, $anchor and legacy plain-name ids', () => {
    const schema = {
      $schema: DRAFT2020,
      $id: 'https://example.com/schemas/root.json',
      properties: { home: { $ref: 'address.json' }, count: { $ref: '#positive' }, other: { $ref: 'https://example.com/schemas/address.json#/properties/zip' } },
      $defs: {
        address: { $id: 'address.json', type: 'object', required: ['street'], properties: { zip: { type: 'string', pattern: '^\\d{5}$' } } },
        positive: { $anchor: 'positive', minimum: 1 },
      },
    };
    expect(ok(schema, { home: { street: 'Main' }, count: 3, other: '12345' })).toBe(true);
    expect(errorsOf(schema, { home: { zip: 'x' }, count: 0, other: '1' })).toEqual([
      '$.home missing required property "street"',
      '$.home.zip must match pattern "^\\d{5}$"',
      '$.count must be ≥ 1',
      '$.other must match pattern "^\\d{5}$"',
    ]);
    const legacy = { $schema: DRAFT7, properties: { n: { $ref: '#num' } }, definitions: { num: { $id: '#num', type: 'number' } } };
    expect(errorsOf(legacy, { n: 'x' })).toEqual(['$.n must be number']);
  });

  it('loads external $ref documents through the resolver, once each', () => {
    const asked: string[] = [];
    const customer = { $defs: { name: { type: 'string', minLength: 2 } } };
    const resolve = (uri: string) => (asked.push(uri), uri === 'https://example.com/schemas/customer.json' ? customer : undefined);
    const schema = { $id: 'https://example.com/schemas/order.json', properties: { buyer: { $ref: 'customer.json#/$defs/name' }, seller: { $ref: 'customer.json#/$defs/name' } } };
    const r = check(schema, { buyer: 'A', seller: 'B' }, { resolve });
    expect(lines(r)).toEqual(['$.buyer must have at least 2 characters', '$.seller must have at least 2 characters']);
    expect(r.errors[0].schemaPath).toBe('https://example.com/schemas/customer.json#/$defs/name/minLength');
    expect(asked).toEqual(['https://example.com/schemas/customer.json']);
    // Without a root $id the reference is passed on as written, relative to the schema file.
    const relative: string[] = [];
    check({ $ref: 'defs/common.json#/$defs/x' }, 1, { resolve: (uri) => (relative.push(uri), undefined) });
    expect(relative).toEqual(['defs/common.json']);
  });

  it('reports an unresolvable $ref once and a circular $ref without hanging', () => {
    const r = check({ items: { $ref: 'missing.json' } }, [1, 2, 3]);
    expect(lines(r)).toEqual(['$[0] cannot resolve $ref "missing.json"']);
    expect(r.errors[0]).toMatchObject({ keyword: '$ref', schemaPath: '#/items/$ref' });
    for (const schema of [{ $ref: '#' }, { allOf: [{ $ref: '#' }] }, { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }]) {
      const loop = check(schema, { a: 1 });
      expect(loop.errors).toHaveLength(1);
      expect(loop.errors[0].message).toMatch(/circular \$ref/);
    }
  });

  it('resolves $dynamicRef in the dynamic scope (2020-12)', () => {
    const list = { $schema: DRAFT2020, $id: 'https://example.com/list', type: 'array', items: { $dynamicRef: '#item' }, $defs: { item: { $dynamicAnchor: 'item' } } };
    const strings = { $schema: DRAFT2020, $id: 'https://example.com/strings', $ref: 'list', $defs: { item: { $dynamicAnchor: 'item', type: 'string' } } };
    const resolve = (uri: string) => (uri === 'https://example.com/list' ? list : undefined);
    expect(check(list, [1, 'a']).valid).toBe(true);
    expect(errorsOf(strings, [1, 'a'], { resolve })).toEqual(['$[0] must be string']);
    const strictTree = {
      $schema: DRAFT2020,
      $id: 'https://example.com/strict-tree',
      $dynamicAnchor: 'node',
      $ref: 'tree',
      unevaluatedProperties: false,
      $defs: {
        tree: { $id: 'https://example.com/tree', $dynamicAnchor: 'node', type: 'object', properties: { data: true, children: { type: 'array', items: { $dynamicRef: '#node' } } } },
      },
    };
    expect(ok(strictTree, { children: [{ data: 1 }] })).toBe(true);
    expect(errorsOf(strictTree, { children: [{ daat: 1 }] })).toEqual(['$.children[0].daat must NOT have unevaluated property "daat"']);
  });

  it('resolves $recursiveRef (2019-09)', () => {
    const tree = { $schema: DRAFT2019, $id: 'https://example.com/tree2019', $recursiveAnchor: true, type: 'object', properties: { data: true, children: { type: 'array', items: { $recursiveRef: '#' } } } };
    const strict = { $schema: DRAFT2019, $id: 'https://example.com/strict2019', $recursiveAnchor: true, $ref: 'tree2019', unevaluatedProperties: false };
    const resolve = (uri: string) => (uri === 'https://example.com/tree2019' ? tree : undefined);
    expect(check(tree, { children: [{ daat: 1 }] }).valid).toBe(true);
    expect(errorsOf(strict, { children: [{ daat: 1 }] }, { resolve })).toEqual(['$.children[0].daat must NOT have unevaluated property "daat"']);
  });

  it('ignores siblings of $ref before 2019-09', () => {
    const schema = { $schema: DRAFT7, definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s', maxLength: 1 } } };
    expect(ok(schema, { a: 'long' })).toBe(true);
    expect(errorsOf({ ...schema, $schema: DRAFT2020 }, { a: 'long' })).toEqual(['$.a must have at most 1 character']);
  });
});

describe('validateTree: applicators', () => {
  it('counts oneOf matches (0, 1, 2)', () => {
    const schema = { oneOf: [{ required: ['a'] }, { required: ['b'] }] };
    expect(ok(schema, { a: 1 })).toBe(true);
    expect(errorsOf(schema, { a: 1, b: 2 })).toEqual(['$ must match exactly one schema in oneOf (matched 2)']);
    // No match, and the branches fail equally: their own errors are joined.
    expect(errorsOf(schema, {})).toEqual(['$ missing required property "a" or "b"']);
    expect(check(schema, {}).errors[0]).toMatchObject({ keyword: 'oneOf', schemaPath: '#/oneOf' });
    const deep = { oneOf: [{ properties: { a: { type: 'string' } } }, { properties: { a: { type: 'number' } } }] };
    expect(errorsOf(deep, { a: true })).toEqual(['$ must match exactly one schema in oneOf']);
  });

  it('reports the errors of the one branch that fits the value', () => {
    const shape = {
      oneOf: [
        { type: 'object', required: ['kind', 'radius'], properties: { kind: { const: 'circle' }, radius: { type: 'number', minimum: 0 } } },
        { type: 'object', required: ['kind', 'side'], properties: { kind: { const: 'square' }, side: { type: 'number' } } },
      ],
    };
    expect(errorsOf(shape, { kind: 'circle', radius: -1 })).toEqual(['$.radius must be ≥ 0']);
    expect(errorsOf(shape, { kind: 'square' })).toEqual(['$ missing required property "side"']);
    // No branch has this tag: the tag itself is the error.
    expect(errorsOf(shape, { kind: 'triangle' })).toEqual(['$.kind must be one of: "circle", "square"']);
    const loose = { anyOf: [{ type: 'string', maxLength: 3 }, { type: 'number' }] };
    expect(errorsOf(loose, 'abcdef')).toEqual(['$ must have at most 3 characters']);
    expect(errorsOf(loose, true)).toEqual(['$ must be string or number']);
    expect(errorsOf({ anyOf: [{ minLength: 5 }, { pattern: '^\\d+$' }] }, 'abc')).toEqual(['$ must have at least 5 characters or must match pattern "^\\d+$"']);
    expect(errorsOf({ anyOf: [{ properties: { a: { type: 'string' } } }, { properties: { a: { type: 'number' } } }] }, { a: true })).toEqual([
      '$ must match at least one schema in anyOf',
    ]);
    // Several object branches: the one failing least (no error on the object itself) explains.
    const job = {
      oneOf: [
        { type: 'object', required: ['runs-on'], properties: { 'runs-on': { type: 'string' }, steps: { type: 'array', items: { required: ['run'] } } } },
        { type: 'object', required: ['uses'], properties: { uses: { type: 'string' } }, additionalProperties: false },
      ],
    };
    expect(errorsOf(job, { 'runs-on': 'linux', steps: [{ name: 'x' }] })).toEqual(['$.steps[0] missing required property "run"']);
    // Nullable reference: the object branch explains a bad object.
    const nullable = { anyOf: [{ type: 'null' }, { $ref: '#/$defs/point' }], $defs: { point: { type: 'object', required: ['x'] } } };
    expect(errorsOf(nullable, { y: 1 })).toEqual(['$ missing required property "x"']);
  });

  it('applies if / then / else, allOf and not', () => {
    const schema = {
      if: { properties: { country: { const: 'US' } } },
      then: { properties: { zip: { pattern: '^\\d{5}$' } } },
      else: { properties: { zip: { pattern: '^[A-Z0-9 ]+$' } } },
    };
    expect(ok(schema, { country: 'US', zip: '12345' })).toBe(true);
    expect(errorsOf(schema, { country: 'US', zip: 'abc' })).toEqual(['$.zip must match pattern "^\\d{5}$"']);
    expect(ok(schema, { country: 'CA', zip: 'K1A 0B1' })).toBe(true);
    expect(errorsOf(schema, { country: 'CA', zip: 'k1a' })).toEqual(['$.zip must match pattern "^[A-Z0-9 ]+$"']);
    expect(errorsOf({ allOf: [{ type: 'number' }, { minimum: 5 }, { maximum: 1 }] }, 3)).toEqual(['$ must be ≥ 5', '$ must be ≤ 1']);
    expect(errorsOf({ not: { type: 'string' } }, 'x')).toEqual(['$ must NOT match the "not" schema']);
  });
});

describe('validateTree: formats', () => {
  const samples: Record<string, [string[], string[]]> = {
    'date-time': [['2024-02-29T23:59:60Z', '2024-01-02T03:04:05.123+05:30', '2024-01-02t03:04:05z'], ['2024-02-30T00:00:00Z', '2024-01-02 03:04', '2024-01-02T03:04:05']],
    date: [['2024-02-29', '2000-12-31'], ['2023-02-29', '2024-1-2', '2024-13-01']],
    time: [['12:34:56Z', '23:59:60+00:00', '08:30:06.283185-07:00'], ['24:00:00Z', '12:00:00', '12:34:60Z']],
    duration: [['P1Y2M3DT4H5M6S', 'P2W', 'PT0S', 'P1D'], ['P', 'PT', 'P1Y2W', 'P1DT', 'PT1D']],
    email: [['ada@example.com', '"john doe"@example.org', 'x@[127.0.0.1]', 'a.b+tag@sub.example.co'], ['ada@', '@example.com', 'a..b@example.com', 'ada@example..com']],
    hostname: [['api.example.com', 'localhost', 'xn--bcher-kva.example'], ['-bad.example', 'a_b.example', 'x'.repeat(64), '']],
    ipv4: [['192.168.0.1', '0.0.0.0'], ['256.1.1.1', '01.2.3.4', '1.2.3']],
    ipv6: [['::1', '2001:db8::8a2e:370:7334', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8'], ['1:2:3', '::1::', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9']],
    uri: [['https://example.com/a?b=c#d', 'urn:isbn:0451450523', 'mailto:ada@example.com'], ['example.com/path', 'http://exa mple.com', '//no-scheme.example']],
    'uri-reference': [['../a/b?c', '#frag', 'https://example.com'], ['a b', '#fr#ag', '\\\\server']],
    uuid: [['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000'], ['123e4567e89b12d3a456426614174000', '123e4567-e89b-12d3-a456-42661417400g']],
    regex: [['^[a-z]+$', '\\p{L}+'], ['(unclosed', '[z-a]']],
    'json-pointer': [['', '/a/b~1c', '/0'], ['a/b', '/~2', '#/a']],
  };
  for (const [format, [good, bad]] of Object.entries(samples)) {
    it(format, () => {
      for (const v of good) expect([v, ok({ format }, v)]).toEqual([v, true]);
      for (const v of bad) expect([v, errorsOf({ format }, v)]).toEqual([v, [`$ must be a valid ${format}`]]);
    });
  }

  it('passes unknown formats and lists unchecked keywords', () => {
    const r = check({ format: 'phone', contentMediaType: 'application/json', properties: { a: { format: 'email' } } }, 'not a phone');
    expect(r.valid).toBe(true);
    expect(r.unsupported).toEqual(['contentMediaType', 'format "phone"']);
    const off = check({ format: 'email' }, 'nope', { formats: false });
    expect(off.valid).toBe(true);
    expect(off.unsupported).toEqual(['format']);
    expect(ok({ format: 'email' }, 42)).toBe(true);
  });
});

describe('validateTree: errors and documents', () => {
  const schema = {
    type: 'object',
    properties: { users: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, email: { format: 'email' } } } } },
  };

  it('pins errors to the failing nodes of a JSON document', () => {
    const text = '{\n  "users": [\n    {"id": 1, "email": "ada@example.com"},\n    {"id": "2", "email": "nope"},\n    {"email": "x@example.com"}\n  ]\n}';
    const tree = parseData(text, 'json');
    const r = validateTree(tree, schema);
    expect(lines(r)).toEqual(['$.users[1].id must be integer', '$.users[1].email must be a valid email', '$.users[2] missing required property "id"']);
    for (const e of r.errors) expect(tree.pathString(e.id)).toBe(e.path);
    expect(r.errors.map((e) => tree.lineCol(tree.start(e.id)).line)).toEqual([3, 3, 4]);
    expect(r.errors[1]).toMatchObject({ keyword: 'format', schemaPath: '#/properties/users/items/properties/email/format' });
    expect(r.errors.map((e) => e.id)).toEqual([...r.errors.map((e) => e.id)].sort((a, b) => a - b));
  });

  it('pins errors in YAML, TOML and CSV documents', () => {
    const yaml = [
      '# yaml-language-server: $schema=https://example.com/app.schema.json',
      'name: demo',
      'replicas: two',
      'servers:',
      '  - host: example.com',
      '    port: 80',
      '  - host: -bad-',
      '    port: 70000',
      '',
    ].join('\n');
    const appSchema = {
      type: 'object',
      required: ['name', 'image'],
      properties: {
        name: { type: 'string' },
        replicas: { type: 'integer' },
        servers: { type: 'array', items: { type: 'object', required: ['host'], properties: { host: { format: 'hostname' }, port: { type: 'integer', maximum: 65535 } } } },
      },
    };
    const tree = parseData(yaml, 'yaml');
    const r = validateTree(tree, appSchema);
    expect(lines(r)).toEqual([
      '$ missing required property "image"',
      '$.replicas must be integer',
      '$.servers[1].host must be a valid hostname',
      '$.servers[1].port must be ≤ 65535',
    ]);
    for (const e of r.errors) expect(tree.pathString(e.id)).toBe(e.path);
    expect(r.errors.slice(1).map((e) => tree.lineCol(tree.start(e.id)).line + 1)).toEqual([3, 7, 8]);

    const toml = parseData('title = "x"\n\n[server]\nport = "80"\n', 'toml');
    const t = validateTree(toml, { properties: { server: { properties: { port: { type: 'integer' } } } } });
    expect(lines(t)).toEqual(['$.server.port must be integer']);
    expect(toml.pathString(t.errors[0].id)).toBe('$.server.port');

    const csv = parseData('name,age\nAda,36\nBob,abc\n', 'csv');
    const c = validateTree(csv, { type: 'array', items: { properties: { age: { type: 'integer' } } } });
    expect(lines(c)).toEqual(['$[1].age must be integer']);
    expect(csv.stringValue(c.errors[0].id)).toBe('abc');
  });

  it('validates YAML aliases as the values they stand for', () => {
    const yaml = 'defaults: &d\n  retries: 3\njob:\n  settings: *d\n';
    const schema = { properties: { job: { properties: { settings: { type: 'object', properties: { retries: { type: 'integer' } } } } } } };
    expect(validateTree(parseData(yaml, 'yaml'), schema).valid).toBe(true);
  });

  it('checks multi-document YAML and JSON Lines per document', () => {
    const schema = { properties: { name: { type: 'string' } } };
    expect(lines(validateTree(parseData('name: a\n---\nname: 5\n', 'yaml'), schema))).toEqual(['$[1].name must be string']);
    const jsonl = parseData('{"name":"a"}\n{"name":1}\n', 'jsonl');
    expect(lines(validateTree(jsonl, schema))).toEqual(['$[1].name must be string']);
    // A schema for the whole stream sees the array of documents.
    expect(lines(validateTree(jsonl, { type: 'array', maxItems: 1 }))).toEqual(['$ must have at most 1 item']);
    // An empty YAML document has nothing to check.
    expect(validateTree(parseData('# just a comment\n', 'yaml'), { type: 'object' }).valid).toBe(true);
  });

  it('validates a subtree with rootId', () => {
    const tree = doc({ a: { b: 'x' } });
    const a = tree.firstChild(tree.root);
    expect(lines(validateTree(tree, { properties: { b: { type: 'number' } } }, { rootId: a }))).toEqual(['$.a.b must be number']);
  });

  it('stops at maxErrors and sets truncated', () => {
    const data = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const r = check({ items: { type: 'number' } }, data, { maxErrors: 3 });
    expect(r.errors.map((e) => e.path)).toEqual(['$[0]', '$[1]', '$[2]']);
    expect(r.truncated).toBe(true);
    const all = check({ items: { type: 'number' } }, data, { maxErrors: 10 });
    expect(all.errors).toHaveLength(10);
    expect(all.truncated).toBe(false);
  });

  it('survives documents nested deeper than the stack', () => {
    const depth = 20_000;
    const tree = parseData('['.repeat(depth) + ']'.repeat(depth), 'json');
    const r = validateTree(tree, { type: 'array', items: { $ref: '#' } });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ keyword: 'depth', message: 'too deeply nested to validate' });
  });

  it('validates 100k records quickly', () => {
    const roles = ['admin', 'editor', 'viewer'];
    const rows = Array.from({ length: 100_000 }, (_, i) => ({
      id: i + 1,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      age: 18 + (i % 60),
      role: roles[i % 3],
      active: i % 2 === 0,
      tags: ['a', 'b'],
      created: '2024-01-02T03:04:05Z',
    }));
    rows[99_999].age = -1;
    const tree = parseData(JSON.stringify(rows), 'json');
    const user = {
      type: 'object',
      required: ['id', 'name', 'email', 'role'],
      additionalProperties: false,
      properties: {
        id: { type: 'integer', minimum: 1 },
        name: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        role: { enum: roles },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        created: { type: 'string', format: 'date-time' },
      },
    };
    const started = performance.now();
    const r = validateTree(tree, { $schema: DRAFT2020, type: 'array', items: { $ref: '#/$defs/user' }, $defs: { user } });
    const ms = performance.now() - started;
    expect(lines(r)).toEqual(['$[99999].age must be ≥ 0']);
    expect(ms).toBeLessThan(3000);
  });
});

describe('schemaUriOf', () => {
  it('reads $schema, the YAML modeline and the TOML directive', () => {
    expect(schemaUriOf(parseData('{"$schema": "https://example.com/s.json", "a": 1}', 'json'))).toBe('https://example.com/s.json');
    expect(schemaUriOf(parseData('{"a": {"$schema": "nested.json"}}', 'json'))).toBeUndefined();
    expect(schemaUriOf(parseData('# yaml-language-server: $schema=./schemas/app.json\nname: x\n', 'yaml'))).toBe('./schemas/app.json');
    expect(schemaUriOf(parseData('$schema: https://example.com/y.json\nname: x\n', 'yaml'))).toBe('https://example.com/y.json');
    expect(schemaUriOf(parseData('#:schema ./cfg.schema.json\n[a]\nb = 1\n', 'toml'))).toBe('./cfg.schema.json');
    expect(schemaUriOf(parseData('name: x\n', 'yaml'))).toBeUndefined();
  });
});
