import { describe, expect, it } from 'vitest';
import { isLibraryTab, sortAlbums, sortArtists, sortTracks } from '../src/app/phone/library-sort';
import type { Album, Artist, Track } from '../src/app/core/models';

const track = (title: string, artist: string | null, album: string | null, lastModified: number) =>
  ({ id: title, title, artist, album, lastModified }) as Track;

describe('phone library sorting', () => {
  const tracks = [track('Ánh nắng', 'B', 'Z', 3), track('10 bài', 'A', 'Y', 1), track('2 bài', 'A', null, 2)];

  it('sorts tracks by title with Vietnamese accents and numbers, then by the other keys', () => {
    expect(sortTracks(tracks, 'title').map((t) => t.title)).toEqual(['2 bài', '10 bài', 'Ánh nắng']);
    expect(sortTracks(tracks, 'artist').map((t) => t.title)).toEqual(['2 bài', '10 bài', 'Ánh nắng']);
    expect(sortTracks(tracks, 'album').map((t) => t.title)).toEqual(['2 bài', '10 bài', 'Ánh nắng']);
    expect(sortTracks(tracks, 'added').map((t) => t.title)).toEqual(['Ánh nắng', '2 bài', '10 bài']);
  });

  it('sorts albums and artists', () => {
    const albums = [{ title: 'B', artist: 'X', year: 2020 }, { title: 'A', artist: 'Y', year: null }] as Album[];
    expect(sortAlbums(albums, 'title').map((a) => a.title)).toEqual(['A', 'B']);
    expect(sortAlbums(albums, 'artist').map((a) => a.title)).toEqual(['B', 'A']);
    expect(sortAlbums(albums, 'year').map((a) => a.title)).toEqual(['B', 'A']);
    const artists = [{ name: 'b', trackIds: ['1'] }, { name: 'A', trackIds: ['1', '2'] }, { name: 'c', trackIds: ['3', '4'] }] as Artist[];
    expect(sortArtists(artists, 'name').map((a) => a.name)).toEqual(['A', 'b', 'c']);
    expect(sortArtists(artists, 'tracks').map((a) => a.name)).toEqual(['A', 'c', 'b']);
  });

  it('accepts only the five tabs', () => {
    expect(isLibraryTab('folders')).toBe(true);
    expect(isLibraryTab('genres')).toBe(false);
  });
});
