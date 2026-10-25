import { Injectable, effect, inject, untracked } from '@angular/core';
import { LIBRARY_GATEWAY, LISTENING_HISTORY_GATEWAY, PLAYLIST_GATEWAY, POPULARITY_GATEWAY } from '../contracts';
import { FolderNode, PlayEvent, QueueEntry, Track } from '../models';
import { ListeningHistoryService } from '../history/listening-history.service';
import { trackRegions } from '../library/track-regions';
import { PlayerService } from '../player/player.service';
import { addListen, artistKey, buildProfile, dupKey, emptyProfile, hourBucket, ListenerProfile, TrackFacts } from './listener-profile';
import { newSession, PlanEntry, planUpcoming, Random, ScoreContext, suggestionSpacing, SUGGESTION_WINDOW, updateSession } from './smart-shuffle';

/** How many tracks before the current one count as context for the next picks. */
const RECENT_CONTEXT = 4;
/** How many suggestions Autoplay queues at a time. */
const AUTOPLAY_BATCH = 5;
/**
 * How many picks Autoplay keeps in reserve for an engine that plays on with the web asleep (Android, screen off).
 * ponytail: about 6 hours past the queue; Media3 stops after them until the web wakes and tops them up.
 */
const AUTOPLAY_RESERVE = 100;

/**
 * Arranges the queue while Smart Shuffle is on: the user's tracks in taste order with suggestions mixed in
 * (`planUpcoming`), learning from every listen the history records.
 */
@Injectable({ providedIn: 'root' })
export class SmartShuffleService {
  private readonly player = inject(PlayerService);
  private readonly history = inject(ListeningHistoryService);
  private readonly libraryGateway = inject(LIBRARY_GATEWAY);
  private readonly historyGateway = inject(LISTENING_HISTORY_GATEWAY);
  private readonly playlistGateway = inject(PLAYLIST_GATEWAY, { optional: true });
  private readonly popularityGateway = inject(POPULARITY_GATEWAY, { optional: true });

  private facts = new Map<string, TrackFacts>();
  private tracks = new Map<string, Track>();
  private profile: ListenerProfile | null = null;
  private events: PlayEvent[] = [];
  private loading: Promise<void> | null = null;
  private session = newSession();
  /** Played or removed this session: not suggested again. */
  private readonly sessionExclude = new Set<string>();
  /** The user's entries already arranged; a new one (Add to queue) makes the next arrangement reorder. */
  private readonly arrangedEntries = new Set<string>();
  private reorderNext = false;
  private refreshNext = false;
  private lastSignature = '';
  private autoplaySignature = '';
  /** The suggestion whose start already refreshed the preview behind it. */
  private autoplayRefreshedId = '';
  /** What the player holds as Autoplay's reserve (`PlayerService.setAutoplayReserve`). */
  private reserve: Track[] = [];
  /** The queue's first entry when the reserve was picked: a new queue gets a new reserve. */
  private reserveFor = '';
  /** The library had fewer picks than asked: no top-up until some are used or the queue is new. */
  private reserveExhausted = false;
  private reserving = false;
  private scheduled = false;
  private wasEnabled = false;
  private arranging = false;
  random: Random = Math.random;

  constructor() {
    this.history.recorded$.subscribe((event) => this.onListen(event));
    this.history.cleared$.subscribe(() => {
      this.events = [];
      this.profile = emptyProfile(this.facts);
    });
    this.libraryGateway.libraryChanged$?.subscribe(() => { this.loading = null; });
    effect(() => {
      const enabled = this.player.smartShuffle();
      this.player.queue();
      this.player.currentIndex();
      // Autoplay's conditions.
      this.player.autoplay();
      this.player.repeatMode();
      this.player.modesLocked();
      this.player.isPlaybackActive();
      untracked(() => {
        // Turned on (by either cycle or a restored setting): the user's tracks get a fresh taste order.
        if (enabled && !this.wasEnabled) this.reorderNext = true;
        this.wasEnabled = enabled;
        if (enabled) this.schedule();
        else void this.autoplay();
        void this.keepReserve();
      });
    });
  }

  /** The shuffle button and S: Off → Shuffle → Smart Shuffle → Off. */
  async cycleShuffle(): Promise<void> {
    if (this.player.modesLocked()) return;
    this.player.cycleShuffle();
    await this.startIfEmpty();
  }

  /** The one playback-mode button (Ambient, Gallery Now Playing): Smart Shuffle comes after Shuffle. */
  async cyclePlaybackMode(): Promise<void> {
    if (this.player.modesLocked()) return;
    this.player.cyclePlaybackMode();
    await this.startIfEmpty();
  }

  /** A cold-start run of `count` picks, linked track to track (the Daily Mix). */
  async picks(count: number): Promise<Track[]> {
    await this.ensureLoaded();
    return this.coldPlan(count);
  }

  /** Only a user's turn starts playback; a setting restored at launch never does. */
  private async startIfEmpty(): Promise<void> {
    if (this.player.smartShuffle() && !this.player.queue().length) await this.start();
  }

  private async start(): Promise<void> {
    await this.ensureLoaded();
    if (!this.player.smartShuffle() || this.player.queue().length) return;
    const plan = this.coldPlan();
    this.reorderNext = false;
    await this.player.startSuggestions(plan.map((track) => this.player.createSuggestedEntry(track)));
  }

  private coldPlan(window = SUGGESTION_WINDOW): Track[] {
    return planUpcoming({
      upcoming: [], recent: [], userRun: 0, every: suggestionSpacing(this.events), window,
      refresh: false, reorder: false, exclude: this.sessionExclude,
    }, this.context()).map((item) => this.tracks.get(item.trackId)!);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.arrange();
    });
  }

  private async arrange(): Promise<void> {
    if (this.arranging) {
      this.schedule();
      return;
    }
    this.arranging = true;
    try {
      await this.ensureLoaded();
      if (!this.player.smartShuffle() || this.player.modesLocked()) return;
      const queue = this.player.queue();
      const index = this.player.currentIndex();
      if (!queue.length) return;
      const upcoming = queue.slice(index + 1);
      const reorder = this.reorderNext || upcoming.some((entry) => !entry.suggested && !entry.pinned && !this.arrangedEntries.has(entry.id));
      const refresh = this.refreshNext;
      if (!reorder && !refresh && signatureOf(queue, index) === this.lastSignature) return;
      this.reorderNext = false;
      this.refreshNext = false;
      for (const entry of queue) if (!entry.suggested) this.arrangedEntries.add(entry.id);

      let userRun = 0;
      for (let i = index; i >= 0 && !queue[i].suggested; i--) userRun++;
      const plan = planUpcoming({
        upcoming: upcoming.map(planEntry),
        recent: queue.slice(Math.max(0, index - RECENT_CONTEXT), index + 1).map((entry) => entry.track.id),
        userRun, every: suggestionSpacing(this.events), window: SUGGESTION_WINDOW, refresh, reorder,
        exclude: new Set([...this.sessionExclude, ...queue.map((entry) => entry.track.id)]),
      }, this.context());

      const byId = new Map(upcoming.map((entry) => [entry.id, entry]));
      const arranged = plan.map((item) => item.entryId ? byId.get(item.entryId)! : this.player.createSuggestedEntry(this.tracks.get(item.trackId)!));
      // Bail out if the queue changed while the library loaded; the effect schedules another pass.
      if (this.player.queue() !== queue || this.player.currentIndex() !== index) return;
      if (arranged.length !== upcoming.length || arranged.some((entry, i) => entry !== upcoming[i])) this.player.replaceUpcoming(arranged);
      this.lastSignature = signatureOf(this.player.queue(), this.player.currentIndex());
    } catch (error) {
      console.warn('Smart Shuffle could not arrange the queue', error);
    } finally {
      this.arranging = false;
    }
  }

  private autoplayAllowed(): boolean {
    const player = this.player;
    return player.autoplay() && !player.smartShuffle() && player.repeatMode() === 'off' && !player.modesLocked();
  }

  /**
   * Autoplay keeps `AUTOPLAY_BATCH` suggestions waiting after the queue, like Spotify's:
   * - a preview, linked on from the queue's last tracks, as soon as the queue has none;
   * - when the first of them starts, the rest are picked again from what was really played;
   * - each later suggestion that starts tops the run back up, leaving the waiting ones as they are.
   * They are queue entries, so gapless and crossfade reach them like any other track.
   */
  private async autoplay(): Promise<void> {
    if (!this.autoplayAllowed()) return;
    const queue = this.player.queue();
    const index = this.player.currentIndex();
    if (index < 0 || !queue.length) return;
    let start = queue.length;
    while (start > index + 1 && queue[start - 1].suggested) start--;
    const waiting = queue.length - start;
    const current = queue[index];
    const refresh = current.suggested && !queue[index - 1]?.suggested && current.id !== this.autoplayRefreshedId;
    const count = refresh ? AUTOPLAY_BATCH : current.suggested ? AUTOPLAY_BATCH - waiting : waiting ? 0 : AUTOPLAY_BATCH;
    if (count <= 0) return;
    // Once per queue state, so a library with nothing left to suggest is not asked again and again.
    const signature = signatureOf(queue, index);
    if (signature === this.autoplaySignature) return;
    this.autoplaySignature = signature;
    try {
      await this.ensureLoaded();
      // Things changed while the library loaded: the effect asks again for the new state.
      if (!this.autoplayAllowed() || this.player.queue() !== queue || this.player.currentIndex() !== index) {
        this.autoplaySignature = '';
        return;
      }
      const picks = this.autoplayPicks(queue, index, start, count, refresh ? queue.slice(0, index + 1) : queue);
      // Only an empty result is remembered: the same queue may need a preview again (after Repeat, say).
      if (picks.length) this.autoplaySignature = '';
      if (refresh) {
        this.autoplayRefreshedId = current.id;
        // Tracks the user added after this one stay; only the preview is picked again (or kept, with nothing to pick).
        if (picks.length) this.player.replaceUpcoming([...queue.slice(index + 1).filter((entry) => !entry.suggested), ...picks]);
      } else {
        this.player.appendSuggestions(picks);
      }
    } catch (error) {
      console.warn('Autoplay could not queue suggestions', error);
    }
  }

  /**
   * Keeps `AUTOPLAY_RESERVE` picks past the queue for an engine that plays on by itself, so Autoplay goes on
   * while the web sleeps. They are picked once and topped up when half have been used (played, or queued).
   */
  private async keepReserve(): Promise<void> {
    if (!this.player.enginePlaysFollowing) return;
    if (!this.autoplayAllowed()) {
      if (this.reserve.length) this.setReserve([]);
      return;
    }
    const queue = this.player.queue();
    if (this.player.currentIndex() < 0 || !queue.length) return;
    const queued = new Set(queue.map((entry) => entry.track.id));
    const same = queue[0].id === this.reserveFor;
    const kept = same ? this.reserve.filter((track) => !queued.has(track.id)) : [];
    if (same && (kept.length >= AUTOPLAY_RESERVE / 2 || (this.reserveExhausted && kept.length === this.reserve.length))) {
      if (kept.length !== this.reserve.length) this.setReserve(kept);
      return;
    }
    if (this.reserving) return;
    this.reserving = true;
    try {
      await this.ensureLoaded();
      if (!this.autoplayAllowed()) return;
      this.reserveFor = queue[0].id;
      const after = [...queue.map((entry) => entry.track.id), ...kept.map((track) => track.id)];
      const picks = planUpcoming({
        upcoming: [], recent: after.slice(-(RECENT_CONTEXT + 1)), userRun: 0, every: suggestionSpacing(this.events),
        window: AUTOPLAY_RESERVE - kept.length, refresh: false, reorder: false,
        exclude: new Set([...this.sessionExclude, ...after]),
      }, this.context());
      this.reserveExhausted = picks.length < AUTOPLAY_RESERVE - kept.length;
      this.setReserve([...kept, ...picks.map((item) => this.tracks.get(item.trackId)!)]);
    } catch (error) {
      console.warn('Autoplay could not pick its reserve', error);
    } finally {
      this.reserving = false;
    }
  }

  private setReserve(tracks: Track[]): void {
    this.reserve = tracks;
    this.player.setAutoplayReserve(tracks);
  }

  /** The queue's Refresh: picks all the waiting Autoplay suggestions again, none of them the same as before. */
  async refreshAutoplay(): Promise<void> {
    if (!this.autoplayAllowed()) return;
    await this.ensureLoaded();
    const queue = this.player.queue();
    const index = this.player.currentIndex();
    let start = queue.length;
    while (start > index + 1 && queue[start - 1].suggested) start--;
    if (index < 0 || start === queue.length) return;
    // Every track in the queue is left out, the old picks too, so Refresh always brings new ones.
    const picks = this.autoplayPicks(queue, index, start, AUTOPLAY_BATCH, queue);
    if (picks.length) this.player.replaceUpcoming([...queue.slice(index + 1, start), ...picks]);
  }

  /** The preview follows the queue's last tracks; once suggestions play, the tracks just heard. */
  private autoplayPicks(queue: QueueEntry[], index: number, start: number, count: number, exclude: QueueEntry[]): QueueEntry[] {
    const until = queue[index].suggested ? index + 1 : start;
    return planUpcoming({
      upcoming: [], recent: queue.slice(Math.max(0, until - RECENT_CONTEXT - 1), until).map((entry) => entry.track.id),
      userRun: 0, every: suggestionSpacing(this.events), window: count, refresh: false, reorder: false,
      exclude: new Set([...this.sessionExclude, ...exclude.map((entry) => entry.track.id)]),
    }, this.context()).map((item) => this.player.createSuggestedEntry(this.tracks.get(item.trackId)!));
  }

  private onListen(event: PlayEvent): void {
    this.events.push(event);
    if (this.profile) addListen(this.profile, event, this.facts, Date.now());
    updateSession(this.session, event, this.facts.get(event.trackId));
    if (event.playedSeconds > 0 || event.endReason === 'removed') this.sessionExclude.add(event.trackId);
    // A skip steers the tentative suggestions after the next track right away.
    if (this.player.smartShuffle() && (event.endReason === 'skip_next' || event.endReason === 'removed')) {
      this.refreshNext = true;
      this.schedule();
    }
  }

  private context(): ScoreContext {
    const now = Date.now();
    return { profile: this.profile ?? emptyProfile(this.facts), facts: this.facts, now, bucket: hourBucket(now), session: this.session, random: this.random };
  }

  private ensureLoaded(): Promise<void> {
    return this.loading ??= this.load().catch((error) => {
      this.loading = null;
      throw error;
    });
  }

  private async load(): Promise<void> {
    const [library, events, playlists] = await Promise.all([
      this.libraryGateway.getLibrary(),
      this.historyGateway.events(),
      this.playlistGateway?.getPlaylists().catch(() => []) ?? Promise.resolve([]),
    ]);
    const trees = await Promise.allSettled(library.folders.map((folder) => this.libraryGateway.getFolderTree(folder.id)));
    const regions = trackRegions(trees.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value as FolderNode] : []));
    const available = library.tracks.filter((track) => track.isAvailable);
    const popularity = await this.popularityGateway?.getPopularity(available.map((track) => track.id)).catch(() => []) ?? [];
    const views = popularity.filter((item) => item.views !== null).sort((a, b) => a.views! - b.views!);
    const percentile = new Map(views.map((item, rank) => [item.trackId, views.length > 1 ? rank / (views.length - 1) : 0.5]));
    const inPlaylist = new Set(playlists.flatMap((playlist) => playlist.entries.map((entry) => entry.trackId)));

    this.tracks = new Map(available.map((track) => [track.id, track]));
    this.facts = new Map(available.map((track) => [track.id, {
      id: track.id, dupKey: dupKey(track.title, track.albumArtist, track.artist), artistKey: artistKey(track.albumArtist, track.artist),
      region: regions.get(track.id) ?? null, genre: track.genre, year: track.year, addedAt: track.lastModified,
      inPlaylist: inPlaylist.has(track.id), popularity: percentile.get(track.id) ?? null,
    }]));
    // Listens recorded while loading are already in `events` or arrive through `onListen`; keep both.
    this.events = [...events, ...this.events.filter((event) => !events.some((stored) => stored.startedAt === event.startedAt && stored.trackId === event.trackId))];
    this.profile = buildProfile(this.events, this.facts, Date.now());
  }
}

function planEntry(entry: QueueEntry): PlanEntry {
  return { entryId: entry.id, trackId: entry.track.id, suggested: Boolean(entry.suggested), pinned: Boolean(entry.pinned) };
}

function signatureOf(queue: readonly QueueEntry[], index: number): string {
  return index + '|' + queue.map((entry) => entry.id).join(',');
}
