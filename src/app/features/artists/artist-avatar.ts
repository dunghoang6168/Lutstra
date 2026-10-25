import { Album, Artist } from '../../core/models';

export function artistAvatarCandidates(artist: Artist, albums: Album[]): string[] {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const artwork = artist.albumIds
    .map((id, index) => ({ album: byId.get(id), index }))
    .filter((item): item is { album: Album; index: number } => Boolean(item.album))
    .sort((left, right) => (right.album.year ?? -Infinity) - (left.album.year ?? -Infinity) || left.index - right.index)
    .map(({ album }) => album.artworkSmall ?? album.artwork)
    .find((value): value is string => Boolean(value));
  return [...new Set([artist.customAvatar, artist.onlineMetadata?.avatar, artwork].filter((value): value is string => Boolean(value)))];
}
