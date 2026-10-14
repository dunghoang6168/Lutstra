import { Track } from './track.model';

export interface QueueEntry {
  id: string; // Unique entry ID so identical tracks can be in the queue independently
  track: Track;
  originalIndex: number;
}

/** The queue and position kept across restarts (`session:get` / `session:save`). */
export interface PlaybackSession {
  version: 1;
  trackIds: string[];
  /** The order before shuffle, as indices into `trackIds`. */
  originalOrder: number[];
  currentIndex: number;
  positionSeconds: number;
}
