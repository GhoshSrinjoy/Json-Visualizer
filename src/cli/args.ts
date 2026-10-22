/** Command-line parsing for the StructLens CLI. */

import { z, type ZodTypeAny } from 'zod';
import { TOOLS } from '../mcp/tools';

export interface Args {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const isBooleanSchema = (s: ZodTypeAny): boolean => (s instanceof z.ZodOptional ? isBooleanSchema(s.unwrap() as ZodTypeAny) : s instanceof z.ZodBoolean);

/** Flags that never take a value from the next argument (camelCase): `--dry-run codex` keeps `codex` positional. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'dryRun',
  'npx',
  'browser',
  ...TOOLS.flatMap((t) => Object.entries(t.inputSchema).filter(([, s]) => isBooleanSchema(s)).map(([k]) => k)),
]);

export const COMMANDS: ReadonlySet<string> = new Set(['open', 'mcp', 'setup', 'help', 'version', ...TOOLS.filter((t) => t.cli).map((t) => t.cli!.command)]);

/**
 * Parses `structlens [command] [positional…] [--flag value | --flag=value | --flag | --no-flag]…`.
 * Flag names are camelCased; repeated flags collect into arrays; `--` ends flag parsing.
 */
export function parseArgs(argv: string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS, commands: ReadonlySet<string> = COMMANDS): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const rawKey = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const key = camel(rawKey);
      let value: string | boolean;
      if (eq > 0) {
        value = a.slice(eq + 1);
        if (booleans.has(key) && (value === 'true' || value === 'false')) value = value === 'true';
      } else if (rawKey.startsWith('no-')) {
        out.flags[camel(rawKey.slice(3))] = false;
        continue;
      } else if (!booleans.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) value = argv[++i];
      else value = true;
      const prev = out.flags[key];
      out.flags[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, String(value)] : [String(prev), String(value)];
    } else if (a === '-h') out.flags.help = true;
    else if (a === '-v') out.flags.version = true;
    else if (!out.command && out.positional.length === 0 && !a.startsWith('-') && commands.has(a)) out.command = a;
    else out.positional.push(a);
  }
  return out;
}
