import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { MediaStoreTrack, libraryQueue, snapshotFrom } from '../src/app/core/android/android-library.gateway';
import { AndroidFolderNode, FolderGrant, folderCheckState, readablePath, selectedBranches, toggleFolder } from '../src/app/core/android/android-folder-selection';

const row = (id: string, changes: Partial<MediaStoreTrack> = {}): MediaStoreTrack => ({
  id, uri: id, fileName: null, title: null, artist: null, album: null,
  durationMs: null, mimeType: null, fileSize: null, lastModified: null,
  trackNumber: null, year: null, relativePath: null, ...changes,
});

describe('Android MediaStore snapshot', () => {
  it('gives tracks their scanned cover and albums the first cover among their tracks', () => {
    const { tracks, albums } = snapshotFrom([
      row('a', { fileName: 'a.flac', album: 'X', artist: 'Y' }),
      row('b', { fileName: 'b.flac', album: 'X', artist: 'Y', artwork: '/data/files/artwork/1.jpg' }),
    ]);
    expect(tracks[0].artwork).toBeNull();
    expect(tracks[1].artwork).toContain('artwork/1.jpg');
    expect(albums[0].artwork).toBe(tracks[1].artwork);
  });

  it('carries the scanned bitrate, sample rate and bit depth', () => {
    const [track] = snapshotFrom([row('a', { fileName: 'a.flac', bitrate: 2605000, sampleRate: 96000, bitDepth: 24 })]).tracks;
    expect([track.codec, track.bitrate, track.sampleRate, track.bitDepth]).toEqual(['FLAC', 2605000, 96000, 24]);
    const [older] = snapshotFrom([row('b', { fileName: 'b.mp3' })]).tracks;
    expect([older.bitrate, older.sampleRate, older.bitDepth]).toEqual([null, null, null]);
  });

  it('keeps URI identities stable, deduplicates a repeated scan row, and tolerates missing tags', () => {
    const id = 'content://media/external_primary/audio/media/42';
    const snapshot = snapshotFrom([row(id, { fileName: 'song.flac' }), row(id, { fileName: 'song.flac' })]);
    expect(snapshot.tracks.length).toBe(1);
    expect(snapshot.tracks[0].id).toBe(id);
    expect(snapshot.tracks[0].path).toBe(id);
    expect(snapshot.tracks[0].title).toBe('song');
    expect(snapshot.tracks[0].codec).toBe('FLAC');
    expect(snapshot.tracks[0].artist).toBeNull();
  });

  it('drops missing media when a fresh MediaStore result no longer includes it', () => {
    const first = snapshotFrom([row('content://media/external/audio/media/1'), row('content://media/external/audio/media/2')]);
    const rescanned = snapshotFrom([row('content://media/external/audio/media/2')]);
    expect(first.tracks.length).toBe(2);
    expect(rescanned.tracks.map(track => track.id)).toEqual(['content://media/external/audio/media/2']);
  });

  it('groups featured-artist tracks under the album artist', () => {
    const snapshot = snapshotFrom([
      row('a', { artist: 'RPT MCK', albumArtist: 'RPT MCK', album: '99%' }),
      row('b', { artist: 'Trung Trần', albumArtist: 'RPT MCK', album: '99%' }),
    ]);
    expect(snapshot.artists.map(artist => artist.name)).toEqual(['RPT MCK']);
    expect(snapshot.albums).toHaveLength(1);
    expect(snapshot.tracks[1].artist).toBe('Trung Trần');
  });

  it('queues the library album by album in track order', () => {
    const { tracks } = snapshotFrom([
      row('b2', { album: 'HVL', trackNumber: 2 }), row('a10', { album: '99%', trackNumber: 10 }),
      row('b1', { album: 'HVL', trackNumber: 1 }), row('a2', { album: '99%', trackNumber: 2 }),
    ]);
    expect(libraryQueue(tracks).map(track => track.id)).toEqual(['a2', 'a10', 'b1', 'b2']);
  });
});

describe('Android folder selection', () => {
  const auth = 'com.android.externalstorage.documents';
  const key = (documentId: string) => `${auth.length}:${auth}${documentId}`;
  const treeUri = `content://${auth}/tree/3066-6139%3AMusic`;
  const node = (documentId: string, parent: string | null): AndroidFolderNode => ({
    key: key(documentId), name: documentId.split('/').at(-1)!.replace(/^.*:/, ''),
    parentKey: parent && key(parent), treeUri, documentId, available: true,
  });
  const nodes = [
    node('3066-6139:Music', null), node('3066-6139:Music/VN', '3066-6139:Music'),
    node('3066-6139:Music/VN/MCK', '3066-6139:Music/VN'), node('3066-6139:Music/US-UK', '3066-6139:Music'),
  ];
  const grants: FolderGrant[] = [{ treeUri, key: key('3066-6139:Music'), volumeLabel: 'SanDisk SD card' }];

  it('names a branch by its volume and folders instead of the document URI', () => {
    expect(readablePath('3066-6139:Music/VN/MCK', grants)).toBe('SanDisk SD card/Music/VN/MCK');
    expect(readablePath('primary:Music', grants)).toBe('primary/Music');
    const rules = [{ key: key('3066-6139:Music/VN/MCK'), selected: true }];
    expect(selectedBranches(nodes, rules, grants)).toEqual([
      { id: key('3066-6139:Music/VN/MCK'), name: 'MCK', path: 'SanDisk SD card/Music/VN/MCK', addedAt: 0 },
    ]);
  });

  it('ticking a parent replaces the rules below it, and unticking a child leaves it out', () => {
    let rules = [{ key: key('3066-6139:Music/VN/MCK'), selected: true }];
    rules = toggleFolder(nodes, rules, key('3066-6139:Music'), true);
    expect(rules).toEqual([{ key: key('3066-6139:Music'), selected: true }]);
    rules = toggleFolder(nodes, rules, key('3066-6139:Music/VN/MCK'), false);
    expect(folderCheckState(nodes, rules, key('3066-6139:Music'))).toBe('mixed');
    expect(selectedBranches(nodes, rules).map(folder => folder.name)).toEqual(['Music']);
  });
});
