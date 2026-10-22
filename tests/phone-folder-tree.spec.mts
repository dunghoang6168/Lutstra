import { describe, expect, it } from 'vitest';
import { findNode, folderTrail, rootOf, trackIdsBelow } from '../src/app/phone/folder-tree';
import type { FolderNode } from '../src/app/core/models';

const roots = [
  { id: 'sd', name: 'Music', path: '/storage/SD/Music' },
  { id: 'dl', name: 'Download', path: '/storage/emulated/0/Download' },
];

const tree = {
  id: 'sd', name: 'Music', isFolder: true, children: [
    { id: 'sd/US-UK', name: 'US-UK', isFolder: true, children: [
      { id: 'sd/US-UK/JVKE', name: 'JVKE', isFolder: true, children: [{ id: 't3', name: 'c.flac', isFolder: false, trackId: 't3' }] },
      { id: 't2', name: 'b.flac', isFolder: false, trackId: 't2' },
    ] },
    { id: 't1', name: 'a.flac', isFolder: false, trackId: 't1' },
  ],
} as unknown as FolderNode;

describe('folder tree', () => {
  it('finds the root a folder id belongs to, and not a lookalike prefix', () => {
    expect(rootOf(roots, 'sd/US-UK')?.name).toBe('Music');
    expect(rootOf(roots, 'sdcard/x')).toBeNull();
    expect(rootOf(roots, null)).toBeNull();
  });

  it('walks down to a nested folder and gathers every track below it', () => {
    expect(findNode(tree, 'sd/US-UK/JVKE')?.name).toBe('JVKE');
    expect(trackIdsBelow(findNode(tree, 'sd/US-UK'))).toEqual(['t3', 't2']);
  });

  it('builds the path from the list of music folders down', () => {
    expect(folderTrail(roots[0], 'sd/US-UK/JVKE', 'Music folders')).toEqual([
      { id: null, label: 'Music folders' },
      { id: 'sd', label: 'Music' },
      { id: 'sd/US-UK', label: 'US-UK' },
      { id: 'sd/US-UK/JVKE', label: 'JVKE' },
    ]);
    expect(folderTrail(null, null, 'Music folders')).toEqual([{ id: null, label: 'Music folders' }]);
  });
});
