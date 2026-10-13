import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Track } from '../../core/models';
import { ExternalSource, PlayerService } from '../../core/player/player.service';
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
  /** Tracks this round played, in order; Previous and Next walk it before a new pick. */
  history: Track[];
  /** Index of the playing track in `history`. */
  cursor: number;
  /** Picked ahead (handed to the player by `peek`) so gapless and crossfade can prepare it. */
  pending: Track | null;
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
 * A round of the developer Random folder page. It plays as the player's external source, so the
 * user's queue stays parked and untouched: each next track is picked from the source when it is
 * needed. The round outlives the page, so it keeps picking (silently) while you are elsewhere, and
 * ends once the player leaves it (Back to queue, Stop roulette, or playing something else).
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
  /** What the player calls for the round's next, prepared and previous tracks. */
  private readonly source: ExternalSource = {
    next: () => this.nextTrack(),
    peek: () => this.peekTrack(),
    previous: () => this.previousTrack(),
  };
  /** True while the player plays this round in place of the queue. */
  readonly active = computed(() => this.player.externalSource() === this.source);

  constructor() {
    effect(() => {
      const saved = [[OPTIONS_KEY, this.options()], [PITY_KEY, this.pity()]] as const;
      try {
        for (const [key, value] of saved) localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Storage blocked: options and pity last for this session only.
      }
    });
    // The player left the round (Back to queue, Stop roulette, something else played): it is over.
    let wasActive = false;
    effect(() => {
      const active = this.active();
      if (active) wasActive = true;
      else if (wasActive) {
        wasActive = false;
        untracked(() => this.endRound());
      }
    });
  }

  setOption(key: keyof RandomOptions, value: boolean): void {
    this.options.update((options) => ({ ...options, [key]: value }));
  }

  /** Starts a new round from the page: clears what this round picked and rolls the first track. */
  start(pool: Track[], source: string): boolean {
    this.endRound();
    this.round = { pool, source, picked: new Set(), history: [], cursor: -1, pending: null };
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
    await this.play(spin.pick);
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

  /** Plays a pick the reel revealed (or the round's first) as the player's external source. */
  private async play(track: Track): Promise<void> {
    const round = this.round;
    if (!round) return;
    this.record(round, track);
    try {
      await this.player.playExternal(this.source, track);
    } catch {
      this.notice.set('Could not start playback. Roll again.');
    }
  }

  private record(round: Round, track: Track): void {
    round.history.push(track);
    round.cursor = round.history.length - 1;
  }

  /** Shows a track the round moved to without a reel, when the roll view is up. */
  private display(track: Track): void {
    if (!this.spin()) return;
    this.spin.set(this.makeSpin(track, { first: false, settled: true, durationMs: 0 }));
    this.showResult(track);
  }

  /** True while the page should show a reel for the next pick instead of picking silently. */
  private rollsOnPage(): boolean {
    // Roll on the page only while its roll view is showing and the window is visible; otherwise pick
    // silently, so music in the background does not wait through a reel nobody sees.
    return this.options().rollEveryTrack && this.pageOpen() && !!this.spin() && !document.hidden;
  }

  /** A reel still spinning (a new round's first roll) holds the round. */
  private reelSpinning(): boolean {
    const spin = this.spin();
    return !!spin && !spin.settled;
  }

  /** The player's Next, or the end of a track. Null pauses: a reel, or the round is used up. */
  private nextTrack(): Track | null {
    const round = this.round;
    if (!round || this.reelSpinning()) return null;
    if (round.cursor < round.history.length - 1) {
      const track = round.history[++round.cursor];
      this.display(track);
      return track;
    }
    // A pick handed out by `peek` may already be playing gaplessly: it must not go through a reel.
    const pending = round.pending;
    round.pending = null;
    const track = pending ?? this.pick();
    if (!track) {
      const message = `Played all ${round.pool.length} tracks in ${round.source}. Roll again for a new round.`;
      this.notice.set(message);
      this.queueActions.notify(message);
      return null;
    }
    if (!pending && this.rollsOnPage()) {
      this.result.set(null);
      const spin = this.makeSpin(track, { first: false, settled: false, durationMs: NEXT_SPIN_MS });
      this.spin.set(spin);
      // Safety net: a reel the browser stopped animating (an occluded window) must not hold the music.
      setTimeout(() => { if (this.spin() === spin) void this.spinDone(); }, NEXT_SPIN_MS + SPIN_GRACE_MS);
      return null;
    }
    this.record(round, track);
    this.display(track);
    return track;
  }

  /** The track Next would play, picked ahead so gapless and crossfade work; null when a reel decides it. */
  private peekTrack(): Track | null {
    const round = this.round;
    if (!round || this.reelSpinning()) return null;
    if (round.cursor < round.history.length - 1) return round.history[round.cursor + 1];
    if (!round.pending && !this.rollsOnPage()) round.pending = this.pick();
    return round.pending;
  }

  /** The player's Previous: back through what this round played. */
  private previousTrack(): Track | null {
    const round = this.round;
    if (!round || this.reelSpinning() || round.cursor <= 0) return null;
    const track = round.history[--round.cursor];
    this.display(track);
    return track;
  }
}
