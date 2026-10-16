import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { LISTENING_HISTORY_GATEWAY } from '../contracts';
import { PlayEvent } from '../models';
import { PlayerService } from '../player/player.service';
import { closedListen, endWindowFor, ListenTracker, parseOpenListen } from './listen-tracker';

/** The listen in progress, so one cut short by closing the app is still recorded on the next start. */
export const OPEN_LISTEN_KEY = 'lutstra.history.openListen';
/** A transport request older than this did not cause the track change being observed. */
const CAUSE_WINDOW_MS = 5000;

/**
 * Records every listen in the background for the listener analysis (Smart Shuffle).
 * Nothing here is shown to the user beyond the History page.
 */
@Injectable({ providedIn: 'root' })
export class ListeningHistoryService {
  private readonly player = inject(PlayerService);
  private readonly gateway = inject(LISTENING_HISTORY_GATEWAY);
  private readonly tracker = new ListenTracker((event) => this.record(event));
  private consumedCauseAt = 0;
  private savedPlayed = -1;
  /** Bumped after each recorded listen, so an open History page can reload. */
  readonly changes = signal(0);

  constructor() {
    this.recordInterruptedListen();
    effect(() => {
      const track = this.player.currentTrack();
      const entry = this.player.currentQueueEntry();
      const time = this.player.currentTime();
      const state = this.player.playbackState();
      const external = this.player.externalSource() !== null;
      untracked(() => {
        const transition = this.player.lastTransition();
        const fresh = transition && transition.at > this.consumedCauseAt && Date.now() - transition.at < CAUSE_WINDOW_MS;
        const changed = this.tracker.observe({
          key: track ? `${entry?.id ?? ''}|${track.id}` : null,
          trackId: track?.id ?? null,
          time,
          duration: Math.max(track?.duration ?? 0, this.player.duration()),
          playing: state === 'playing',
          source: external ? 'roulette' : 'queue',
          endWindow: endWindowFor(this.player.crossfadeEnabled(), this.player.crossfadeSeconds()),
        }, fresh ? transition.cause : null, Date.now());
        if (changed && transition) this.consumedCauseAt = transition.at;
        this.saveOpenListen(changed);
      });
    });
  }

  async clear(): Promise<void> {
    await this.gateway.clear();
    this.changes.update((value) => value + 1);
  }

  private record(event: PlayEvent): void {
    this.gateway.record(event)
      .then(() => this.changes.update((value) => value + 1))
      .catch((error) => console.warn('Could not record a listen', error));
  }

  private recordInterruptedListen(): void {
    const open = parseOpenListen(this.storage(() => localStorage.getItem(OPEN_LISTEN_KEY)));
    this.storage(() => localStorage.removeItem(OPEN_LISTEN_KEY));
    const event = open && closedListen(open, 'app_closed');
    if (event) this.record(event);
  }

  /** Writes the open listen when it starts and about once a second of play, not on every time update. */
  private saveOpenListen(changed: boolean): void {
    const open = this.tracker.current();
    const played = open ? Math.floor(open.played) : -1;
    if (!changed && played === this.savedPlayed) return;
    this.savedPlayed = played;
    this.storage(() => open ? localStorage.setItem(OPEN_LISTEN_KEY, JSON.stringify(open)) : localStorage.removeItem(OPEN_LISTEN_KEY));
  }

  private storage<T>(action: () => T): T | null {
    try {
      return action();
    } catch {
      return null;
    }
  }
}
