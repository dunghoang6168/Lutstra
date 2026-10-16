import type { FolderNode } from '../models/folder.model';

export function collectTrackIds(folder: FolderNode, recursive: boolean): string[] {
  if (!folder.isFolder) return [];
  const ids: string[] = [];
  for (const child of folder.children ?? []) {
    if (child.isFolder) {
      if (recursive) ids.push(...collectTrackIds(child, true));
    } else if (child.trackId) {
      ids.push(child.trackId);
    }
  }
  return [...new Set(ids)];
}

/** Region of each track: the top-level folder under its music root, or the root itself for files directly in it. */
export function trackRegions(roots: readonly FolderNode[]): Map<string, string> {
  const regions = new Map<string, string>();
  for (const root of roots) {
    for (const child of root.children ?? []) {
      const ids = child.isFolder ? collectTrackIds(child, true) : child.trackId ? [child.trackId] : [];
      for (const id of ids) regions.set(id, child.isFolder ? child.name : root.name);
    }
  }
  return regions;
}
