/**
 * Runs commands found on PATH without a shell reinterpreting their arguments.
 * PATH lookup skips relative entries, so a command is never picked up from the
 * current (possibly untrusted) folder. Windows `.cmd`/`.bat` shims (npm
 * installs `claude`, `code`… that way) can only run through cmd.exe; their
 * arguments are escaped as described in https://qntm.org/cmd.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export function which(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  const win = process.platform === 'win32';
  const exts = win && !extname(command) ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = join(dir, command + ext);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a cmd.exe command line: CRT-quoted, then every cmd metacharacter ^-escaped. */
export function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

interface Resolved {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function resolveCommand(command: string, args: string[]): Resolved | undefined {
  const file = which(command);
  if (!file) return undefined;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file, args, windowsVerbatimArguments: false };
}

export function runSync(command: string, args: string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string> | undefined {
  const r = resolveCommand(command, args);
  if (!r) return undefined;
  return spawnSync(r.file, r.args, { encoding: 'utf8', ...options, windowsVerbatimArguments: r.windowsVerbatimArguments }) as SpawnSyncReturns<string>;
}

export function runDetached(command: string, args: string[], options: SpawnOptions = {}): ChildProcess | undefined {
  const r = resolveCommand(command, args);
  if (!r) return undefined;
  const child = spawn(r.file, r.args, { stdio: 'ignore', detached: true, ...options, windowsVerbatimArguments: r.windowsVerbatimArguments });
  child.on('error', () => undefined);
  child.unref();
  return child;
}
