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
      untracked(() => {
        // Turned on (by either cycle or a restored setting): the user's tracks get a fresh taste order.
        if (enabled && !this.wasEnabled) this.reorderNext = true;
        this.wasEnabled = enabled;
        if (enabled) this.schedule();
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

  /** What a cold start would play now, without touching the queue (the phone Home shows it). */
  async previewSuggestions(): Promise<Track[]> {
    await this.ensureLoaded();
    return this.coldPlan();
  }

  /** The phone Home's quick start: Smart Shuffle plays its own picks (the shown preview, if given) in place of the queue. */
  async playSuggestions(picks?: readonly Track[]): Promise<void> {
    if (this.player.modesLocked()) return;
    await this.ensureLoaded();
    this.player.setSmartShuffle(true);
    if (!picks?.length) { await this.start(true); return; }
    this.reorderNext = false;
    await this.player.startSuggestions(picks.map((track) => this.player.createSuggestedEntry(track)));
  }

  /** Only a user's turn starts playback; a setting restored at launch never does. */
  private async startIfEmpty(): Promise<void> {
    if (this.player.smartShuffle() && !this.player.queue().length) await this.start();
  }

  private async start(replaceQueue = false): Promise<void> {
    await this.ensureLoaded();
    if (!this.player.smartShuffle() || (!replaceQueue && this.player.queue().length)) return;
    const plan = this.coldPlan();
    this.reorderNext = false;
    await this.player.startSuggestions(plan.map((track) => this.player.createSuggestedEntry(track)));
  }

  private coldPlan(): Track[] {
    return planUpcoming({
      upcoming: [], recent: [], userRun: 0, every: suggestionSpacing(this.events), window: SUGGESTION_WINDOW,
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
