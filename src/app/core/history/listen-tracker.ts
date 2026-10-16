import { ListenEnd, ListenSource, ListenStart, PlayEvent, TransitionCause } from '../models';

export interface ListenObservation {
  /** Identity of the playing item (queue entry and track); null when nothing is loaded. */
  key: string | null;
  trackId: string | null;
  time: number;
  duration: number;
  playing: boolean;
  source: ListenSource;
  /** Seconds before the end that still count as played through (crossfade starts the next track early). */
  endWindow: number;
}

export interface OpenListen {
  key: string;
  trackId: string;
  startedAt: number;
  played: number;
  furthest: number;
  last: number;
  duration: number;
  seekForward: number;
  startedBy: ListenStart;
  source: ListenSource;
  endWindow: number;
}

/** Listens shorter than this are not recorded, so flicking through tracks leaves no trace. */
export const MIN_RECORDED_SECONDS = 1;
/** Time updates arrive a few times a second; a larger forward step is a seek. */
const MAX_PLAY_STEP = 2;
/** After a wrap from the end, playback restarts within this many seconds (Repeat One). */
const WRAP_START = 3;

export function endWindowFor(crossfadeEnabled: boolean, crossfadeSeconds: number): number {
  return Math.max(3, crossfadeEnabled ? crossfadeSeconds + 1 : 0);
}

const playedThrough = (listen: OpenListen) => listen.duration > 0 && listen.furthest >= listen.duration - listen.endWindow;

function endReason(listen: OpenListen, cause: TransitionCause | null): ListenEnd {
  if (playedThrough(listen)) return 'ended';
  switch (cause) {
    case 'next': return 'skip_next';
    case 'previous': return 'skip_previous';
    case 'user': return 'picked_other';
    default: return 'other';
  }
}

/** The finished listen as a record, or null when it is too short to keep. */
export function closedListen(listen: OpenListen, reason: ListenEnd): PlayEvent | null {
  if (listen.played < MIN_RECORDED_SECONDS) return null;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    trackId: listen.trackId, startedAt: listen.startedAt, playedSeconds: round(listen.played), endPosition: round(listen.furthest),
    duration: round(listen.duration), seekForwardSeconds: round(listen.seekForward), startedBy: listen.startedBy, endReason: reason,
    source: listen.source,
  };
}

/** Restores a listen saved while the app was open; null for anything malformed. */
export function parseOpenListen(raw: string | null): OpenListen | null {
  try {
    const value = raw === null ? null : JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const numbers = ['startedAt', 'played', 'furthest', 'last', 'duration', 'seekForward', 'endWindow'];
    if (typeof value.key !== 'string' || typeof value.trackId !== 'string' || typeof value.startedBy !== 'string' || typeof value.source !== 'string') return null;
    if (!numbers.every((name) => typeof value[name] === 'number' && Number.isFinite(value[name]) && value[name] >= 0)) return null;
    return value as OpenListen;
  } catch {
    return null;
  }
}

/**
 * Turns the player's stream of (item, time) observations into finished listens.
 * A listen ends when another item starts, when playback wraps from the end to the start
 * (Repeat One), or when nothing is loaded any more.
 */
export class ListenTracker {
  private open: OpenListen | null = null;
  private first = true;

  constructor(private readonly emit: (event: PlayEvent) => void) {}

  /** The listen in progress, so it can be saved across an app close. */
  current(): OpenListen | null {
    return this.open;
  }

  /** Returns true when the observation ended or started a listen, so the caller can drop the cause it passed. */
  observe(observation: ListenObservation, cause: TransitionCause | null, now: number): boolean {
    const open = this.open;
    if (open && open.key !== observation.key) {
      this.finish(open, endReason(open, cause));
      this.start(observation, cause, now);
      return true;
    }
    if (!open) return this.start(observation, cause, now);

    open.endWindow = observation.endWindow;
    open.duration = Math.max(open.duration, observation.duration);
    const step = observation.time - open.last;
    if (step < 0 && playedThrough(open) && observation.time < WRAP_START) {
      this.finish(open, 'ended');
      this.start(observation, null, now);
      return true;
    }
    if (step > 0) {
      if (observation.playing && step <= MAX_PLAY_STEP) open.played += step;
      else open.seekForward += step;
    }
    open.last = observation.time;
    open.furthest = Math.max(open.furthest, observation.time);
    return false;
  }

  private start(observation: ListenObservation, cause: TransitionCause | null, now: number): boolean {
    if (observation.key === null || observation.trackId === null) {
      this.open = null;
      return false;
    }
    // The first listen nobody asked for is the restored session.
    const startedBy: ListenStart = cause ?? (this.first ? 'resume' : 'auto');
    this.first = false;
    this.open = {
      key: observation.key, trackId: observation.trackId, startedAt: now, played: 0, furthest: observation.time,
      last: observation.time, duration: observation.duration, seekForward: 0, startedBy, source: observation.source,
      endWindow: observation.endWindow,
    };
    return true;
  }

  private finish(listen: OpenListen, reason: ListenEnd): void {
    this.open = null;
    const event = closedListen(listen, reason);
    if (event) this.emit(event);
  }
}
