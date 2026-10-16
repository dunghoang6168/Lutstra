import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';

const scans: Array<(tracks: unknown[]) => void> = [];
const saved: { lastScan: object } = { lastScan: {} };
vi.mock('../src/app/core/android/android-folder-selection', async original => ({
  ...(await original<typeof import('../src/app/core/android/android-folder-selection')>()),
  androidFolders: {
    listTree: async () => ({ folders: [], grants: [] }),
    getSelection: async () => ({ rules: [] }),
    scan: () => new Promise(resolve => scans.push(tracks => resolve({ tracks, folders: [], grants: [] }))),
    getLastScan: async () => saved.lastScan,
    addListener: async () => ({ remove: async () => undefined }),
  },
}));

const { AndroidLibraryGateway } = await import('../src/app/core/android/android-library.gateway');
const row = (id: string) => ({ id, uri: id, fileName: `${id}.flac`, title: id, artist: null, album: null,
  durationMs: null, mimeType: null, fileSize: null, lastModified: null, trackNumber: null, year: null, relativePath: null });
const settle = () => new Promise(resolve => setTimeout(resolve));

describe('Android library scan queue', () => {
  it('keeps a scan requested mid-scan and lets early readers wait for the first result', async () => {
    const gateway = new AndroidLibraryGateway();
    const firstRead = gateway.getLibrary();
    const secondRead = gateway.getLibrary();
    await settle();
    expect(scans).toHaveLength(1);

    const saved = gateway.requestScan();
    scans[0]([row('a')]);
    await settle();
    // The selection changed during the first pass, so a second pass runs before the request resolves.
    expect(scans).toHaveLength(2);
    expect((await firstRead).tracks.map(track => track.id)).toEqual(['a']);
    expect((await secondRead).tracks).toHaveLength(1);

    scans[1]([row('a'), row('b')]);
    await saved;
    expect((await gateway.getLibrary()).tracks).toHaveLength(2);
    expect(scans).toHaveLength(2);
  });

  it('shows the saved scan at once, rescans in the background, and stays quiet when nothing changed', async () => {
    scans.length = 0;
    saved.lastScan = { tracks: [row('a')], folders: [], grants: [] };
    const gateway = new AndroidLibraryGateway();
    let changes = 0;
    gateway.libraryChanged$.subscribe(() => changes++);
    expect((await gateway.getLibrary()).tracks.map(track => track.id)).toEqual(['a']);
    await settle();
    expect(scans).toHaveLength(1);
    scans[0]([row('a')]);
    await settle();
    expect(changes).toBe(0);

    void gateway.requestScan();
    await settle();
    scans[1]([row('a'), row('b')]);
    await settle();
    expect(changes).toBe(1);
    expect((await gateway.getLibrary()).tracks).toHaveLength(2);
    saved.lastScan = {};
  });
});
