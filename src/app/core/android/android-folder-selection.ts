import { registerPlugin } from '@capacitor/core';
import { MusicFolder } from '../models';

export interface AndroidFolderNode {
  key: string;
  name: string;
  parentKey: string | null;
  treeUri: string;
  documentId: string;
  available: boolean;
}

export interface FolderRule { key: string; selected: boolean }

interface NativeFolders {
  choose(): Promise<{ chosenUri: string; key: string }>;
  getSelection(): Promise<{ rules: FolderRule[] }>;
  saveSelection(options: { rules: FolderRule[] }): Promise<void>;
  listTree(): Promise<{ folders: AndroidFolderNode[] }>;
  scan(): Promise<{ tracks: import('./android-library.gateway').MediaStoreTrack[] }>;
}

export const androidFolders = registerPlugin<NativeFolders>('AndroidFolders');

export function childrenOf(nodes: AndroidFolderNode[], parentKey: string | null): AndroidFolderNode[] {
  const keys = new Set(nodes.map(node => node.key));
  return nodes.filter(node => (node.parentKey && keys.has(node.parentKey) ? node.parentKey : null) === parentKey)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function inheritedSelection(nodes: AndroidFolderNode[], rules: FolderRule[], key: string): boolean {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const ruleMap = new Map(rules.map(rule => [rule.key, rule.selected]));
  const visited = new Set<string>();
  let current: string | null = key;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (ruleMap.has(current)) return ruleMap.get(current)!;
    current = byKey.get(current)?.parentKey || null;
  }
  return false;
}

export function toggleFolder(nodes: AndroidFolderNode[], rules: FolderRule[], key: string, selected: boolean): FolderRule[] {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  if (!byKey.has(key)) return rules;
  const isDescendant = (candidate: string): boolean => {
    const seen = new Set<string>();
    let parent = byKey.get(candidate)?.parentKey;
    while (parent && !seen.has(parent)) {
      if (parent === key) return true;
      seen.add(parent);
      parent = byKey.get(parent)?.parentKey;
    }
    return false;
  };
  return [...rules.filter(rule => rule.key !== key && !isDescendant(rule.key)), { key, selected }];
}

export function folderCheckState(nodes: AndroidFolderNode[], rules: FolderRule[], key: string): 'checked' | 'mixed' | 'unchecked' {
  const active = inheritedSelection(nodes, rules, key);
  const children = childrenOf(nodes, key);
  const states = children.map(child => folderCheckState(nodes, rules, child.key));
  if (states.some(state => state === 'mixed' || (state === 'checked') !== active)) return 'mixed';
  return active ? 'checked' : 'unchecked';
}

export function selectedBranches(nodes: AndroidFolderNode[], rules: FolderRule[]): MusicFolder[] {
  const result: MusicFolder[] = [];
  const walk = (node: AndroidFolderNode, inherited: boolean): void => {
    const selected = rules.find(rule => rule.key === node.key)?.selected ?? inherited;
    if (selected && !inherited) {
      result.push({ id: node.key, name: node.name,
        path: `${node.treeUri}/document/${encodeURIComponent(node.documentId)}`, addedAt: 0 });
    }
    for (const child of childrenOf(nodes, node.key)) walk(child, selected);
  };
  for (const root of childrenOf(nodes, null)) walk(root, false);
  return result;
}
