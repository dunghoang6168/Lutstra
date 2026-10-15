import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { MediaStoreTrack, snapshotFrom } from '../src/app/core/android/android-library.gateway';

const row = (id: string, changes: Partial<MediaStoreTrack> = {}): MediaStoreTrack => ({
  id, uri: id, fileName: null, title: null, artist: null, album: null,
  durationMs: null, mimeType: null, fileSize: null, lastModified: null,
  trackNumber: null, year: null, relativePath: null, ...changes,
});

describe('Android MediaStore snapshot', () => {
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
});
