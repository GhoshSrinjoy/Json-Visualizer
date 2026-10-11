/** Typed access to `structlens.*` settings. */

import * as vscode from 'vscode';
import { DEFAULT_EXCLUDES, type ScanOptions } from '../core/repo/scan';
import { DEFAULT_SETTINGS, type UiSettings } from '../shared/protocol';

const SECTION = 'structlens';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function uiSettings(): UiSettings {
  const c = cfg();
  return {
    direction: c.get<'LR' | 'TB'>('graph.direction', DEFAULT_SETTINGS.direction),
    initialDepth: c.get<number>('graph.initialDepth', DEFAULT_SETTINGS.initialDepth),
    maxVisibleNodes: c.get<number>('graph.maxVisibleNodes', DEFAULT_SETTINGS.maxVisibleNodes),
    childPageSize: c.get<number>('graph.childPageSize', DEFAULT_SETTINGS.childPageSize),
    theme: c.get<'auto' | 'dark' | 'light'>('theme', DEFAULT_SETTINGS.theme),
    animations: c.get<boolean>('animations', DEFAULT_SETTINGS.animations),
    minimap: c.get<boolean>('minimap', DEFAULT_SETTINGS.minimap),
    followCursor: c.get<boolean>('followCursor', DEFAULT_SETTINGS.followCursor),
  };
}

const SETTING_KEYS: Record<keyof UiSettings, string> = {
  direction: 'graph.direction',
  initialDepth: 'graph.initialDepth',
  maxVisibleNodes: 'graph.maxVisibleNodes',
  childPageSize: 'graph.childPageSize',
  theme: 'theme',
  animations: 'animations',
  minimap: 'minimap',
  followCursor: 'followCursor',
};

export async function saveUiSettings(patch: Partial<UiSettings>): Promise<void> {
  const c = cfg();
  for (const [k, v] of Object.entries(patch) as [keyof UiSettings, unknown][]) {
    const key = SETTING_KEYS[k];
    if (key) await c.update(key, v, vscode.ConfigurationTarget.Global);
  }
}

export function scanOptions(): ScanOptions {
  const c = cfg();
  return {
    respectGitignore: c.get<boolean>('repo.respectGitignore', true),
    exclude: c.get<string[]>('repo.exclude', DEFAULT_EXCLUDES),
    maxFiles: c.get<number>('repo.maxFiles', 200_000),
    countLines: c.get<boolean>('repo.countLines', true),
  };
}
