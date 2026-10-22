import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseData } from '../../src/core/data/formats';
import { inferSchema, newSchema, type SchemaNode } from '../../src/core/data/schema';
import { generateTypes, TYPE_TARGETS, type TypeTarget } from '../../src/core/data/typegen';

const USERS = readFileSync(join(__dirname, '..', 'fixtures', 'data', 'users.json'), 'utf8');
const MIXED = JSON.stringify([
  { id: 1, name: 'a', email: null, score: 1, value: 1, nothing: null, nested: { p: 1 }, tags: [] },
  { id: 2, email: 'b@x.io', score: 2.5, value: 'two', nothing: null, nested: null, tags: ['t'] },
]);
const MAPS = JSON.stringify({
  byId: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(1000 + i), { score: i * 1.5, label: `L${i}` }])),
  daily: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`2024-01-${String(i + 1).padStart(2, '0')}`, i])),
});
const ODD = '{"first name": "Ada", "123": 1, "class": "c", "type": "t", "$ref": "#/x", "a-b": true, "_id": "x", "id": 7, "self": {"href": "/me"}, "userID": 3}';
const NESTED = '{"matrix": [[1, 2], [3, 4]], "groups": [[{"id": 1}]], "cube": [[[0.5]]], "sparse": [1, null]}';
const ROOT_ARRAY = '[{"id": 1, "name": "a"}, {"id": 2}]';
const EMPTY = '{"list": [], "obj": {}}';
const DEDUP =
  '{"billingAddress": {"street": "a", "city": "b"}, "shippingAddress": {"street": "c", "city": "d"}, "owner": {"name": "x", "home": {"city": "e", "street": "f"}}}';
const COLLIDE =
  '{"user": {"name": "a"}, "admin": {"user": {"id": 1}}, "item": {"x": 1}, "items": [{"y": 2}], "list": {"z": true}, ' +
  '"children": [{"name": "c", "children": [{"name": "d", "children": [{"leaf": true}]}]}]}';
const PLURALS =
  '{"users": [{"a": 1}], "people": [{"b": 1}], "categories": [{"c": 1}], "addresses": [{"d": 1}], "statuses": [{"e": 1}], ' +
  '"data": [{"f": 1}], "movies": [{"g": 1}], "imageURLs": [{"h": 1}], "matches": [{"i": 1}], "leaves": [{"j": 1}]}';
const NUMS = '{"small": 1, "big": 3000000000, "huge": 9007199254740993, "max": 18446744073709551615, "neg": -9223372036854775808, "ratio": 0.5}';
const deepJson = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

/** Every sample the generated code must accept. */
const SAMPLES: Record<string, string> = {
  users: USERS,
  mixed: MIXED,
  maps: MAPS,
  odd: ODD,
  nested: NESTED,
  rootArray: ROOT_ARRAY,
  string: '"hello"',
  number: '42',
  null: 'null',
  boolean: 'true',
  emptyObject: '{}',
  emptyArray: '[]',
  empty: EMPTY,
  dedup: DEDUP,
  collide: COLLIDE,
  plurals: PLURALS,
  nums: NUMS,
  deep: deepJson(80),
};

const gen = (json: string, target: TypeTarget, rootName?: string) => generateTypes(inferSchema(parseData(json, 'json')), target, { rootName });
const all = (json: string) => Object.fromEntries(TYPE_TARGETS.map((t) => [t.id, gen(json, t.id)])) as Record<TypeTarget, string>;

/** Names of the types each target's output declares. */
const DECLARED: Record<TypeTarget, RegExp> = {
  typescript: /^export (?:interface|type) (\w+)/gm,
  zod: /^export const (\w+)Schema /gm,
  python: /^class (\w+)\(/gm,
  go: /^type (\w+) /gm,
  rust: /^pub (?:struct|type) (\w+)/gm,
  csharp: /^(?:public class|using) (\w+)(?: :| =|$)/gm,
  kotlin: /^(?:data class|typealias) (\w+)/gm,
  swift: /^(?:struct|typealias|enum) (\w+)/gm,
  java: /^(?:public )?class (\w+)/gm,
};
const declared = (code: string, target: TypeTarget) => [...code.matchAll(DECLARED[target])].map((m) => m[1]);

describe('generateTypes', () => {
  it('lists every target once', () => {
    expect(TYPE_TARGETS.map((t) => t.id).sort()).toEqual(['csharp', 'go', 'java', 'kotlin', 'python', 'rust', 'swift', 'typescript', 'zod']);
    expect(TYPE_TARGETS.find((t) => t.id === 'python')).toEqual({ id: 'python', label: 'Python (Pydantic)', ext: 'py' });
  });

  it('generates users.json for every target', () => {
    const out = all(USERS);
    expect(out.typescript).toContain('export interface Root {\n  service: string;');
    expect(out.typescript).toContain('  users: User[];\n}');
    expect(out.typescript).toContain('  email: string | null;');
    expect(out.typescript).toContain('  roles: Array<"admin" | "editor" | "viewer">;');
    expect(out.typescript).toContain('  city: "London" | "Paris" | "Tokyo" | "Berlin";');
    expect(out.typescript).toContain('  joined: string;'); // repeated date-times are not an enum
    expect(out.typescript).toContain('  beta: unknown;'); // only null was seen
    expect(declared(out.typescript, 'typescript')).toEqual(['Root', 'Settings', 'Pagination', 'Features', 'User', 'Profile']);

    expect(out.zod).toMatch(/^import \{ z \} from "zod";/);
    expect(out.zod).toContain('  id: z.number().int(),\n  name: z.string(),\n  email: z.string().nullable(),');
    expect(out.zod).toContain('  roles: z.array(z.enum(["admin", "editor", "viewer"])),');
    expect(out.zod).toContain('  score: z.number(),');
    expect(out.zod).toContain('export type User = z.infer<typeof UserSchema>;');
    expect(declared(out.zod, 'zod')).toEqual(['Pagination', 'Features', 'Settings', 'Profile', 'User', 'Root']);

    expect(out.python).toMatch(/^from typing import Any, Literal, Optional\n\nfrom pydantic import BaseModel\n\n\nclass Pagination\(BaseModel\):/);
    expect(out.python).toContain('    email: Optional[str]\n');
    expect(out.python).toContain('    roles: list[Literal["admin", "editor", "viewer"]]\n');
    expect(out.python).toContain('    score: float\n');
    expect(out.python).toContain('    beta: Any\n');
    expect(out.python).toContain('    users: list[User]\n');
    expect(declared(out.python, 'python')).toEqual(['Pagination', 'Features', 'Settings', 'Profile', 'User', 'Root']);

    expect(out.go).toMatch(/^package model\n\ntype Root struct \{/);
    expect(out.go).toContain('\tID      int64    `json:"id"`\n\tName    string   `json:"name"`\n\tEmail   *string  `json:"email"`');
    expect(out.go).toMatch(/\tUsers +\[\]User +`json:"users"`/);
    expect(out.go).toMatch(/\tBeta +any +`json:"beta"`/);
    expect(out.go).not.toContain('import');

    expect(out.rust).toMatch(/^use serde::\{Deserialize, Serialize\};\n\n#\[derive\(Debug, Clone, PartialEq, Serialize, Deserialize\)\]\npub struct Root \{/);
    expect(out.rust).toContain('    pub email: Option<String>,');
    expect(out.rust).toContain('    pub users: Vec<User>,');
    expect(out.rust).toContain('    pub beta: serde_json::Value,');
    expect(out.rust).not.toContain('HashMap');

    expect(out.csharp).toMatch(/^#nullable enable\nusing System\.Collections\.Generic;\nusing System\.Text\.Json;\nusing System\.Text\.Json\.Serialization;\n/);
    expect(out.csharp).toContain('    [JsonPropertyName("email")]\n    public string? Email { get; set; }');
    expect(out.csharp).toContain('    [JsonPropertyName("users")]\n    public List<User> Users { get; set; } = new();');
    expect(out.csharp).toContain('    public int Id { get; set; }');
    expect(out.csharp).toContain('    public JsonElement? Beta { get; set; }');

    expect(out.kotlin).toMatch(/^import kotlinx\.serialization\.\*\nimport kotlinx\.serialization\.json\.JsonElement\n\n@Serializable\ndata class Root\(/);
    expect(out.kotlin).toContain('    val email: String?,');
    expect(out.kotlin).toContain('    val users: List<User>,');
    expect(out.kotlin).toContain('    val beta: JsonElement?,');

    expect(out.swift).toContain('struct User: Codable {\n    let id: Int\n    let name: String\n    let email: String?');
    expect(out.swift).toContain('    let beta: JSONValue?');
    expect(out.swift).toContain('enum JSONValue: Codable');

    expect(out.java).toMatch(/^import com\.fasterxml\.jackson\.databind\.JsonNode;\nimport java\.util\.List;\n\npublic class Root \{/);
    expect(out.java).toContain('class User {\n    public int id;\n    public String name;\n    public String email;\n    public boolean active;');
    expect(out.java).toContain('    public double score;');
    expect(out.java).toContain('    public JsonNode beta;');
  });

  it('keeps optional, nullable and mixed fields apart', () => {
    const out = all(MIXED);
    expect(out.typescript).toContain('export type Root = RootItem[];');
    expect(out.typescript).toContain('  name?: string;\n  email: string | null;\n  score: number;\n  value: unknown;\n  nothing: unknown;\n  nested: Nested | null;');
    expect(out.zod).toContain('  name: z.string().optional(),\n  email: z.string().nullable(),\n  score: z.number(),\n  value: z.unknown(),');
    expect(out.zod).toContain('  nested: NestedSchema.nullable(),');
    expect(out.python).toContain('    name: Optional[str] = None\n    email: Optional[str]\n    score: float\n    value: Any\n    nothing: Any\n    nested: Optional[Nested]\n');
    expect(out.go).toMatch(/\tName +\*string +`json:"name,omitempty"`\n\tEmail +\*string +`json:"email"`/);
    expect(out.go).toMatch(/\tValue +any +`json:"value"`/);
    expect(out.go).toMatch(/\tNested +\*Nested +`json:"nested"`/);
    expect(out.rust).toContain('    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub name: Option<String>,\n    pub email: Option<String>,');
    expect(out.rust).toContain('    pub value: serde_json::Value,');
    expect(out.rust).toContain('    pub nested: Option<Nested>,');
    expect(out.csharp).toContain('    public string? Name { get; set; }');
    expect(out.csharp).toContain('    public JsonElement Value { get; set; }');
    expect(out.csharp).toContain('    public JsonElement? Nothing { get; set; }');
    expect(out.csharp).toContain('    public Nested? Nested { get; set; }');
    expect(out.kotlin).toContain('    val name: String? = null,\n    val email: String?,\n    val score: Double,\n    val value: JsonElement,');
    expect(out.swift).toContain('    let name: String?\n    let email: String?\n    let score: Double\n    let value: JSONValue');
    expect(out.java).toContain('    public int id;\n    public String name;\n    public String email;\n    public double score;\n    public JsonNode value;');
  });

  it('types dynamic-key objects as maps', () => {
    const out = all(MAPS);
    expect(out.typescript).toContain('  byId: Record<string, ByIdValue>;\n  daily: Record<string, number>;');
    expect(out.typescript).toContain('export interface ByIdValue {\n  score: number;\n  label: string;\n}');
    expect(out.zod).toContain('  byId: z.record(z.string(), ByIdValueSchema),\n  daily: z.record(z.string(), z.number().int()),');
    expect(out.python).toContain('    by_id: dict[str, ByIdValue] = Field(alias="byId")\n    daily: dict[str, int]');
    expect(out.go).toMatch(/\tByID +map\[string\]ByIDValue +`json:"byId"`\n\tDaily +map\[string\]int64 +`json:"daily"`/);
    expect(out.rust).toContain('use std::collections::HashMap;');
    expect(out.rust).toContain('    #[serde(rename = "byId")]\n    pub by_id: HashMap<String, ByIdValue>,\n    pub daily: HashMap<String, i64>,');
    expect(out.csharp).toContain('    public Dictionary<string, ByIdValue> ById { get; set; } = new();');
    expect(out.kotlin).toContain('    val byId: Map<String, ByIdValue>,\n    val daily: Map<String, Int>,');
    expect(out.swift).toContain('    let byId: [String: ByIdValue]\n    let daily: [String: Int]');
    expect(out.java).toContain('    public Map<String, ByIdValue> byId;\n    public Map<String, Integer> daily;');
  });

  it('maps keys that are not identifiers back to the exact JSON key', () => {
    const out = all(ODD);
    expect(out.typescript).toContain('  "first name": string;\n  "123": number;\n  class: string;\n  type: string;\n  $ref: string;\n  "a-b": boolean;');
    expect(out.zod).toContain('  "first name": z.string(),\n  "123": z.number().int(),');
    expect(out.python).toContain('    model_config = ConfigDict(populate_by_name=True)\n');
    expect(out.python).toContain(
      '    first_name: str = Field(alias="first name")\n    n_123: int = Field(alias="123")\n    class_: str = Field(alias="class")\n' +
        '    type: str\n    ref: str = Field(alias="$ref")\n    a_b: bool = Field(alias="a-b")\n    id_2: str = Field(alias="_id")\n    id: int\n',
    );
    expect(out.python).toContain('    user_id: int = Field(alias="userID")');
    // Plain keys win the plain names: `id` is ID, `_id` is ID2.
    expect(out.go).toMatch(/\tFirstName +string +`json:"first name"`\n\tN123 +int64 +`json:"123"`\n\tClass +string +`json:"class"`/);
    expect(out.go).toMatch(/\tRef +string +`json:"\$ref"`\n\tAB +bool +`json:"a-b"`\n\tID2 +string +`json:"_id"`\n\tID +int64 +`json:"id"`/);
    expect(out.go).toMatch(/\tUserID +int64 +`json:"userID"`/);
    expect(out.rust).toContain('    #[serde(rename = "first name")]\n    pub first_name: String,\n    #[serde(rename = "123")]\n    pub n_123: i64,\n    pub class: String,\n    pub r#type: String,');
    expect(out.rust).toContain('    #[serde(rename = "$ref")]\n    pub r#ref: String,');
    expect(out.rust).toContain('    #[serde(rename = "self")]\n    pub self_: RootSelf,'); // `Self` is reserved
    expect(out.csharp).toContain('    [JsonPropertyName("first name")]\n    public string FirstName { get; set; } = "";');
    expect(out.csharp).toContain('    [JsonPropertyName("123")]\n    public int N123 { get; set; }');
    expect(out.csharp).toContain('    [JsonPropertyName("_id")]\n    public string Id2 { get; set; } = "";');
    expect(out.kotlin).toContain(
      '    @SerialName("first name") val firstName: String,\n    @SerialName("123") val n123: Int,\n    @SerialName("class") val clazz: String,\n' +
        '    val type: String,\n    @SerialName("\\$ref") val ref: String,',
    );
    expect(gen('{"object": 1, "when": 2}', 'kotlin')).toContain('    val `object`: Int,\n    val `when`: Int,');
    expect(gen('{"init": 1, "default": 2}', 'swift')).toContain('    let initValue: Int\n    let `default`: Int\n\n    enum CodingKeys: String, CodingKey {\n        case initValue = "init"\n        case `default`\n');
    expect(out.kotlin).toContain('    val userID: Int,');
    expect(out.swift).toContain('    let `class`: String\n');
    expect(out.swift).toContain('    let selfValue: RootSelf\n');
    expect(out.swift).toContain(
      '    enum CodingKeys: String, CodingKey {\n        case firstName = "first name"\n        case n123 = "123"\n        case `class`\n        case type\n        case ref = "$ref"\n',
    );
    expect(out.java).toContain('    @JsonProperty("first name")\n    public String firstName;\n    @JsonProperty("123")\n    public int n123;\n    @JsonProperty("class")\n    public String class_;\n    public String type;');
    expect(out.java).toContain('    public int userID;');
  });

  it('handles keys no tag or identifier can carry', () => {
    const json = '{"a,b": 1, "-": 2, "odd\\"q": 3, "名前": "n", "café": "c", "__proto__": "p"}';
    const out = all(json);
    expect(out.go).toMatch(/\tAB +int64 +`json:"-"` \/\/ encoding\/json cannot map the key "a,b"; decode it by hand\n\tField +int64 +`json:"-,"`\n\tOddQ +int64 +`json:"-"` +\/\//);
    expect(out.go).toMatch(/\tField2 +string +`json:"名前"`\n\tCafe +string +`json:"café"`/);
    expect(out.zod).toContain('  ["__proto__"]: z.string(),');
    expect(out.rust).toContain('    #[serde(rename = "odd\\"q")]\n    pub odd_q: i64,');
    expect(out.kotlin).toContain('    @SerialName("名前") val field2: String,');
  });

  it('nests arrays of arrays', () => {
    const out = all(NESTED);
    expect(out.typescript).toContain('  matrix: number[][];\n  groups: GroupItem[][];\n  cube: number[][][];\n  sparse: Array<number | null>;');
    expect(out.zod).toContain('  matrix: z.array(z.array(z.number().int())),');
    expect(out.zod).toContain('  sparse: z.array(z.number().int().nullable()),');
    expect(out.python).toContain('    matrix: list[list[int]]\n    groups: list[list[GroupItem]]\n    cube: list[list[list[float]]]\n    sparse: list[Optional[int]]');
    expect(out.go).toMatch(/\tMatrix +\[\]\[\]int64 +`json:"matrix"`\n\tGroups +\[\]\[\]GroupItem +`json:"groups"`\n\tCube +\[\]\[\]\[\]float64 +`json:"cube"`\n\tSparse +\[\]\*int64 +`json:"sparse"`/);
    expect(out.rust).toContain('    pub matrix: Vec<Vec<i64>>,\n    pub groups: Vec<Vec<GroupItem>>,\n    pub cube: Vec<Vec<Vec<f64>>>,\n    pub sparse: Vec<Option<i64>>,');
    expect(out.csharp).toContain('    public List<List<int>> Matrix { get; set; } = new();');
    expect(out.csharp).toContain('    public List<int?> Sparse { get; set; } = new();');
    expect(out.kotlin).toContain('    val matrix: List<List<Int>>,\n    val groups: List<List<GroupItem>>,\n    val cube: List<List<List<Double>>>,\n    val sparse: List<Int?>,');
    expect(out.swift).toContain('    let matrix: [[Int]]\n    let groups: [[GroupItem]]\n    let cube: [[[Double]]]\n    let sparse: [Int?]');
    expect(out.java).toContain('    public List<List<Integer>> matrix;\n    public List<List<GroupItem>> groups;\n    public List<List<List<Double>>> cube;\n    public List<Integer> sparse;');
  });

  it('aliases a root array or primitive', () => {
    const arr = all(ROOT_ARRAY);
    expect(arr.typescript).toMatch(/^export type Root = RootItem\[\];\n\nexport interface RootItem \{\n  id: number;\n  name\?: string;\n\}/);
    expect(arr.zod).toContain('export const RootSchema = z.array(RootItemSchema);\nexport type Root = z.infer<typeof RootSchema>;');
    expect(arr.python).toContain('class Root(RootModel[list[RootItem]]):\n    pass');
    expect(arr.python).toContain('from pydantic import BaseModel, RootModel');
    expect(arr.go).toContain('type Root []RootItem');
    expect(arr.rust).toContain('pub type Root = Vec<RootItem>;');
    expect(arr.csharp).toContain('public class Root : List<RootItem>\n{\n}');
    expect(arr.kotlin).toContain('typealias Root = List<RootItem>');
    expect(arr.swift).toContain('typealias Root = [RootItem]');
    expect(arr.swift).not.toContain('JSONValue');
    expect(arr.java).toContain('public class Root extends ArrayList<RootItem> {\n}');
    expect(arr.java).toContain('\nclass RootItem {');
    // The root name drives the item name.
    expect(gen(ROOT_ARRAY, 'typescript', 'users')).toContain('export type Users = User[];\n\nexport interface User {');

    const str = all('"hello"');
    expect(str.typescript).toBe('export type Root = string;\n');
    expect(str.zod).toContain('export const RootSchema = z.string();');
    expect(str.python).toBe('from pydantic import RootModel\n\n\nclass Root(RootModel[str]):\n    pass\n');
    expect(str.go).toBe('package model\n\ntype Root string\n');
    expect(str.rust).toBe('pub type Root = String;\n');
    expect(str.csharp).toBe('using Root = System.String;\n');
    expect(str.kotlin).toBe('typealias Root = String\n');
    expect(str.swift).toBe('typealias Root = String\n');
    expect(str.java).toContain('single String value');
    expect(all('42').csharp).toBe('using Root = System.Int32;\n');
    expect(all('42').go).toBe('package model\n\ntype Root int64\n');
    expect(all('null').typescript).toBe('export type Root = unknown;\n');
  });

  it('types empty arrays and objects dynamically', () => {
    const out = all(EMPTY);
    expect(out.typescript).toContain('  list: unknown[];\n  obj: Record<string, unknown>;');
    expect(out.zod).toContain('  list: z.array(z.unknown()),\n  obj: z.record(z.string(), z.unknown()),');
    expect(out.python).toContain('    list_: list[Any] = Field(alias="list")\n    obj: dict[str, Any]');
    expect(out.go).toMatch(/\tList +\[\]any +`json:"list"`\n\tObj +map\[string\]any +`json:"obj"`/);
    expect(out.rust).toContain('    pub list: Vec<serde_json::Value>,\n    pub obj: HashMap<String, serde_json::Value>,');
    expect(out.csharp).toContain('    public List<JsonElement> List { get; set; } = new();');
    expect(out.csharp).toContain('    public Dictionary<string, JsonElement> Obj { get; set; } = new();');
    expect(out.kotlin).toContain('    val list: List<JsonElement>,\n    val obj: Map<String, JsonElement>,');
    expect(out.kotlin).toContain('import kotlinx.serialization.json.JsonElement');
    expect(out.swift).toContain('    let list: [JSONValue]\n    let obj: [String: JSONValue]');
    expect(out.java).toContain('    public List<JsonNode> list;\n    public Map<String, JsonNode> obj;');
    expect(out.java).toContain('import java.util.Map;');
  });

  it('shares one type between identical shapes, named after their common words', () => {
    const out = all(DEDUP);
    expect(out.typescript).toContain('  billingAddress: Address;\n  shippingAddress: Address;');
    expect(out.typescript).toContain('  home: Address;');
    // Zod and Python declare dependencies first.
    const dependencyOrder: Partial<Record<TypeTarget, string[]>> = { zod: ['Address', 'Owner', 'Root'], python: ['Address', 'Owner', 'Root'] };
    for (const t of TYPE_TARGETS) expect(declared(out[t.id], t.id), t.id).toEqual(dependencyOrder[t.id] ?? ['Root', 'Address', 'Owner']);
  });

  it('keeps names unique', () => {
    const ts = gen(COLLIDE, 'typescript');
    expect(ts).toContain('  user: User;\n  admin: Admin;\n  item: Item;\n  items: RootItem[];\n  list: List;\n  children: Child[];');
    expect(ts).toContain('export interface Admin {\n  user: AdminUser;\n}');
    expect(ts).toContain('export interface Child {\n  name: string;\n  children: Child2[];\n}');
    expect(ts).toContain('export interface Child2 {\n  name: string;\n  children: Child3[];\n}');
    // `List` is taken by the language in Kotlin, Java and C#.
    expect(gen(COLLIDE, 'kotlin')).toContain('    val list: RootList,');
    expect(gen(COLLIDE, 'java')).toContain('    public RootList list;');
    expect(gen(COLLIDE, 'csharp')).toContain('    public RootList List { get; set; } = new();');
    for (const [name, json] of Object.entries(SAMPLES)) {
      for (const t of TYPE_TARGETS) {
        const names = declared(gen(json, t.id), t.id);
        expect(new Set(names).size, `${name} ${t.id}: ${names.join(', ')}`).toBe(names.length);
      }
    }
  });

  it('singularizes array item names', () => {
    const ts = gen(PLURALS, 'typescript');
    expect(ts).toContain(
      '  users: User[];\n  people: Person[];\n  categories: Category[];\n  addresses: Address[];\n  statuses: Status[];\n' +
        '  data: DataItem[];\n  movies: Movie[];\n  imageURLs: ImageURL[];\n  matches: Match[];\n  leaves: Leaf[];',
    );
  });

  it('sizes integers by their observed range', () => {
    const out = all(NUMS);
    expect(out.rust).toContain('    pub small: i64,\n    pub big: i64,\n    pub huge: i64,\n    pub max: u64,\n    pub neg: i64,\n    pub ratio: f64,');
    expect(out.go).toMatch(/\tSmall +int64 .*\n\tBig +int64 .*\n\tHuge +int64 .*\n\tMax +uint64 .*\n\tNeg +int64 .*\n\tRatio +float64 /);
    expect(out.csharp).toContain('    public int Small { get; set; }');
    expect(out.csharp).toContain('    public long Big { get; set; }');
    expect(out.csharp).toContain('    public ulong Max { get; set; }');
    expect(out.csharp).toContain('    public double Ratio { get; set; }');
    expect(out.kotlin).toContain('    val small: Int,\n    val big: Long,\n    val huge: Long,\n    val max: ULong,\n    val neg: Long,\n    val ratio: Double,');
    expect(out.java).toContain('    public int small;\n    public long big;\n    public long huge;\n    public BigInteger max;\n    public long neg;\n    public double ratio;');
    expect(out.java).toContain('import java.math.BigInteger;');
    expect(out.swift).toContain('    let small: Int\n    let big: Int\n    let huge: Int\n    let max: UInt64\n    let neg: Int\n    let ratio: Double');
    expect(out.python).toContain('    small: int\n    big: int\n    huge: int\n    max: int\n    neg: int\n    ratio: float');
    // Zod's .int() only accepts safe integers.
    expect(out.zod).toContain('  small: z.number().int(),\n  big: z.number().int(),\n  huge: z.number(),\n  max: z.number(),\n  neg: z.number(),\n  ratio: z.number(),');
  });

  it('caps deep nesting instead of overflowing the stack', () => {
    // 100,000 levels, built directly (parsers and inference have their own limits).
    const root = newSchema();
    let s: SchemaNode = root;
    for (let i = 0; i < 100_000; i++) {
      const child = newSchema();
      Object.assign(s, { count: 1, objects: 1, types: { object: 1 }, fields: new Map([['a', child]]) });
      s = child;
    }
    Object.assign(s, { count: 1, types: { number: 1 }, min: 1, max: 1 });
    for (const t of TYPE_TARGETS) expect(() => generateTypes(root, t.id)).not.toThrow();
    const ts = generateTypes(root, 'typescript');
    expect(ts.match(/^export interface/gm)).toHaveLength(64);
    expect(ts).toContain('  a: unknown;');
    // Through the parser and inference too.
    expect(gen(deepJson(3000), 'go')).toContain('package model');
  });

  it('accepts a schema node, other formats and a custom root name', () => {
    const result = inferSchema(parseData(USERS, 'json'));
    expect(generateTypes(result.root, 'rust')).toBe(generateTypes(result, 'rust'));
    expect(generateTypes(result, 'typescript', { rootName: 'user directory' })).toContain('export interface UserDirectory {');
    const yaml = generateTypes(inferSchema(parseData('users:\n  - name: Ada\n    age: 36\n  - name: Alan\n', 'yaml')), 'typescript');
    expect(yaml).toContain('export interface User {\n  name: string;\n  age?: number;\n}');
    for (const t of TYPE_TARGETS) expect(gen(USERS, t.id)).toBe(gen(USERS, t.id));
  });
});

// ---------------------------------------------------------------- validity

/** Type-checks in-memory files with the TypeScript compiler; they sit (virtually) in the repo so `zod` resolves. */
function typeCheck(files: Record<string, string>): string[] {
  const root = join(__dirname, '..', '..').replace(/\\/g, '/');
  const dir = `${root}/.typegen-check`;
  const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const config = {
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022'], types: [], skipLibCheck: true },
    files: Object.keys(files),
  };
  const vfs = new Map(Object.entries({ 'tsconfig.json': JSON.stringify(config), ...files }).map(([name, text]) => [key(`${dir}/${name}`), text]));
  const api = new API({
    cwd: root,
    fs: {
      readFile: (f) => vfs.get(key(f)),
      fileExists: (f) => (vfs.has(key(f)) ? true : undefined),
      directoryExists: (d) => (key(d) === key(dir) ? true : undefined),
      getAccessibleEntries: (d) => (key(d) === key(dir) ? { files: ['tsconfig.json', ...Object.keys(files)], directories: [] } : undefined),
    },
  });
  try {
    const project = api.updateSnapshot({ openProjects: [`${dir}/tsconfig.json`] }).getProject(`${dir}/tsconfig.json`);
    if (!project) return ['project not loaded'];
    const { program } = project;
    const diagnostics = [...program.getProgramDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
    return diagnostics.map((d) => `${d.fileName?.split('/').pop() ?? ''}@${d.pos}: ${d.text}`);
  } finally {
    api.close();
  }
}

/** Evaluates generated Zod source against the installed zod. */
function loadZod(code: string): z.ZodType {
  const body = code.replace(/^import .*\n/m, '').replace(/^export type .*\n/gm, '').replace(/^export const /gm, 'const ');
  return new Function('z', `${body}\nreturn RootSchema;`)(z) as z.ZodType;
}

describe('generated code accepts the data it came from', () => {
  it('TypeScript and Zod type-check against every sample (strict)', () => {
    const files: Record<string, string> = {};
    for (const [name, json] of Object.entries(SAMPLES)) {
      files[`${name}.ts`] = `${gen(json, 'typescript')}\nexport const data: Root = ${json};\n`;
      files[`${name}.zod.ts`] = `${gen(json, 'zod')}\nexport const data: Root = ${json};\n`;
    }
    expect(typeCheck(files)).toEqual([]);
    // The check itself catches mismatches.
    expect(typeCheck({ 'bad.ts': `${gen(ROOT_ARRAY, 'typescript')}\nexport const data: Root = [{ "id": "1" }];\n` })).toHaveLength(1);
  });

  it('Zod schemas parse every sample', () => {
    for (const [name, json] of Object.entries(SAMPLES)) {
      const data = JSON.parse(json) as unknown;
      expect(loadZod(gen(json, 'zod')).parse(data), name).toEqual(data);
    }
    expect(() => loadZod(gen(MIXED, 'zod')).parse([{ id: 1.5, email: null, score: 1, value: 1, nothing: null, nested: null, tags: [] }])).toThrow();
  });
});
