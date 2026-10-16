import { Track } from './track.model';

export interface QueueEntry {
  id: string; // Unique entry ID so identical tracks can be in the queue independently
  track: Track;
  originalIndex: number;
  /** Added by Smart Shuffle, not by the user. */
  suggested?: boolean;
  /** Placed by the user (Play next, a drag); Smart Shuffle leaves it where it is. */
  pinned?: boolean;
}

/** The queue and position kept across restarts (`session:get` / `session:save`). */
export interface PlaybackSession {
  version: 1 | 2;
  trackIds: string[];
  /** The order before shuffle, as indices into `trackIds`. */
  originalOrder: number[];
  currentIndex: number;
  positionSeconds: number;
  /** Version 2: indices into `trackIds` of the entries Smart Shuffle added. */
  suggested?: number[];
}
