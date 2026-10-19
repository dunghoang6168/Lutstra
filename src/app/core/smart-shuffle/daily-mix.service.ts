import { Injectable, inject, signal } from '@angular/core';
import { LIBRARY_GATEWAY } from '../contracts';
import { QueueEntry, Track } from '../models';
import { ListeningHistoryService } from '../history/listening-history.service';
import { PlayerService } from '../player/player.service';
import { SmartShuffleService } from './smart-shuffle.service';

export const DAILY_MIX_KEY = 'lutstra.dailyMix';
export const DAILY_MIX_LENGTH = 30;

export interface StoredDailyMix { day: string; trackIds: string[] }

/** The local calendar day, so the mix turns over at midnight where the user is. */
export function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function parseDailyMix(raw: string | null): StoredDailyMix | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    return typeof value?.day === 'string' && Array.isArray(value.trackIds) && value.trackIds.every((id: unknown) => typeof id === 'string')
      ? { day: value.day, trackIds: value.trackIds } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the queue is playing this mix: every mix track is among the queue's own entries, in any order (Shuffle may
 * have mixed them). Suggestions (Autoplay, Smart Shuffle) are skipped, and tracks the user added do not count against it.
 */
// ponytail: a set check, so a queue that happens to hold a tiny leftover mix also counts; tag the queue's source if that bites.
export function isMixQueue(queue: readonly QueueEntry[], mix: readonly Track[]): boolean {
  if (!mix.length) return false;
  const own = new Set(queue.filter((entry) => !entry.suggested).map((entry) => entry.track.id));
  return mix.every((track) => own.has(track.id));
}

/**
 * Today's Daily Mix: thirty Smart Shuffle picks made once a day (or on Refresh) and then left alone.
 * It plays as an ordinary queue, so skips teach the profile but never change the list.
 */
@Injectable({ providedIn: 'root' })
export class DailyMixService {
  private readonly player = inject(PlayerService);
  private readonly smartShuffle = inject(SmartShuffleService);
  private readonly history = inject(ListeningHistoryService);
  private readonly libraryGateway = inject(LIBRARY_GATEWAY);

  readonly tracks = signal<Track[]>([]);
  readonly loading = signal(false);
  private pending: Promise<void> | null = null;
  private pendingDay = '';

  /** Loads today's mix, making a new one on a new day or when none of the saved tracks can play. */
  ensure(): Promise<void> {
    const today = localDay(Date.now());
    if (this.pending && this.pendingDay === today) return this.pending;
    this.pendingDay = today;
    return this.pending = this.run(async () => {
      const stored = parseDailyMix(this.read());
      if (stored?.day === localDay(Date.now())) {
        const byId = new Map((await this.libraryGateway.getLibrary()).tracks.map((track) => [track.id, track]));
        const tracks = stored.trackIds.map((id) => byId.get(id)).filter((track): track is Track => !!track?.isAvailable);
        if (tracks.length) { this.tracks.set(tracks); return; }
      }
      await this.generate();
    });
  }

  refresh(): Promise<void> {
    return this.pending = this.run(() => this.generate());
  }

  /** Taking a track out of the mix is a mild dislike, as for a removed suggestion. */
  remove(track: Track): void {
    this.tracks.update((tracks) => tracks.filter((item) => item.id !== track.id));
    this.save();
    this.history.recordRemoval(track);
  }

  /** Plays exactly the mix: Smart Shuffle goes off so no suggestions are mixed in. */
  async play(index = 0): Promise<void> {
    if (!this.tracks().length) return;
    if (this.player.smartShuffle()) this.player.setSmartShuffle(false);
    await this.player.playCollection(this.tracks(), index);
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.loading.set(true);
    try {
      await task();
    } catch (error) {
      console.warn('Could not make the Daily Mix', error);
      this.pending = null;
    } finally {
      this.loading.set(false);
    }
  }

  private async generate(): Promise<void> {
    this.tracks.set(await this.smartShuffle.picks(DAILY_MIX_LENGTH));
    this.save();
  }

  private save(): void {
    const value: StoredDailyMix = { day: localDay(Date.now()), trackIds: this.tracks().map((track) => track.id) };
    try { localStorage.setItem(DAILY_MIX_KEY, JSON.stringify(value)); } catch { /* Losing the save only costs a fresh mix. */ }
  }

  private read(): string | null {
    try { return localStorage.getItem(DAILY_MIX_KEY); } catch { return null; }
  }
}
