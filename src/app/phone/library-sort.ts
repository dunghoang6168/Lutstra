import { Album, Artist, Track } from '../core/models';

/** Rows the Library renders at first and adds each time its end nears the screen. */
export const LIBRARY_PAGE = 100;

export const LIBRARY_TABS = ['songs', 'albums', 'artists', 'playlists', 'folders'] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

export const SONG_SORTS = { title: 'Title', artist: 'Artist', album: 'Album', added: 'Recently added' } as const;
export const ALBUM_SORTS = { title: 'Title', artist: 'Artist', year: 'Year' } as const;
export const ARTIST_SORTS = { name: 'Name', tracks: 'Most tracks' } as const;
export type SongSort = keyof typeof SONG_SORTS;
export type AlbumSort = keyof typeof ALBUM_SORTS;
export type ArtistSort = keyof typeof ARTIST_SORTS;

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function isLibraryTab(value: unknown): value is LibraryTab {
  return LIBRARY_TABS.includes(value as LibraryTab);
}

/** Ties fall back to the title, so every order is stable across rescans. */
export function sortTracks(tracks: readonly Track[], by: SongSort): Track[] {
  const key = (track: Track): string => by === 'artist' ? track.artist ?? '' : by === 'album' ? track.album ?? '' : track.title;
  return [...tracks].sort((a, b) => by === 'added'
    ? (b.lastModified ?? 0) - (a.lastModified ?? 0) || text.compare(a.title, b.title)
    : text.compare(key(a), key(b)) || text.compare(a.title, b.title));
}

export function sortAlbums(albums: readonly Album[], by: AlbumSort): Album[] {
  return [...albums].sort((a, b) => by === 'year'
    ? (b.year ?? 0) - (a.year ?? 0) || text.compare(a.title, b.title)
    : text.compare(by === 'artist' ? a.artist ?? '' : a.title, by === 'artist' ? b.artist ?? '' : b.title) || text.compare(a.title, b.title));
}

export function sortArtists(artists: readonly Artist[], by: ArtistSort): Artist[] {
  return [...artists].sort((a, b) => (by === 'tracks' ? b.trackIds.length - a.trackIds.length : 0) || text.compare(a.name, b.name));
}
