import { describe, expect, it } from 'vitest';
import type { Track } from '../src/app/core/models';
import { selectPlaylistArtwork } from '../src/app/shared/utils/list-media';

const track = (id: string, artwork: string | null = null) => ({ id, artwork } as Track);
const entries = (tracks: readonly Track[]) => tracks.map(({ id }) => ({ trackId: id }));

describe('playlist artwork', () => {
  it.each([0, 1, 3, 4, 6])('selects up to four distinct artworks from %s images', (count) => {
    const tracks = Array.from({ length: count }, (_, i) => track(String(i), 'cover-' + i));
    expect(selectPlaylistArtwork(entries(tracks), tracks)).toEqual(tracks.slice(0, 4).map(t => t.artwork));
  });
  it('deduplicates artwork across tracks and repeated playlist entries', () => {
    const tracks = [track('a', 'cover-a'), track('b', 'cover-a'), track('c', 'cover-c')];
    expect(selectPlaylistArtwork([{ trackId: 'a' }, { trackId: 'a' }, ...entries(tracks)], tracks))
      .toEqual(['cover-a', 'cover-c']);
  });
  it('skips tracks with no artwork and tracks removed from the library', () => {
    const tracks = [track('a'), track('b', ''), track('c', 'cover-c')];
    expect(selectPlaylistArtwork([{ trackId: 'removed' }, ...entries(tracks)], tracks)).toEqual(['cover-c']);
  });
  it('uses playlist order with map input, without mutating inputs', () => {
    const tracks = Object.freeze([track('a', 'cover-a'), track('b', 'cover-b')]);
    const playlist = Object.freeze([{ trackId: 'b' }, { trackId: 'a' }]);
    expect(selectPlaylistArtwork(playlist, new Map(tracks.map(t => [t.id, t])))).toEqual(['cover-b', 'cover-a']);
    expect(tracks.map(t => t.id)).toEqual(['a', 'b']);
    expect(playlist.map(e => e.trackId)).toEqual(['b', 'a']);
  });
});
