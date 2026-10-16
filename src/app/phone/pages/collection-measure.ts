import { Track } from '../../core/models';
import { formatCount } from '../../features/home/library-quality';
import { DurationPipe } from '../../shared/pipes/duration.pipe';

const duration = new DurationPipe();

/** "12 tracks · 48:10 · FLAC 24/96" for a detail page header. */
export function collectionMeasure(tracks: readonly Track[], format?: string | null): string {
  const total = tracks.reduce((sum, track) => sum + track.duration, 0);
  const parts = [`${formatCount.format(tracks.length)} ${tracks.length === 1 ? 'track' : 'tracks'}`, duration.transform(total)];
  if (format) parts.push(format);
  return parts.join(' · ');
}
