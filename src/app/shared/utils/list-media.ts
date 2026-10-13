import type { PlaylistEntry, Track } from '../../core/models';

/** First four distinct artworks, in playlist entry order. */
export function selectPlaylistArtwork(
  entries: readonly Pick<PlaylistEntry, 'trackId'>[],
  tracks: readonly Track[] | ReadonlyMap<string, Track>,
): string[] {
  const trackMap = 'get' in tracks ? tracks : new Map(tracks.map((track) => [track.id, track]));
  const artworks = new Set<string>();
  for (const entry of entries) {
    const artwork = trackMap.get(entry.trackId)?.artwork?.trim();
    if (artwork) artworks.add(artwork);
    if (artworks.size === 4) break;
  }
  return [...artworks];
}

/** Splits track ids by whether the playlist already holds them; repeated ids keep their verdict. */
export function splitDuplicates(entries: readonly Pick<PlaylistEntry, 'trackId'>[], trackIds: readonly string[]) {
  const existing = new Set(entries.map((entry) => entry.trackId));
  return {
    duplicates: trackIds.filter((id) => existing.has(id)),
    fresh: trackIds.filter((id) => !existing.has(id)),
  };
}
