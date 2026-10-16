/** What the user asked the player to do just before the playing track changed. */
export type TransitionCause = 'next' | 'previous' | 'user';

export type ListenStart = TransitionCause | 'auto' | 'resume';
/**
 * `other`: the track left without a user transition before its end (a failure, the queue cleared).
 * `removed`: a Smart Shuffle suggestion taken out of the queue before it played (0 seconds).
 */
export type ListenEnd = 'ended' | 'skip_next' | 'skip_previous' | 'picked_other' | 'app_closed' | 'other' | 'removed';
export type ListenSource = 'queue' | 'roulette' | 'smart-shuffle';

export const LISTEN_STARTS: readonly ListenStart[] = ['user', 'auto', 'next', 'previous', 'resume'];
export const LISTEN_ENDS: readonly ListenEnd[] = ['ended', 'skip_next', 'skip_previous', 'picked_other', 'app_closed', 'other', 'removed'];
export const LISTEN_SOURCES: readonly ListenSource[] = ['queue', 'roulette', 'smart-shuffle'];

/** One finished listen. Kept for the listener analysis; the History page shows only the track and the time. */
export interface PlayEvent {
  trackId: string;
  /** ms */
  startedAt: number;
  /** Seconds actually played, seeks excluded. */
  playedSeconds: number;
  /** Furthest position reached, in seconds. */
  endPosition: number;
  duration: number;
  seekForwardSeconds: number;
  startedBy: ListenStart;
  endReason: ListenEnd;
  source: ListenSource;
}

export interface HistoryEntry {
  id: number;
  trackId: string;
  startedAt: number;
}

/** Newest first; `before` is the last entry of the previous page. */
export interface HistoryPageRequest {
  before?: { startedAt: number; id: number };
  limit: number;
}

export const HISTORY_PAGE_SIZE = 200;
/** The History page lists every listen except roulette rolls and removed suggestions, which stay in the log for the analysis. */
export function shownInHistory(event: Pick<PlayEvent, 'source' | 'endReason'>): boolean {
  return event.source !== 'roulette' && event.endReason !== 'removed';
}
