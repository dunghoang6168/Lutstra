import { FolderNode } from '../core/models';

/** A music folder the user chose (a scan root). */
export interface FolderRoot {
  id: string;
  name: string;
  path: string;
}

/** One step of the Folders path: null is the list of music folders. */
export interface FolderCrumb {
  id: string | null;
  label: string;
}

/** The scan root holding `id`; folder ids are the root's id plus the path below it. */
export function rootOf(roots: readonly FolderRoot[], id: string | null): FolderRoot | null {
  if (!id) return null;
  return roots.find((root) => id === root.id || id.startsWith(root.id + '/')) ?? null;
}

export function findNode(node: FolderNode | null, id: string): FolderNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    if (child.isFolder && (id === child.id || id.startsWith(child.id + '/'))) return findNode(child, id);
  }
  return null;
}

export function trackIdsBelow(node: FolderNode | null): string[] {
  if (!node) return [];
  return (node.children ?? []).flatMap((child) => child.isFolder ? trackIdsBelow(child) : child.trackId ? [child.trackId] : []);
}

/** The path from the list of music folders down to `id`. */
export function folderTrail(root: FolderRoot | null, id: string | null, top: string): FolderCrumb[] {
  const trail: FolderCrumb[] = [{ id: null, label: top }];
  if (!root || !id) return trail;
  trail.push({ id: root.id, label: root.name });
  let at = root.id;
  for (const part of id.slice(root.id.length).split('/').filter(Boolean)) {
    at = `${at}/${part}`;
    trail.push({ id: at, label: part });
  }
  return trail;
}
