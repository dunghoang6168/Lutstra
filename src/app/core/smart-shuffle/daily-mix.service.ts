import { Injectable, computed, inject, signal } from '@angular/core';
import { LIBRARY_GATEWAY } from '../contracts';
import { QueueEntry, Track } from '../models';
import { ListeningHistoryService } from '../history/listening-history.service';
import { PlayerService } from '../player/player.service';
import { SmartShuffleService } from './smart-shuffle.service';

export const DAILY_MIX_KEY = 'lutstra.dailyMix';
export const DAILY_MIX_LENGTH = 30;
/** Rows of the mix's Up next list on Home. */
const MIX_ROWS = 5;

export interface StoredDailyMix { day: string; trackIds: string[] }
/** A row of Up next: a queue entry while the mix plays, otherwise a place in the mix. */
export interface MixRow { track: Track; current: boolean; queueIndex: number | null; mixIndex: number | null }

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
 * Whether the queue is playing this mix. Suggestions (Autoplay, Smart Shuffle) are skipped and tracks the user added
 * may sit anywhere. Unshuffled, the mix's tracks appear in mix order, which a library queue holding them all does not
 * do. Shuffled, every mix track is there and they make up at least half of the queue.
 */
// ponytail: dragging a mix track out of order, or a shuffled library under twice the mix, misreads; tag the queue's source if that bites.
export function isMixQueue(queue: readonly QueueEntry[], mix: readonly Track[], shuffled = false): boolean {
  if (!mix.length) return false;
  const own = queue.filter((entry) => !entry.suggested).map((entry) => entry.track.id);
  if (shuffled) {
    const ids = new Set(own);
    return own.length < mix.length * 2 && mix.every((track) => ids.has(track.id));
  }
  let found = 0;
  for (const id of own) if (id === mix[found]?.id) found++;
  return found === mix.length;
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
  /** Whether the queue is playing this mix (see `isMixQueue`). */
  readonly live = computed(() => !this.player.modesLocked() && isMixQueue(this.player.queue(), this.tracks(), this.player.isShuffle()));
  /** While the mix plays, the queue's own entries, which keep what the user added; suggestions stay in the queue. */
  private readonly own = computed(() => this.live()
    ? this.player.queue().map((entry, queueIndex) => ({ entry, queueIndex })).filter(({ entry }) => !entry.suggested) : []);
  /** "7 of 30" while the mix plays: how many of its entries have been reached, out of all of them. */
  readonly position = computed(() => {
    const at = this.player.currentIndex();
    return this.live() ? { at: Math.max(1, this.own().filter(({ queueIndex }) => queueIndex <= at).length), total: this.own().length } : null;
  });
  /**
   * Up next: while the mix plays, its entries from the current one; otherwise the mix's first rows.
   * `from` is the first row's place in the mix, and `end` is set once the last of them is in the list.
   */
  readonly upNext = computed<{ rows: MixRow[]; end: boolean; from: number }>(() => {
    if (!this.live()) {
      return { rows: this.tracks().slice(0, MIX_ROWS).map((track, i) => ({ track, current: false, queueIndex: null, mixIndex: i })), end: false, from: 0 };
    }
    const at = this.player.currentIndex();
    const own = this.own();
    const next = own.findIndex(({ queueIndex }) => queueIndex >= at);
    const from = next >= 0 ? next : Math.max(0, own.length - MIX_ROWS);
    const rows = own.slice(from, from + MIX_ROWS).map(({ entry, queueIndex }) => ({ track: entry.track, current: queueIndex === at, queueIndex, mixIndex: null }));
    return { rows, end: from + rows.length >= own.length, from };
  });
  readonly totalSeconds = computed(() => this.tracks().reduce((sum, track) => sum + (track.duration || 0), 0));
  /** Four distinct covers for a mosaic; fewer show the first one. */
  readonly covers = computed(() => [...new Set(this.tracks().map((track) => track.artwork).filter((art): art is string => !!art))].slice(0, 4));
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

  /** The mix's big button: plays it from the top, or toggles playback while it is playing. */
  playOrPause(): void {
    if (this.live()) void this.player.togglePlayPause();
    else void this.play();
  }

  /** While the mix plays a row jumps to its entry, keeping what the user added; otherwise the mix starts there. */
  playRow(row: MixRow): void {
    if (row.queueIndex !== null) void this.player.jumpToQueueIndex(row.queueIndex);
    else if (row.mixIndex !== null) void this.play(row.mixIndex);
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
