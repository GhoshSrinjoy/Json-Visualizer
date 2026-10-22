/** Formats a document can be saved as (dependency-free, so UI bundles can import it). */

export type ConvertTarget = 'yaml' | 'toml' | 'csv' | 'tsv' | 'xml' | 'jsonl';

export const CONVERT_TARGETS: { id: ConvertTarget; label: string; ext: string; mime: string }[] = [
  { id: 'yaml', label: 'YAML', ext: 'yaml', mime: 'application/yaml' },
  { id: 'toml', label: 'TOML', ext: 'toml', mime: 'application/toml' },
  { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv' },
  { id: 'tsv', label: 'TSV', ext: 'tsv', mime: 'text/tab-separated-values' },
  { id: 'xml', label: 'XML', ext: 'xml', mime: 'application/xml' },
  { id: 'jsonl', label: 'JSON Lines', ext: 'jsonl', mime: 'application/jsonl' },
];

export type TypeTarget = 'typescript' | 'zod' | 'python' | 'go' | 'rust' | 'csharp' | 'kotlin' | 'swift' | 'java';

/** Languages types can be generated for (see typegen.ts). */
export const TYPE_TARGETS: { id: TypeTarget; label: string; ext: string }[] = [
  { id: 'typescript', label: 'TypeScript', ext: 'ts' },
  { id: 'zod', label: 'Zod', ext: 'ts' },
  { id: 'python', label: 'Python (Pydantic)', ext: 'py' },
  { id: 'go', label: 'Go', ext: 'go' },
  { id: 'rust', label: 'Rust (serde)', ext: 'rs' },
  { id: 'csharp', label: 'C# (System.Text.Json)', ext: 'cs' },
  { id: 'kotlin', label: 'Kotlin (kotlinx.serialization)', ext: 'kt' },
  { id: 'swift', label: 'Swift (Codable)', ext: 'swift' },
  { id: 'java', label: 'Java (Jackson)', ext: 'java' },
];
