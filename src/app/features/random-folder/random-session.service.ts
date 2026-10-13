import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Track } from '../../core/models';
import { RightPanelService } from '../../core/layout/right-panel.service';
import { PlayerService } from '../../core/player/player.service';
import { QueueActionsService } from '../../core/player/queue-actions.service';
import { Pity, RarityTier, Reel, TierCounts, buildReel, drawTrack } from './random-folder.utils';

export interface RandomOptions {
  includeSubfolders: boolean;
  /** Roll the reel before every track instead of only the first one. */
  rollEveryTrack: boolean;
  /** Never pick a track twice in one round. */
  noRepeats: boolean;
  /** With `noRepeats`, start over once every track was played instead of stopping. */
  infinite: boolean;
}

export interface RandomResult {
  track: Track;
}

export interface Spin extends Reel<Track> {
  /** Changes on every spin so the reel component is recreated. */
  id: number;
  pick: Track;
  durationMs: number;
  /** True once the reel stopped; a settled reel is redrawn at its stop point without spinning. */
  settled: boolean;
  /** The round's opening roll; leaving the page during it cancels the round. */
  first: boolean;
}

interface Round {
  pool: Track[];
  source: string;
  picked: Set<string>;
}

const OPTIONS_KEY = 'lutsra.dev.randomFolder.options';
const PITY_KEY = 'lutsra.dev.randomFolder.pity';
const NO_PITY: Pity = { gold: 0, red: 0, mythic: 0 };
/** Below this many base-to-red tracks, gold and mythical may fill the reel too. */
const MIN_FILLER_TRACKS = 5;

function readPity(): Pity {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PITY_KEY) ?? 'null');
    const pity = value as Partial<Pity> | null;
    // Counters saved before the mythical tier have no `mythic`.
    const mythic = Number.isInteger(pity?.mythic) ? pity!.mythic! : 0;
    return Number.isInteger(pity?.gold) && Number.isInteger(pity?.red) ? { gold: pity!.gold!, red: pity!.red!, mythic } : NO_PITY;
  } catch {
    return NO_PITY;
  }
}
const DEFAULT_OPTIONS: RandomOptions = { includeSubfolders: true, rollEveryTrack: false, noRepeats: true, infinite: false };
const FIRST_SPIN_MS = 7000;
const NEXT_SPIN_MS = 3000;
const SPIN_GRACE_MS = 1000;

function readOptions(): RandomOptions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return DEFAULT_OPTIONS;
    const saved = value as Partial<Record<keyof RandomOptions, unknown>>;
    const flag = (key: keyof RandomOptions) => typeof saved[key] === 'boolean' ? saved[key] as boolean : DEFAULT_OPTIONS[key];
    return { includeSubfolders: flag('includeSubfolders'), rollEveryTrack: flag('rollEveryTrack'), noRepeats: flag('noRepeats'), infinite: flag('infinite') };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/**
 * A round of the developer Random folder page. The queue holds only the round's history: each
 * next track is picked from the source when it is needed. The round outlives the page, so it keeps
 * picking (silently) while you are elsewhere, and ends once anything else is played or queued.
 */
@Injectable({ providedIn: 'root' })
export class RandomSessionService {
  private readonly player = inject(PlayerService);
  private readonly queueActions = inject(QueueActionsService);

  readonly options = signal<RandomOptions>(readOptions());
  /** Gacha pity, kept across rounds and app restarts; only a gold pick resets the gold counter. */
  readonly pity = signal<Pity>(readPity());
  /** Rarity by YouTube views, set by the page from the whole library; tracks without views are base. */
  readonly tiers = signal<ReadonlyMap<string, RarityTier>>(new Map());
  readonly tierOf = (track: { id: string }): RarityTier => this.tiers().get(track.id) ?? 1;
  /** Tracks per tier in the whole library, set with `tiers`; rolls scale their rates against it. */
  readonly libraryTiers = signal<TierCounts | undefined>(undefined);
  readonly spin = signal<Spin | null>(null);
  readonly result = signal<RandomResult | null>(null);
  readonly notice = signal<string | null>(null);
  /** Set by the page; rolls are only shown while it is open. */
  readonly pageOpen = signal(false);

  private round: Round | null = null;
  private spinCount = 0;
  /** Queue entries this round created; the round owns the queue while it holds only these. */
  private readonly entryIds = signal<ReadonlySet<string>>(new Set());
  readonly active = computed(() => {
    const ids = this.entryIds();
    const queue = this.player.queue();
    return ids.size > 0 && queue.length > 0 && queue.every((entry) => ids.has(entry.id));
  });

  constructor() {
    const rightPanels = inject(RightPanelService);
    effect(() => {
      const saved = [[OPTIONS_KEY, this.options()], [PITY_KEY, this.pity()]] as const;
      try {
        for (const [key, value] of saved) localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Storage blocked: options and pity last for this session only.
      }
    });
    effect(() => {
      const active = this.active();
      rightPanels.randomSessionActive.set(active);
      if (active) rightPanels.closeQueue();
      // Something else replaced or extended the queue: the round is over.
      else if (this.entryIds().size) untracked(() => this.endRound());
    });
    // Roll once: keep one picked track queued ahead so crossfade and gapless still work.
    effect(() => {
      const index = this.player.currentIndex();
      const length = this.player.queue().length;
      if (!this.active() || this.options().rollEveryTrack || index !== length - 1) return;
      untracked(() => this.queueAhead());
    });
  }

  setOption(key: keyof RandomOptions, value: boolean): void {
    this.options.update((options) => ({ ...options, [key]: value }));
  }

  /** Starts a new round from the page: clears what this round picked and rolls the first track. */
  start(pool: Track[], source: string): boolean {
    this.endRound();
    this.round = { pool, source, picked: new Set() };
    this.notice.set(null);
    const pick = this.pick();
    if (!pick) return false;
    this.result.set(null);
    this.spin.set(this.makeSpin(pick, { first: true, settled: false, durationMs: FIRST_SPIN_MS }));
    return true;
  }

  /** The page's reel stopped: show the pick and play it. */
  async spinDone(): Promise<void> {
    const spin = this.spin();
    if (!spin || spin.settled) return;
    this.spin.set({ ...spin, settled: true });
    this.showResult(spin.pick);
    await this.play(spin.pick, spin.first);
  }

  /** The page closed. A first roll still spinning is dropped; a later one finishes silently. */
  pageClosed(): void {
    this.pageOpen.set(false);
    const spin = this.spin();
    if (!spin || spin.settled) return;
    if (spin.first) {
      this.spin.set(null);
      this.round = null;
    } else {
      void this.spinDone();
    }
  }

  /** Back to the folder list. The round keeps playing until a new Random starts the next one. */
  leaveRollView(): void {
    this.spin.set(null);
    this.result.set(null);
    this.notice.set(null);
  }

  private endRound(): void {
    this.player.setQueueEndHandler(null);
    this.entryIds.set(new Set());
    this.round = null;
  }

  private pick(): Track | null {
    const round = this.round;
    if (!round) return null;
    const { noRepeats, infinite } = this.options();
    // Every pick is one gacha roll, silent ones included.
    const draw = () => drawTrack(round.pool, round.picked, noRepeats, this.pity(), this.tierOf, Math.random, this.libraryTiers());
    let drawn = draw();
    if (!drawn && noRepeats && infinite && round.pool.length) {
      // Infinite roulette: every track was played, so start over, keeping the last one out of the very next pick.
      const last = [...round.picked].pop();
      round.picked = new Set(last && round.pool.length > 1 ? [last] : []);
      drawn = draw();
    }
    if (!drawn) return null;
    this.pity.set(drawn.pity);
    round.picked.add(drawn.track.id);
    return drawn.track;
  }

  private makeSpin(pick: Track, state: Pick<Spin, 'first' | 'settled' | 'durationMs'>): Spin {
    // Filler follows the rates without pity, so the strip looks like a case: mostly base, sometimes red.
    // Gold and mythical stay off it so they show only on a winning cell, unless the source has too few
    // lower tracks to fill a varied strip (a folder of hits), where the whole source fills it.
    const round = this.round?.pool ?? [pick];
    const lower = round.filter((track) => this.tierOf(track) < 4);
    const pool = lower.length >= MIN_FILLER_TRACKS ? lower : round;
    const fill = () => drawTrack(pool, new Set(), false, NO_PITY, this.tierOf, Math.random, this.libraryTiers())?.track ?? pick;
    return { ...buildReel(fill, pick), id: ++this.spinCount, pick, ...state };
  }

  private showResult(track: Track): void {
    this.result.set({ track });
  }

  private async play(track: Track, first: boolean): Promise<void> {
    try {
      if (first) {
        await this.player.playCollection([track], 0);
        this.player.setQueueEndHandler(() => this.onQueueEnd());
      } else {
        this.player.addToQueue([track]);
        this.trackQueue();
        await this.player.jumpToQueueIndex(this.player.queue().length - 1);
      }
      this.trackQueue();
    } catch {
      this.notice.set('Could not start playback. Roll again.');
    }
  }

  /** Remembers every current queue entry as this round's own. */
  private trackQueue(): void {
    this.entryIds.set(new Set(this.player.queue().map((entry) => entry.id)));
  }

  private queueAhead(): void {
    const track = this.pick();
    if (!track) return;
    this.player.addToQueue([track]);
    this.trackQueue();
  }

  /** Next was pressed, or a track ended, on the last entry of the round. */
  private onQueueEnd(): void {
    const round = this.round;
    if (!round || (this.spin() && !this.spin()!.settled)) return;
    const track = this.pick();
    if (!track) {
      this.player.pause();
      const message = `Played all ${round.pool.length} tracks in ${round.source}. Roll again for a new round.`;
      this.notice.set(message);
      this.queueActions.notify(message);
      return;
    }
    // Roll on the page only while its roll view is showing and the window is visible; otherwise pick
    // silently, so music in the background does not wait through a reel nobody sees.
    if (this.options().rollEveryTrack && this.pageOpen() && this.spin() && !document.hidden) {
      this.player.pause();
      this.result.set(null);
      const spin = this.makeSpin(track, { first: false, settled: false, durationMs: NEXT_SPIN_MS });
      this.spin.set(spin);
      // Safety net: a reel the browser stopped animating (an occluded window) must not hold the music.
      setTimeout(() => { if (this.spin() === spin) void this.spinDone(); }, NEXT_SPIN_MS + SPIN_GRACE_MS);
      return;
    }
    if (this.spin()) {
      this.spin.set(this.makeSpin(track, { first: false, settled: true, durationMs: 0 }));
      this.showResult(track);
    }
    void this.play(track, false);
  }
}
