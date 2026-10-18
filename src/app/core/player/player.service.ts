import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { LIBRARY_GATEWAY, PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../contracts';
import { AudioEngineBackend, AudioOutputDevice, AudioPathStatus, PlaybackError, PlaybackSession, PlaybackState, PlaybackMode, QueueEntry, RepeatMode, Settings, SYSTEM_DEFAULT_OUTPUT_ID, Track, TransitionCause } from '../models';
import { getDesktopApi } from '../desktop/desktop-api';
import { logPlaybackDiagnostic } from './playback-diagnostics';
import { nextPlayableQueueIndex } from './playback-policy';

export interface QueueAddResult {
  addedCount: number;
  skippedCount: number;
}

export interface QueueSnapshot {
  queue: QueueEntry[];
  originalQueue: QueueEntry[];
  currentIndex: number;
  isShuffle: boolean;
}

/**
 * Plays tracks outside the queue (the developer roulette). While one is active the queue stays the
 * user's own: it is parked at its current entry and position and still takes Add to queue / Play next.
 */
export interface ExternalSource {
  /**
   * The track after the current one, consumed. After `peek()` it must return the peeked track.
   * Null pauses playback; the source may start a track later with `playExternal()` (a reel).
   */
  next(): Track | null;
  /** The track `next()` would return, without consuming it, so gapless and crossfade can prepare it. */
  peek(): Track | null;
  /** The track before the current one, or null at the first. */
  previous(): Track | null;
}

/** What the engine plays: the current queue entry, or the external track standing in for it. */
interface PlaybackItem {
  id: string;
  track: Track;
}

interface ExternalPlayback {
  source: ExternalSource;
  item: PlaybackItem;
  /** Where the parked queue entry resumes, in seconds. */
  resumeAt: number;
}

function normalizePlaybackFailure(error: unknown, trackId?: string): PlaybackError {
  // Native Host errors cross Electron IPC with the code carried as "[CODE] message".
  const rawCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code
    : error instanceof Error ? /\[([A-Z][A-Z0-9_]*)\]/.exec(error.message)?.[1] : undefined;
  const codes: PlaybackError['code'][] = [
    'FILE_UNAVAILABLE', 'MEDIA_ABORTED', 'MEDIA_NETWORK', 'MEDIA_DECODE', 'MEDIA_UNSUPPORTED', 'MEDIA_UNKNOWN',
    'OUTPUT_EXCLUSIVE_NOT_ALLOWED', 'OUTPUT_DEVICE_UNAVAILABLE', 'OUTPUT_DEVICE_BUSY', 'OUTPUT_FORMAT_UNSUPPORTED',
    'OUTPUT_DEVICE_PERMISSION_DENIED', 'OUTPUT_DEVICE_UNSUPPORTED', 'OUTPUT_MODE_UNSUPPORTED',
    'AUDIO_HOST_UNAVAILABLE', 'AUDIO_HOST_PROTOCOL_ERROR', 'PLAYBACK_FAILED',
  ];
  const code: PlaybackError['code'] = typeof rawCode === 'string' && codes.includes(rawCode as PlaybackError['code'])
    ? rawCode as PlaybackError['code'] : 'PLAYBACK_FAILED';
  const knownMessages: Partial<Record<PlaybackError['code'], string>> = {
    FILE_UNAVAILABLE: 'This audio file is no longer available.',
    MEDIA_ABORTED: 'Audio loading was interrupted.',
    MEDIA_NETWORK: 'The audio file could not be read.',
    MEDIA_DECODE: 'The audio file is damaged or could not be decoded.',
    MEDIA_UNSUPPORTED: 'This audio format is not supported by the current engine.',
    OUTPUT_DEVICE_UNAVAILABLE: 'The selected audio output is disconnected.',
    OUTPUT_DEVICE_BUSY: 'The selected audio output is in use. Close the other app and try again.',
    OUTPUT_EXCLUSIVE_NOT_ALLOWED: 'Windows blocks Exclusive mode for this device. Enable it in Sound settings → Device properties → Advanced.',
    OUTPUT_FORMAT_UNSUPPORTED: 'The selected audio output format is not supported.',
    OUTPUT_DEVICE_PERMISSION_DENIED: 'Chromium denied permission to use this audio output. Restart Lutstra and try again.',
    OUTPUT_DEVICE_UNSUPPORTED: 'This runtime cannot select a specific audio output.',
    OUTPUT_MODE_UNSUPPORTED: 'This output mode requires the Native Audio Host.',
    AUDIO_HOST_UNAVAILABLE: 'Native Audio Host is unavailable. Playback has returned to Chromium and remains paused.',
    AUDIO_HOST_PROTOCOL_ERROR: 'Native Audio Host communication failed. Playback has returned to Chromium and remains paused.',
    PLAYBACK_FAILED: 'The audio file could not be played.',
  };
  return { code, message: knownMessages[code] ?? 'The audio file could not be played.', trackId };
}

@Injectable({ providedIn: 'root' })
export class PlayerService implements OnDestroy {
  private readonly engine = inject(PLAYBACK_ENGINE);
  private readonly settingsGateway = inject(SETTINGS_GATEWAY, { optional: true });
  private readonly libraryGateway = inject(LIBRARY_GATEWAY, { optional: true });
  private readonly subscriptions = new Subscription();
  private restoringSettings = false;
  private volumeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private outputInterrupted: false | 'device-invalidated' | 'device-busy' = false;

  // Internal Request Counter for handling overlapping load requests
  private loadSequence = 0;
  private libraryRefreshVersion = 0;
  private preparedCandidateId: string | null = null;
  private preparationReady = false;
  private transitioning = false;
  private recoveringFromFailure = false;
  private readonly failedEntryIds = new Set<string>();
  private suspendSnapshot: { entryId: string; position: number; shouldResume: boolean } | null = null;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private savedSession: { queue: QueueEntry[]; index: number; position: number; at: number } | null = null;
  private readonly playRequested = signal(false);
  /** The user's last transport request, so the listening history can tell a skip from an automatic advance. */
  private transition: { cause: TransitionCause; at: number } | null = null;

  // Primary Signals
  readonly currentTrack = signal<Track | null>(null);
  readonly queue = signal<QueueEntry[]>([]);
  readonly currentIndex = signal<number>(-1);
  readonly playbackState = signal<PlaybackState>('idle');
  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly volume = signal<number>(0.8);
  readonly isMuted = signal<boolean>(false);
  readonly repeatMode = signal<RepeatMode>('off');
  readonly isShuffle = signal<boolean>(false);
  /**
   * Smart Shuffle (`SmartShuffleService` arranges the queue): the user's tracks in taste order with
   * suggestions (`QueueEntry.suggested`) mixed in. Exclusive with shuffle; `originalQueue` keeps the user's order.
   */
  readonly smartShuffle = signal<boolean>(false);
  /** The shuffle button's state, for its label: the button cycles Off → Shuffle → Smart Shuffle. */
  readonly shuffleState = computed(() => this.smartShuffle() ? 'Smart Shuffle' : this.isShuffle() ? 'On' : 'Off');
  /**
   * Autoplay (`SmartShuffleService` appends suggestions on the last entry): the queue keeps playing similar tracks
   * once it ends, while Smart Shuffle and repeat are off. Its suggestions stay out of `originalQueue`.
   */
  readonly autoplay = signal<boolean>(false);
  /** Who put the upcoming suggestions in the queue, for the queue's divider and screen readers. */
  readonly suggestionLabel = computed(() => this.smartShuffle() ? 'Suggested by Smart Shuffle' : 'Autoplay');
  private readonly external = signal<ExternalPlayback | null>(null);
  private externalCount = 0;
  /** The source playing outside the queue, if any. */
  readonly externalSource = computed(() => this.external()?.source ?? null);
  /**
   * True while the developer roulette picks what plays next (a queue-end handler or an external source).
   * Shuffle and repeat do not apply then: the UI hides them and playback treats repeat as off, without
   * changing the saved modes.
   */
  readonly modesLocked = computed(() => this.external() !== null);
  /** Shuffle and repeat as one control's state; `combined` only arises from the separate S and R shortcuts. */
  readonly playbackMode = computed<PlaybackMode>(() => {
    if (this.smartShuffle()) return 'smart-shuffle';
    const shuffle = this.isShuffle();
    const repeat = this.repeatMode();
    if (shuffle && repeat !== 'off') return 'combined';
    if (shuffle) return 'shuffle';
    if (repeat === 'all') return 'repeat-all';
    if (repeat === 'one') return 'repeat-one';
    return 'off';
  });
  /** Off shows the plain repeat glyph (muted by the caller); the active modes show their own. */
  readonly playbackModeIcon = computed(() => {
    const mode = this.playbackMode();
    return mode === 'repeat-one' ? 'repeat-one' as const : mode === 'smart-shuffle' ? 'smart-shuffle' as const
      : mode === 'shuffle' || mode === 'combined' ? 'shuffle' as const : 'repeat' as const;
  });
  readonly playbackModeLabel = computed(() => {
    const current = this.playbackMode();
    const names: Record<PlaybackMode, string> = {
      off: 'Off',
      shuffle: 'Shuffle',
      'smart-shuffle': 'Smart Shuffle',
      'repeat-all': 'Repeat All',
      'repeat-one': 'Repeat One',
      combined: `Shuffle and ${this.repeatMode() === 'one' ? 'Repeat One' : 'Repeat All'}`,
    };
    const next = current === 'off' ? 'Shuffle'
      : current === 'shuffle' ? 'Smart Shuffle'
      : current === 'smart-shuffle' ? 'Repeat All'
      : current === 'repeat-all' ? 'Repeat One' : 'Off';
    return `Playback mode: ${names[current]}. Click for ${next}`;
  });
  /** Smart Shuffle never runs out of tracks, so repeat does not apply while it is on either. */
  private readonly activeRepeat = computed<RepeatMode>(() => this.modesLocked() || this.smartShuffle() ? 'off' : this.repeatMode());
  readonly crossfadeEnabled = signal<boolean>(true);
  readonly crossfadeSeconds = signal<number>(5);
  readonly error = signal<string | null>(null);
  readonly playbackNotice = signal<string | null>(null);
  readonly outputDevices = signal<AudioOutputDevice[]>([]);
  readonly audioPathStatus = signal<AudioPathStatus | null>(null);
  readonly audioEngineBackend = signal<AudioEngineBackend>('chromium');
  readonly preferredAudioOutputId = signal<string>(SYSTEM_DEFAULT_OUTPUT_ID);
  readonly preferredAudioOutputName = signal<string>('System Default');
  private readonly preferredChromiumOutputId = signal<string>(SYSTEM_DEFAULT_OUTPUT_ID);
  private readonly preferredChromiumOutputName = signal<string>('System Default');
  private readonly preferredNativeOutputId = signal<string>(SYSTEM_DEFAULT_OUTPUT_ID);
  private readonly preferredNativeOutputName = signal<string>('System Default');
  readonly outputMode = signal<'shared' | 'exclusive-dsp'>('shared');
  readonly exclusiveBufferMs = signal(20);
  readonly exclusiveModeDisabledReason = computed(() => {
    if (this.audioEngineBackend() !== 'native-shared') return 'Exclusive requires Native Shared.';
    const device = this.outputDevices().find(d => d.id === this.preferredAudioOutputId());
    return device?.supportedModes.includes('exclusive-dsp') ? null : 'The selected device does not report Exclusive support.';
  });
  readonly audioOutputFallbackEnabled = signal<boolean>(false);

  // Original queue before shuffle was toggled on
  private originalQueue: QueueEntry[] = [];

  // Derived Computed Signals
  readonly isPlaying = computed(() => this.playbackState() === 'playing');
  readonly isLoading = computed(() => this.playbackState() === 'loading');
  readonly isPlaybackActive = computed(() => this.isPlaying() || this.playbackState() === 'buffering' || (this.isLoading() && this.playRequested()));

  readonly currentQueueEntry = computed<QueueEntry | null>(() => {
    const q = this.queue();
    const idx = this.currentIndex();
    return idx >= 0 && idx < q.length ? q[idx] : null;
  });

  private readonly currentItem = computed<PlaybackItem | null>(() => this.external()?.item ?? this.currentQueueEntry());

  readonly progressPercent = computed<number>(() => {
    const d = this.duration();
    const c = this.currentTime();
    return d > 0 ? Math.min(100, Math.max(0, (c / d) * 100)) : 0;
  });

  constructor() {
    this.initEngineListeners();
    this.subscriptions.add(this.engine.subscribeDeviceChanges(() => void this.handleOutputDevicesChanged()));
    const interrupted = this.engine.outputInterrupted$;
    if (interrupted) {
      this.subscriptions.add(interrupted.subscribe((reason) => {
        this.outputInterrupted = reason;
        this.playbackNotice.set(reason === 'device-busy'
          ? 'The selected audio output is in use. Playback has been paused.'
          : 'The audio output was interrupted. Lutstra is reconnecting.');
      }));
    }
    const advanced = this.engine.trackAutoAdvanced$;
    if (advanced) this.subscriptions.add(advanced.subscribe((track) => this.handleTrackAutoAdvanced(track)));
    const lifecycle = getDesktopApi()?.appLifecycle;
    if (lifecycle) {
      this.subscriptions.add(lifecycle.onSuspend(() => this.handleSuspend()));
      this.subscriptions.add(lifecycle.onResume(() => void this.handleResume()));
    }
    void this.loadSavedSettings().then(() => this.restoreSession());
    let wasScanning = false;
    if (this.libraryGateway) this.subscriptions.add(this.libraryGateway.scanProgress$.subscribe((progress) => {
      const justFinished = wasScanning && !progress.isScanning;
      wasScanning = progress.isScanning;
      if (justFinished) void this.refreshArtwork();
    }));
    if (this.libraryGateway?.libraryChanged$) {
      this.subscriptions.add(this.libraryGateway.libraryChanged$.subscribe(() => void this.reconcileLibrary()));
    }
  }

  private async reconcileLibrary(): Promise<void> {
    if (!this.libraryGateway) return;
    const version = ++this.libraryRefreshVersion;
    try {
      const tracks = new Map((await this.libraryGateway.getLibrary()).tracks.map((track) => [track.id, track]));
      if (version !== this.libraryRefreshVersion) return;
      const currentEntry = this.currentQueueEntry();
      const previousIndex = this.currentIndex();
      const shouldContinue = this.isPlaybackActive();
      const keep = (entry: QueueEntry): QueueEntry | null => {
        const track = tracks.get(entry.track.id);
        return track ? { ...entry, track } : null;
      };
      const nextQueue = this.queue().flatMap((entry) => keep(entry) ?? []);
      this.originalQueue = this.originalQueue.flatMap((entry) => keep(entry) ?? []);
      this.queue.set(nextQueue);
      this.failedEntryIds.clear();
      const currentIndex = currentEntry ? nextQueue.findIndex((entry) => entry.id === currentEntry.id) : -1;
      if (this.external()) {
        // The engine plays the external track: only the parked queue entry moves.
        if (currentEntry && currentIndex < 0) this.parkAt(nextQueue.length ? Math.min(Math.max(previousIndex, 0), nextQueue.length - 1) : -1);
        else this.currentIndex.set(currentIndex);
      } else if (currentEntry && currentIndex < 0) {
        this.loadSequence++;
        this.clearPreparedCandidate();
        // pause, not dispose: dispose is terminal for the native and switching engines.
        this.engine.pause();
        this.currentTime.set(0);
        this.duration.set(0);
        const replacementIndex = nextQueue.length ? Math.min(Math.max(previousIndex, 0), nextQueue.length - 1) : -1;
        this.currentIndex.set(replacementIndex);
        if (replacementIndex >= 0) {
          this.playbackNotice.set('The current track is no longer available. Moving to the next available track.');
          if (shouldContinue) await this.loadAndPlayCurrent();
          else await this.loadCurrentPaused();
        } else {
          this.playRequested.set(false);
          this.currentTrack.set(null);
          this.error.set(null);
          this.playbackState.set('idle');
        }
      } else if (currentIndex >= 0) {
        this.currentTrack.set(nextQueue[currentIndex].track);
        this.currentIndex.set(currentIndex);
        this.refreshPreparedCandidate();
      }
    } catch (error) {
      logPlaybackDiagnostic('error', { operation: 'transition', errorCode: 'PLAYBACK_FAILED' });
    }
  }

  private async refreshArtwork(): Promise<void> {
    if (!this.libraryGateway) return;
    try {
      const artworkById = new Map((await this.libraryGateway.getLibrary()).tracks.map((track) => [track.id, track.artwork]));
      const updateEntry = (entry: QueueEntry): QueueEntry => artworkById.has(entry.track.id)
        ? { ...entry, track: { ...entry.track, artwork: artworkById.get(entry.track.id) ?? null } } : entry;
      this.queue.update((entries) => entries.map(updateEntry));
      this.originalQueue = this.originalQueue.map(updateEntry);
      this.currentTrack.update((track) => track && artworkById.has(track.id)
        ? { ...track, artwork: artworkById.get(track.id) ?? null } : track);
    } catch { /* A scan refresh must not interrupt playback. */ }
  }

  ngOnDestroy(): void {
    this.loadSequence++;
    if (this.volumeSaveTimer) clearTimeout(this.volumeSaveTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.subscriptions.unsubscribe();
    this.engine.dispose();
  }

  async loadSavedSettings(): Promise<void> {
    if (!this.settingsGateway) return;
    try {
      this.restoringSettings = true;
      const settings = await this.settingsGateway.getSettings();
      if (settings) {
        if (typeof settings.defaultVolume === 'number') {
          this.setVolume(settings.defaultVolume);
        }
        if (settings.repeatMode) {
          this.setRepeatMode(settings.repeatMode);
        }
        if (typeof settings.shuffle === 'boolean') {
          this.setShuffle(settings.shuffle);
        }
        if (settings.smartShuffle === true) this.setSmartShuffle(true);
        if (typeof settings.autoplay === 'boolean') this.autoplay.set(settings.autoplay);
        if (typeof settings.crossfadeEnabled === 'boolean') this.setCrossfadeEnabled(settings.crossfadeEnabled);
        if (Number.isInteger(settings.crossfadeSeconds)) this.setCrossfadeSeconds(settings.crossfadeSeconds);
        this.outputMode.set(settings.outputMode === 'exclusive-dsp' ? 'exclusive-dsp' : 'shared');
        this.exclusiveBufferMs.set([10,20,40,80].includes(settings.exclusiveBufferMs) ? settings.exclusiveBufferMs : 20);
        this.audioOutputFallbackEnabled.set(settings.audioOutputFallbackEnabled === true);
        this.engine.setOutputFallbackEnabled(settings.audioOutputFallbackEnabled === true);
        this.preferredChromiumOutputId.set(settings.preferredAudioOutputId || SYSTEM_DEFAULT_OUTPUT_ID);
        this.preferredChromiumOutputName.set(settings.preferredAudioOutputName || 'System Default');
        this.preferredNativeOutputId.set(settings.preferredNativeAudioOutputId || SYSTEM_DEFAULT_OUTPUT_ID);
        this.preferredNativeOutputName.set(settings.preferredNativeAudioOutputName || 'System Default');
        try { await this.engine.setBackend(settings.audioEngineBackend === 'native-shared' ? 'native-shared' : 'chromium'); }
        catch {
          await this.engine.setBackend('chromium');
          this.playbackNotice.set('Native Audio Host is unavailable. Chromium Shared remains active.');
        }
        this.audioEngineBackend.set(this.engine.getBackend());
        await this.restoreOutputMode();
        await this.syncNativeMediaKeys();
        if (this.audioEngineBackend() === 'native-shared') await this.migrateNativeDeviceByUniqueName();
        this.syncPreferredOutputSignals();
        try {
          await this.engine.selectOutputDevice(this.preferredAudioOutputId());
        } catch {
          this.playbackNotice.set('The preferred audio output is currently unavailable.');
        }
        await this.refreshAudioOutputState();
      }
    } catch {
      // Retain default values
    } finally {
      this.restoringSettings = false;
    }
  }

  /**
   * Reloads the last run's queue, paused at its position (never playing), then keeps it saved.
   * Saving runs throughout because the main process closes the database as soon as the app quits.
   */
  private async restoreSession(): Promise<void> {
    try {
      const session = await this.settingsGateway?.getSession();
      if (session && !this.queue().length && this.libraryGateway) {
        const tracks = new Map((await this.libraryGateway.getLibrary()).tracks.map((track) => [track.id, track]));
        if (!this.queue().length) await this.applySession(session, tracks);
      }
    } catch { /* Start with an empty queue. */ }
    if (!this.subscriptions.closed) this.sessionTimer = setInterval(() => this.saveSession(), 1000);
  }

  private async applySession(session: PlaybackSession, tracks: Map<string, Track>): Promise<void> {
    // Tracks gone from the library are dropped; a missing current track hands over to the next one, from the start.
    const kept = session.trackIds.flatMap((id, index) => tracks.has(id) ? [index] : []);
    if (!kept.length) return;
    const suggested = new Set(session.suggested ?? []);
    const entries = kept.map((old, index) => {
      const entry = this.createQueueEntry(tracks.get(session.trackIds[old])!, index);
      return suggested.has(old) ? { ...entry, suggested: true } : entry;
    });
    const newIndex = new Map(kept.map((old, index) => [old, index]));
    const next = kept.findIndex((old) => old >= session.currentIndex);
    const index = session.currentIndex < 0 ? -1 : next >= 0 ? next : kept.length - 1;
    const position = index >= 0 && kept[index] === session.currentIndex ? session.positionSeconds : 0;
    this.queue.set(entries);
    this.originalQueue = session.originalOrder.flatMap((old) => newIndex.has(old) && !suggested.has(old) ? [entries[newIndex.get(old)!]] : []);
    this.currentIndex.set(index);
    if (index < 0) return;
    // A file that is gone shows as unavailable instead of skipping ahead.
    await this.loadCurrentPaused(false);
    if (position > 0 && this.playbackState() === 'paused' && this.currentQueueEntry() === entries[index]) {
      this.engine.seek(position);
      this.currentTime.set(position);
    }
  }

  /** Saves on a queue change, and the position on a change, at most every 5 seconds while playing. */
  private saveSession(): void {
    if (!this.settingsGateway) return;
    const queue = this.queue();
    const index = this.currentIndex();
    const external = this.external();
    // While the roulette plays, the parked queue entry and its resume point are what to keep.
    const position = Math.floor(external ? external.resumeAt : index >= 0 ? this.currentTime() : 0);
    const now = Date.now();
    const last = this.savedSession;
    if (last && last.queue === queue && last.index === index
      && (last.position === position || (this.isPlaybackActive() && now - last.at < 5000))) return;
    this.savedSession = { queue, index, position, at: now };
    const positions = new Map(queue.map((entry, i) => [entry.id, i]));
    // Smart Shuffle keeps only the user's tracks in the original order; its suggestions follow at the end.
    const order = [...this.originalQueue, ...queue.filter((entry) => entry.suggested && !this.originalQueue.includes(entry))]
      .map((entry) => positions.get(entry.id) ?? -1);
    const originalOrder = order.length === queue.length && new Set(order).size === order.length && !order.includes(-1)
      ? order : queue.map((_, i) => i);
    const suggested = queue.flatMap((entry, i) => entry.suggested ? [i] : []);
    const session = { trackIds: queue.map((entry) => entry.track.id), originalOrder, currentIndex: index, positionSeconds: position };
    try {
      void this.settingsGateway.saveSession(suggested.length ? { version: 2, ...session, suggested } : { version: 1, ...session })
        .catch(() => undefined);
    } catch { /* A gateway without sessions keeps nothing. */ }
  }

  private initEngineListeners(): void {
    // 1. State change stream
    this.subscriptions.add(
      this.engine.stateChange$.subscribe((evt) => {
        // Late arrival check: if queue is empty and no current track, stay idle
        if (this.queue().length === 0 && !this.currentTrack()) {
          this.playbackState.set('idle');
          return;
        }

        this.playbackState.set(evt.state);
        if (evt.error) {
          this.playRequested.set(false);
          this.error.set(evt.error.message);
          // A busy output is still awaited: the host reports when the other app releases it.
          if (evt.error.code === 'OUTPUT_DEVICE_UNAVAILABLE') this.outputInterrupted = false;
          if (evt.error.code === 'AUDIO_HOST_UNAVAILABLE' || evt.error.code === 'AUDIO_HOST_PROTOCOL_ERROR') void this.recoverFromNativeHostFailure(evt.error);
          else void this.handlePlaybackFailure(evt.error);
        } else if (evt.state === 'playing') {
          this.error.set(null);
          if (this.outputInterrupted) {
            this.outputInterrupted = false;
            this.playbackNotice.set(null);
          }
          this.refreshPreparedCandidate();
        }

        if (evt.state === 'playing' || evt.state === 'paused') void this.refreshAudioOutputState().catch(() => undefined);
        if (evt.state === 'ended') {
          this.handleTrackEnded();
        }
      })
    );

    // 2. Time update stream
    this.subscriptions.add(
      this.engine.timeUpdate$.subscribe((evt) => {
        if (this.queue().length === 0 && !this.currentTrack()) {
          this.currentTime.set(0);
          this.duration.set(0);
          return;
        }
        this.currentTime.set(evt.currentTime);
        this.duration.set(evt.duration);
        this.refreshPreparedCandidate();
        this.maybeStartCrossfade(evt.currentTime, evt.duration);
      })
    );

    // 3. Volume change stream
    this.subscriptions.add(
      this.engine.volumeChange$.subscribe((evt) => {
        this.volume.set(evt.volume);
        this.isMuted.set(evt.isMuted);
        if (this.audioEngineBackend() === 'native-shared') {
          void this.engine.getAudioPathStatus().then(status => {
            if (this.audioEngineBackend() === 'native-shared') this.audioPathStatus.set(status);
          }).catch(() => undefined);
        }
      })
    );
  }

  // ==========================================
  // Queue & Playback Initialization
  // ==========================================

  /**
   * Starts playing a track from a collection.
   * Replaces queue with a fresh copy of the collection with unique entry IDs.
   */
  /** The cause of the latest user transport request, with when it was made (ms). */
  lastTransition(): { cause: TransitionCause; at: number } | null {
    return this.transition;
  }

  private markTransition(cause: TransitionCause): void {
    this.transition = { cause, at: Date.now() };
  }

  async playCollection(tracks: Track[], startIndex: number = 0): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    if (!tracks || tracks.length === 0) {
      return;
    }
    this.markTransition('user');

    const safeIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const entries = this.createQueueEntries(tracks);
    this.failedEntryIds.clear();
    // Playing something from the library ends any external source (the roulette).
    this.external.set(null);

    this.originalQueue = [...entries];

    if (this.isShuffle() || this.smartShuffle()) {
      // Smart Shuffle orders the rest itself once the queue changes.
      const selected = entries[safeIndex];
      const others = entries.filter((_, idx) => idx !== safeIndex);
      const shuffledOthers = this.smartShuffle() ? others : this.shuffleArray(others);
      const newQueue = [selected, ...shuffledOthers];
      this.queue.set(newQueue);
      this.currentIndex.set(0);
    } else {
      this.queue.set(entries);
      this.currentIndex.set(safeIndex);
    }

    await this.loadAndPlayCurrent();
  }

  /**
   * Play an individual track. If queue is empty, creates a single-track queue.
   * If already in queue, jumps to it. Otherwise appends to queue and plays it.
   */
  async playTrack(track: Track): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    this.markTransition('user');
    this.external.set(null);
    const q = this.queue();
    const existingIndex = q.findIndex((e) => e.track.id === track.id);

    if (existingIndex >= 0) {
      this.failedEntryIds.delete(q[existingIndex].id);
      this.currentIndex.set(existingIndex);
      await this.loadAndPlayCurrent();
      return;
    }

    const newEntry = this.createQueueEntry(track, q.length);
    this.queue.update((current) => [...current, newEntry]);
    this.originalQueue.push(newEntry);
    this.currentIndex.set(this.queue().length - 1);
    await this.loadAndPlayCurrent();
  }

  // ==========================================
  // Transport Controls
  // ==========================================

  async togglePlayPause(): Promise<void> {
    if (!this.currentTrack()) {
      const q = this.queue();
      if (q.length > 0) {
        this.currentIndex.set(0);
        await this.loadAndPlayCurrent();
      }
      return;
    }

    if (this.isPlaybackActive()) {
      this.pause();
    } else {
      await this.play();
    }
  }

  async play(): Promise<void> {
    if (this.isPlaybackActive()) return;

    if (!this.currentTrack()) {
      const q = this.queue();
      if (q.length === 0) return;
      this.currentIndex.set(0);
      await this.loadAndPlayCurrent();
      return;
    }

    this.playRequested.set(true);
    try {
      await this.engine.play();
    } catch (error) {
      this.playRequested.set(false);
      const failure = normalizePlaybackFailure(error, this.currentTrack()?.id);
      this.error.set(failure.message);
      await this.handlePlaybackFailure(failure);
    }
  }

  pause(): void {
    if (!this.isPlaybackActive()) return;
    this.playRequested.set(false);
    this.engine.pause();
    if (this.playbackState() === 'loading') this.playbackState.set('paused');
  }

  seek(positionSeconds: number): void {
    if (!Number.isFinite(positionSeconds)) return;
    const duration = this.duration();
    const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    this.engine.seek(Math.max(0, Math.min(positionSeconds, upperBound)));
  }

  seekBy(offsetSeconds: number): void {
    if (!Number.isFinite(offsetSeconds)) return;
    this.seek(this.currentTime() + offsetSeconds);
  }

  stop(): void {
    this.pause();
    if (this.currentTrack()) this.seek(0);
  }

  setVolume(newVolume: number): void {
    const clamped = Math.max(0, Math.min(1, newVolume));
    this.engine.setVolume(clamped);
    if (this.isMuted() && clamped > 0) {
      this.engine.setMute(false);
    }
    if (!this.restoringSettings) {
      if (this.volumeSaveTimer) clearTimeout(this.volumeSaveTimer);
      this.volumeSaveTimer = setTimeout(() => void this.persistSettings({ defaultVolume: clamped }), 250);
    }
  }

  toggleMute(): void {
    const nextMuted = !this.isMuted();
    this.engine.setMute(nextMuted);
  }

  setRepeatMode(mode: RepeatMode): void {
    this.repeatMode.set(mode);
    this.refreshPreparedCandidate();
    if (!this.restoringSettings) void this.persistSettings({ repeatMode: mode });
  }

  cycleRepeatMode(): void {
    const current = this.repeatMode();
    if (current === 'off') {
      this.setRepeatMode('all');
    } else if (current === 'all') {
      this.setRepeatMode('one');
    } else {
      this.setRepeatMode('off');
    }
  }

  /** Off → Shuffle → Repeat All → Repeat One → Off. */
  /** Off → Shuffle → Smart Shuffle → Repeat All → Repeat One → Off (`SmartShuffleService.cyclePlaybackMode` starts suggestions on an empty queue). */
  cyclePlaybackMode(): void {
    const current = this.playbackMode();
    if (current === 'shuffle') {
      this.setSmartShuffle(true);
      return;
    }
    const next = current === 'off' ? { shuffle: true, repeat: 'off' as const }
      : current === 'smart-shuffle' ? { shuffle: false, repeat: 'all' as const }
      : current === 'repeat-all' ? { shuffle: false, repeat: 'one' as const }
      : { shuffle: false, repeat: 'off' as const };
    if (this.smartShuffle()) this.setSmartShuffle(false);
    if (this.isShuffle() !== next.shuffle) this.setShuffle(next.shuffle);
    if (this.repeatMode() !== next.repeat) this.setRepeatMode(next.repeat);
  }

  /** The shuffle button and S: Off → Shuffle → Smart Shuffle → Off. */
  cycleShuffle(): void {
    if (this.smartShuffle()) this.setSmartShuffle(false);
    else if (this.isShuffle()) this.setSmartShuffle(true);
    else this.setShuffle(true);
  }

  setShuffle(enabled: boolean): void {
    if (this.isShuffle() !== enabled) {
      this.toggleShuffle();
    }
  }

  setSmartShuffle(enabled: boolean): void {
    if (this.smartShuffle() === enabled) return;
    if (enabled) {
      if (this.isShuffle()) this.toggleShuffle();
      this.originalQueue = this.queue().filter((entry) => !entry.suggested);
    } else {
      this.restoreFromSmartShuffle();
    }
    this.smartShuffle.set(enabled);
    if (!this.restoringSettings) void this.persistSettings({ smartShuffle: enabled });
  }

  /**
   * Back to the user's order: suggestions not played yet leave the queue; played ones stay where they
   * were heard, after the entry before them.
   */
  private restoreFromSmartShuffle(): void {
    const queue = this.queue();
    const current = this.currentQueueEntry();
    const restored = this.originalQueue.filter((entry) => queue.includes(entry));
    const index = this.currentIndex();
    queue.forEach((entry, position) => {
      if (!entry.suggested || position > index || restored.includes(entry)) return;
      const before = queue.slice(0, position).reverse().find((item) => restored.includes(item));
      restored.splice(before ? restored.indexOf(before) + 1 : 0, 0, entry);
    });
    const kept = restored.map((entry) => entry.suggested ? { ...entry, suggested: false } : entry);
    this.queue.set(kept);
    this.originalQueue = [...kept];
    if (current) this.currentIndex.set(restored.indexOf(current));
    this.refreshPreparedCandidate();
  }

  /** Smart Shuffle's arrangement of everything after the current entry. */
  replaceUpcoming(entries: QueueEntry[]): void {
    const index = this.currentIndex();
    this.queue.set([...this.queue().slice(0, index + 1), ...entries]);
    this.refreshPreparedCandidate();
  }

  /** Autoplay's next suggestions, after everything queued. */
  appendSuggestions(entries: QueueEntry[]): void {
    if (!entries.length) return;
    this.queue.set([...this.queue(), ...entries]);
    this.refreshPreparedCandidate();
  }

  /** Turning Autoplay off drops the suggestions not played yet; Smart Shuffle keeps its own. */
  setAutoplay(enabled: boolean): void {
    this.autoplay.set(enabled);
    if (!enabled && !this.smartShuffle()) {
      const index = this.currentIndex();
      const kept = this.queue().filter((entry, i) => i <= index || !entry.suggested);
      if (kept.length !== this.queue().length) {
        this.queue.set(kept);
        this.refreshPreparedCandidate();
      }
    }
    void this.persistSettings({ autoplay: enabled });
  }

  /** Smart Shuffle turned on with nothing queued: plays its suggestions from the first. */
  async startSuggestions(entries: QueueEntry[]): Promise<void> {
    if (!entries.length || this.blockedByBusyOutput()) return;
    this.markTransition('user');
    this.external.set(null);
    this.failedEntryIds.clear();
    this.queue.set(entries);
    this.originalQueue = [];
    this.currentIndex.set(0);
    await this.loadAndPlayCurrent();
  }

  createSuggestedEntry(track: Track): QueueEntry {
    return { ...this.createQueueEntry(track, -1), suggested: true };
  }

  toggleShuffle(): void {
    if (!this.isShuffle() && this.smartShuffle()) this.setSmartShuffle(false);
    const nextShuffle = !this.isShuffle();
    this.isShuffle.set(nextShuffle);
    if (!this.restoringSettings) void this.persistSettings({ shuffle: nextShuffle });

    const q = this.queue();
    const currentEntry = this.currentQueueEntry();

    if (nextShuffle) {
      // Turn Shuffle ON: Autoplay's suggestions are not the user's tracks; they stay after them.
      this.originalQueue = q.filter((e) => !e.suggested);
      const autoplayed = q.filter((e) => e.suggested && e !== currentEntry);
      if (currentEntry) {
        const others = q.filter((e) => e !== currentEntry && !e.suggested);
        const shuffled = [currentEntry, ...this.shuffleArray(others), ...autoplayed];
        this.queue.set(shuffled);
        this.currentIndex.set(0);
      } else {
        this.queue.set([...this.shuffleArray(this.originalQueue), ...autoplayed]);
      }
    } else {
      // Turn Shuffle OFF: restore original order
      if (this.originalQueue.length > 0) {
        // Autoplay's suggestions are not in the original order; they stay at the end.
        const restored = [...this.originalQueue, ...q.filter((e) => e.suggested && !this.originalQueue.includes(e))];
        this.queue.set(restored);
        if (currentEntry) {
          const restoredIndex = restored.findIndex((e) => e.id === currentEntry.id);
          this.currentIndex.set(restoredIndex >= 0 ? restoredIndex : 0);
        }
      }
    }
    this.refreshPreparedCandidate();
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.crossfadeEnabled.set(enabled);
    this.refreshPreparedCandidate();
    if (!this.restoringSettings) void this.persistSettings({ crossfadeEnabled: enabled });
  }

  setCrossfadeSeconds(seconds: number): void {
    if (!Number.isInteger(seconds)) return;
    const clamped = Math.max(1, Math.min(12, seconds));
    this.crossfadeSeconds.set(clamped);
    this.refreshPreparedCandidate();
    if (!this.restoringSettings) void this.persistSettings({ crossfadeSeconds: clamped });
  }

  async refreshAudioOutputState(): Promise<void> {
    const [devices, status] = await Promise.all([
      this.engine.listOutputDevices(),
      this.engine.getAudioPathStatus(),
    ]);
    const preferredId = this.preferredAudioOutputId();
    if (preferredId !== SYSTEM_DEFAULT_OUTPUT_ID && !devices.some((device) => device.id === preferredId)) {
      devices.push({
        id: preferredId,
        name: this.preferredAudioOutputName(),
        isDefault: false,
        isConnected: false,
        supportedModes: ['shared'],
        supportedFormats: null,
        mixFormat: null,
      });
    }
    this.outputDevices.set(devices);
    this.audioPathStatus.set({ ...status, preferredDeviceId: preferredId, deviceName: this.preferredAudioOutputName() });
  }

  async selectAudioOutput(deviceId: string): Promise<void> {
    const device = this.outputDevices().find((candidate) => candidate.id === deviceId);
    const previousId = this.preferredAudioOutputId();
    try {
      await this.engine.selectOutputDevice(deviceId);
      this.preferredAudioOutputId.set(deviceId);
      this.preferredAudioOutputName.set(device?.name || (deviceId === SYSTEM_DEFAULT_OUTPUT_ID ? 'System Default' : 'Audio output'));
      this.playbackNotice.set(null);
      this.outputInterrupted = false;
      if (this.audioEngineBackend() === 'native-shared') {
        this.preferredNativeOutputId.set(this.preferredAudioOutputId());
        this.preferredNativeOutputName.set(this.preferredAudioOutputName());
        await this.persistSettings({ preferredNativeAudioOutputId: this.preferredAudioOutputId(), preferredNativeAudioOutputName: this.preferredAudioOutputName() });
      } else {
        this.preferredChromiumOutputId.set(this.preferredAudioOutputId());
        this.preferredChromiumOutputName.set(this.preferredAudioOutputName());
        await this.persistSettings({ preferredAudioOutputId: this.preferredAudioOutputId(), preferredAudioOutputName: this.preferredAudioOutputName() });
      }
    } catch (error) {
      if (this.audioEngineBackend() !== 'native-shared') {
        try { await this.engine.selectOutputDevice(previousId); } catch { /* Keep playback paused if the previous output also disappeared. */ }
      }
      this.playbackNotice.set(normalizePlaybackFailure(error).message);
    }
    await this.refreshAudioOutputState();
  }

  private async restoreOutputMode(): Promise<void> {
    if (this.audioEngineBackend() === 'native-shared')
      await this.engine.setOutputMode(this.outputMode(), this.exclusiveBufferMs());
    else if (this.outputMode() === 'exclusive-dsp')
      this.playbackNotice.set('Exclusive requires Native Audio Host. Chromium Shared is active; your Exclusive preference is saved.');
  }

  async setAudioOutputMode(mode: 'shared' | 'exclusive-dsp', bufferMs = this.exclusiveBufferMs()): Promise<void> {
    if ((mode === 'exclusive-dsp' && this.exclusiveModeDisabledReason()) || ![10,20,40,80].includes(bufferMs)) return;
    this.clearPreparedCandidate();
    try {
      await this.engine.setOutputMode(mode, bufferMs);
      this.outputMode.set(mode);
      this.exclusiveBufferMs.set(bufferMs);
      await this.persistSettings({ outputMode: mode, exclusiveBufferMs: bufferMs });
      this.playbackNotice.set(null);
      this.refreshPreparedCandidate();
    } catch (error) {
      this.playRequested.set(false);
      this.playbackState.set('paused');
      this.playbackNotice.set(normalizePlaybackFailure(error).message);
    }
    await this.refreshAudioOutputState();
  }

  setAudioOutputFallbackEnabled(enabled: boolean): void {
    this.audioOutputFallbackEnabled.set(enabled);
    this.engine.setOutputFallbackEnabled(enabled);
    void this.persistSettings({ audioOutputFallbackEnabled: enabled });
  }

  async switchAudioBackend(backend: AudioEngineBackend, persist = true): Promise<void> {
    if (backend === this.audioEngineBackend()) return;
    const track = this.currentTrack();
    const position = this.currentTime();
    this.pause();
    this.clearPreparedCandidate();
    try {
      await this.engine.setBackend(backend);
      this.audioEngineBackend.set(backend);
      await this.restoreOutputMode();
      await this.syncNativeMediaKeys();
      if (backend === 'native-shared') await this.migrateNativeDeviceByUniqueName();
      this.syncPreferredOutputSignals();
      this.engine.setOutputFallbackEnabled(this.audioOutputFallbackEnabled());
      await this.engine.selectOutputDevice(this.preferredAudioOutputId());
      if (track) {
        await this.engine.load(track);
        this.engine.seek(position);
        this.playbackState.set('paused');
      }
      this.outputInterrupted = false;
      if (persist) await this.persistSettings({ audioEngineBackend: backend });
      this.playbackNotice.set(backend === 'native-shared' ? 'Native Audio Host is active. Playback remains paused.' : this.outputMode() === 'exclusive-dsp' ? 'Exclusive requires Native Audio Host. Chromium Shared is active; your Exclusive preference is saved.' : 'Chromium Shared is active. Playback remains paused.');
    } catch (error) {
      const failure = normalizePlaybackFailure(error);
      if (backend === 'native-shared' && (failure.code === 'AUDIO_HOST_UNAVAILABLE' || failure.code === 'AUDIO_HOST_PROTOCOL_ERROR')) {
        await this.engine.setBackend('chromium');
        this.audioEngineBackend.set('chromium');
        await this.syncNativeMediaKeys();
        this.syncPreferredOutputSignals();
      }
      this.playRequested.set(false);
      this.playbackState.set('paused');
      this.playbackNotice.set(this.audioEngineBackend() === 'chromium' && this.outputMode() === 'exclusive-dsp'
        ? 'Exclusive requires Native Audio Host. Chromium Shared is active; your Exclusive preference is saved.' : failure.message);
    }
    await this.refreshAudioOutputState();
  }

  private syncPreferredOutputSignals(): void {
    const native = this.audioEngineBackend() === 'native-shared';
    this.preferredAudioOutputId.set(native ? this.preferredNativeOutputId() : this.preferredChromiumOutputId());
    this.preferredAudioOutputName.set(native ? this.preferredNativeOutputName() : this.preferredChromiumOutputName());
  }

  private async migrateNativeDeviceByUniqueName(): Promise<void> {
    if (this.preferredNativeOutputId() !== SYSTEM_DEFAULT_OUTPUT_ID || this.preferredChromiumOutputId() === SYSTEM_DEFAULT_OUTPUT_ID) return;
    const chromiumName = this.preferredChromiumOutputName().trim();
    const matches = (await this.engine.listOutputDevices()).filter((device) => !device.isDefault && device.isConnected && device.name.trim() === chromiumName);
    if (matches.length === 1) {
      this.preferredNativeOutputId.set(matches[0].id);
      this.preferredNativeOutputName.set(matches[0].name);
      await this.persistSettings({ preferredNativeAudioOutputId: matches[0].id, preferredNativeAudioOutputName: matches[0].name });
    } else if (matches.length > 1) {
      this.playbackNotice.set('More than one native endpoint has the previous device name. Select the WASAPI output again.');
    }
  }

  private async recoverFromNativeHostFailure(error: PlaybackError): Promise<void> {
    if (this.audioEngineBackend() !== 'native-shared') return;
    const position = this.currentTime();
    const track = this.currentTrack();
    try {
      await this.engine.setBackend('chromium');
      this.audioEngineBackend.set('chromium');
      await this.syncNativeMediaKeys();
      this.syncPreferredOutputSignals();
      await this.engine.selectOutputDevice(this.preferredAudioOutputId());
      if (track) { await this.engine.load(track); this.engine.seek(position); this.engine.pause(); }
      await this.persistSettings({ audioEngineBackend: 'chromium' });
    } catch { /* Stay paused and require an explicit output selection. */ }
    this.playbackNotice.set(this.outputMode() === 'exclusive-dsp' ? 'Exclusive requires Native Audio Host. Chromium Shared is active; your Exclusive preference is saved.' : normalizePlaybackFailure(error).message);
    await this.refreshAudioOutputState();
  }

  private async persistSettings(value: Partial<Settings>): Promise<void> {
    if (!this.settingsGateway) return;
    try {
      await this.settingsGateway.saveSettings(value);
    } catch (error) {
      logPlaybackDiagnostic('error', { operation: 'transition', errorCode: 'PLAYBACK_FAILED' });
    }
  }

  private async syncNativeMediaKeys(): Promise<void> {
    try {
      await getDesktopApi()?.mediaKeys?.setNativeActive(this.audioEngineBackend() === 'native-shared');
    } catch {
      // Media keys remain available through Chromium Media Session when supported.
    }
  }

  /**
   * User clicks Next:
   * "Repeat one lặp khi ended; Next vẫn chuyển bài."
   * Skips unavailable tracks. Stops after 1 loop if none playable.
   */
  async next(): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    this.markTransition('next');
    await this.advance();
  }

  /** Moves to the next playable item; `next()` without marking a user skip, for automatic advances. */
  private async advance(): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    const external = this.external();
    if (external) {
      const track = external.source.next();
      if (track) await this.startExternal(external.source, track);
      else this.pause();
      return;
    }
    const q = this.queue();
    if (q.length === 0) return;

    let nextIndex = this.currentIndex() + 1;

    if (nextIndex >= q.length) {
      if (this.activeRepeat() === 'all') {
        nextIndex = 0;
      } else {
        // End of queue in repeat 'off' or 'one'
        this.pause();
        return;
      }
    }

    // Skip unavailable tracks safely (max 1 full loop)
    let attempts = 0;
    while (!this.isEntryPlayable(q[nextIndex]) && attempts < q.length) {
      nextIndex++;
      attempts++;
      if (nextIndex >= q.length) {
        if (this.activeRepeat() === 'all') {
          nextIndex = 0;
        } else {
          this.pause();
          return;
        }
      }
    }

    if (attempts >= q.length) {
      this.error.set('No available tracks in queue');
      this.pause();
      return;
    }

    this.currentIndex.set(nextIndex);
    await this.loadAndPlayCurrent();
  }

  /**
   * User clicks Previous:
   * "Previous về đầu bài nếu current time trên 3 giây; nếu không, về bài trước. Ở đầu queue chỉ quay vòng khi repeat all."
   */
  async previous(): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    this.markTransition('previous');
    const external = this.external();
    if (external) {
      const track = this.currentTime() > 3 ? null : external.source.previous();
      if (track) await this.startExternal(external.source, track);
      else this.seek(0);
      return;
    }
    const q = this.queue();
    if (q.length === 0) return;

    if (this.currentTime() > 3) {
      this.seek(0);
      return;
    }

    let prevIndex = this.currentIndex() - 1;

    if (prevIndex < 0) {
      if (this.activeRepeat() === 'all') {
        prevIndex = q.length - 1;
      } else {
        // At start of queue: restart current track
        this.seek(0);
        return;
      }
    }

    // Skip unavailable tracks backwards
    let attempts = 0;
    while (!this.isEntryPlayable(q[prevIndex]) && attempts < q.length) {
      prevIndex--;
      attempts++;
      if (prevIndex < 0) {
        if (this.activeRepeat() === 'all') {
          prevIndex = q.length - 1;
        } else {
          this.seek(0);
          return;
        }
      }
    }

    if (attempts >= q.length) {
      this.error.set('No available tracks in queue');
      return;
    }

    this.currentIndex.set(prevIndex);
    await this.loadAndPlayCurrent();
  }

  // ==========================================
  // Queue Editing Operations
  // ==========================================

  playNext(tracks: Track[]): void {
    if (!tracks || tracks.length === 0) return;

    // Under Smart Shuffle, Play next is a placement the arrangement keeps.
    const newEntries = this.createQueueEntries(tracks).map((entry) => this.smartShuffle() ? { ...entry, pinned: true } : entry);
    const currIdx = this.currentIndex();
    const q = [...this.queue()];

    if (currIdx < 0 || q.length === 0) {
      this.queue.set(newEntries);
      this.originalQueue = [...newEntries];
      if (this.external()) {
        // The external track keeps playing; the new entries wait as the parked queue.
        this.parkAt(0);
        return;
      }
      this.currentIndex.set(0);
      this.loadAndPlayCurrent();
      return;
    }

    q.splice(currIdx + 1, 0, ...newEntries);
    this.queue.set(q);
    this.originalQueue.push(...newEntries);
    this.refreshPreparedCandidate();
  }

  addToQueue(tracks: Track[]): QueueAddResult {
    if (!tracks || tracks.length === 0) return { addedCount: 0, skippedCount: 0 };

    const availableTracks = tracks.filter((track) => track.isAvailable);
    const result = {
      addedCount: availableTracks.length,
      skippedCount: tracks.length - availableTracks.length,
    };
    if (availableTracks.length === 0) return result;

    const newEntries = this.createQueueEntries(availableTracks);
    const q = this.queue();

    if (q.length === 0) {
      this.queue.set(newEntries);
      this.originalQueue = [...newEntries];
      if (this.external()) {
        this.parkAt(0);
        return result;
      }
      this.currentIndex.set(0);
      void this.loadCurrentPaused();
      return result;
    }

    // The user's tracks play before Autoplay's suggestions; Smart Shuffle places them itself.
    let at = q.length;
    if (!this.smartShuffle()) while (at > this.currentIndex() + 1 && q[at - 1].suggested) at--;
    this.queue.set([...q.slice(0, at), ...newEntries, ...q.slice(at)]);
    this.originalQueue.push(...newEntries);
    this.refreshPreparedCandidate();
    return result;
  }

  removeFromQueue(queueEntryId: string): void {
    const q = this.queue();
    const removeIdx = q.findIndex((e) => e.id === queueEntryId);
    if (removeIdx < 0) return;

    const isRemovingCurrent = removeIdx === this.currentIndex();
    const nextQueue = q.filter((e) => e.id !== queueEntryId);
    this.originalQueue = this.originalQueue.filter((e) => e.id !== queueEntryId);

    if (nextQueue.length === 0) {
      this.clearQueue();
      return;
    }

    this.queue.set(nextQueue);

    if (isRemovingCurrent) {
      // User rule: "Xóa current entry chuyển tới entry kế tiếp; không còn bài thì dừng."
      const nextIdx = removeIdx < nextQueue.length ? removeIdx : 0;
      if (this.external()) {
        this.parkAt(nextIdx);
      } else {
        this.currentIndex.set(nextIdx);
        this.loadAndPlayCurrent();
      }
    } else if (removeIdx < this.currentIndex()) {
      this.currentIndex.update((idx) => idx - 1);
    }
    this.refreshPreparedCandidate();
  }

  /** Undo for one removal: puts the entry back at `index` while the current track keeps playing. */
  insertQueueEntry(entry: QueueEntry, index: number): void {
    const queue = [...this.queue()];
    if (queue.some((item) => item.id === entry.id)) return;
    const at = Math.min(Math.max(index, 0), queue.length);
    queue.splice(at, 0, entry);
    this.queue.set(queue);
    if (at <= this.currentIndex()) this.currentIndex.update((idx) => idx + 1);
    // ponytail: the unshuffled order gets it at the end; place it by its neighbours if turning shuffle off after an Undo matters.
    if (!entry.suggested) this.originalQueue.push(entry);
    this.refreshPreparedCandidate();
  }

  moveQueueEntry(sourceId: string, targetId: string, placement: 'before' | 'after'): boolean {
    const current = this.queue();
    const sourceIndex = current.findIndex((entry) => entry.id === sourceId);
    if (sourceIndex < 0 || sourceId === targetId) return false;

    const currentEntryId = this.currentQueueEntry()?.id;
    const reordered = current.filter((entry) => entry.id !== sourceId);
    const targetIndex = reordered.findIndex((entry) => entry.id === targetId);
    if (targetIndex < 0) return false;

    // A track the user drags stays where it is put under Smart Shuffle.
    const moved = this.smartShuffle() ? { ...current[sourceIndex], pinned: true } : current[sourceIndex];
    reordered.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, moved);
    if (reordered.every((entry, index) => entry.id === current[index].id)) return false;

    this.queue.set(reordered);
    this.currentIndex.set(currentEntryId ? reordered.findIndex((entry) => entry.id === currentEntryId) : -1);
    this.originalQueue = reordered.filter((entry) => !entry.suggested);
    this.refreshPreparedCandidate();
    return true;
  }

  snapshotQueue(): QueueSnapshot {
    return {
      queue: [...this.queue()],
      originalQueue: [...this.originalQueue],
      currentIndex: this.currentIndex(),
      isShuffle: this.isShuffle(),
    };
  }

  async restoreQueue(snapshot: QueueSnapshot): Promise<void> {
    this.clearQueue();
    this.queue.set([...snapshot.queue]);
    this.originalQueue = [...snapshot.originalQueue];
    if (this.isShuffle() !== snapshot.isShuffle) {
      this.isShuffle.set(snapshot.isShuffle);
      if (!this.restoringSettings) void this.persistSettings({ shuffle: snapshot.isShuffle });
    }
    const index = snapshot.currentIndex;
    if (index >= 0 && index < snapshot.queue.length) {
      this.currentIndex.set(index);
      // Undo while an external track plays restores the parked queue without interrupting it.
      if (!this.external()) await this.loadCurrentPaused(false);
    }
  }

  /** Empties the queue. An external track keeps playing; otherwise playback stops. */
  clearQueue(): void {
    this.queue.set([]);
    this.failedEntryIds.clear();
    this.originalQueue = [];
    this.currentIndex.set(-1);
    if (this.external()) this.parkAt(-1);
    else this.resetPlayback();
  }

  private resetPlayback(): void {
    this.loadSequence++;
    this.clearPreparedCandidate();
    this.playRequested.set(false);
    this.engine.pause();
    this.currentTrack.set(null);
    this.currentTime.set(0);
    this.duration.set(0);
    this.error.set(null);
    this.playbackState.set('idle');
  }

  async jumpToQueueIndex(index: number): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    const q = this.queue();
    if (index >= 0 && index < q.length) {
      this.markTransition('user');
      this.failedEntryIds.delete(q[index].id);
      this.external.set(null);
      this.currentIndex.set(index);
      await this.loadAndPlayCurrent();
    }
  }

  // ==========================================
  // External Source (developer roulette)
  // ==========================================

  /**
   * Plays `track` from `source` in place of the queue. The first call parks the queue at its current
   * entry and position; later calls (the source's next pick) keep that resume point.
   */
  async playExternal(source: ExternalSource, track: Track): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    this.markTransition('user');
    await this.startExternal(source, track);
  }

  private async startExternal(source: ExternalSource, track: Track): Promise<void> {
    if (this.blockedByBusyOutput()) return;
    const current = this.external();
    const resumeAt = current ? current.resumeAt : this.currentQueueEntry() ? this.currentTime() : 0;
    this.external.set({ source, item: this.externalItem(track), resumeAt });
    await this.loadAndPlayCurrent();
  }

  /** Ends the external source and resumes the parked queue entry where it was left. */
  async backToQueue(): Promise<void> {
    const current = this.external();
    if (!current || this.blockedByBusyOutput()) return;
    this.markTransition('user');
    let resumeAt = current.resumeAt;
    if (!this.currentQueueEntry()) {
      if (!this.queue().length) {
        this.stopExternal();
        return;
      }
      this.currentIndex.set(0);
      resumeAt = 0;
    }
    this.external.set(null);
    await this.loadAndPlayCurrent(resumeAt);
  }

  /** Ends the external source and stops playback; the queue keeps its entries but nothing is loaded. */
  stopExternal(): void {
    if (!this.external()) return;
    this.external.set(null);
    this.resetPlayback();
  }

  private externalItem(track: Track): PlaybackItem {
    return { id: `ext-${++this.externalCount}`, track };
  }

  /** Moves the parked queue entry while an external track plays; it then resumes from the start. */
  private parkAt(index: number): void {
    this.currentIndex.set(index);
    this.external.update((current) => current && { ...current, resumeAt: 0 });
  }

  /** Playback moved on into the source's prepared track: consume it and follow it. */
  private followExternal(track: Track): void {
    const current = this.external();
    if (!current) return;
    current.source.next();
    this.external.set({ ...current, item: this.externalItem(track) });
    this.currentTrack.set(track);
    this.playRequested.set(true);
    this.error.set(null);
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  /**
   * While another app holds the output, a track change can only fail. Keep the
   * current track (the host still has it loaded) and explain instead.
   */
  private blockedByBusyOutput(): boolean {
    if (this.outputInterrupted !== 'device-busy') return false;
    this.playbackNotice.set('The selected audio output is in use by another app. Close it before changing tracks.');
    return true;
  }

  private async loadAndPlayCurrent(startAt = 0): Promise<void> {
    this.clearPreparedCandidate();
    const entry = this.currentItem();
    if (!entry) {
      this.currentTrack.set(null);
      return;
    }

    const track = entry.track;
    this.currentTrack.set(track);
    this.playRequested.set(true);

    // Sequence check to prevent out-of-order race conditions
    const thisSequence = ++this.loadSequence;

    try {
      await this.engine.load(track);
      if (thisSequence === this.loadSequence && this.currentItem() && this.playRequested()) {
        if (startAt > 0) this.engine.seek(startAt);
        await this.engine.play();
      }
    } catch (err) {
      if (thisSequence === this.loadSequence && this.currentItem()) {
        this.playRequested.set(false);
        const failure = normalizePlaybackFailure(err, track.id);
        this.error.set(failure.message);
        await this.handlePlaybackFailure(failure);
      }
    }
  }

  private async loadCurrentPaused(recoverOnFailure = true): Promise<void> {
    this.clearPreparedCandidate();
    const entry = this.currentItem();
    if (!entry) {
      this.currentTrack.set(null);
      return;
    }

    const track = entry.track;
    this.currentTrack.set(track);
    this.playRequested.set(false);
    this.error.set(null);
    const thisSequence = ++this.loadSequence;

    try {
      await this.engine.load(track);
      if (thisSequence === this.loadSequence && this.currentItem()?.id === entry.id && !this.playRequested()) {
        this.playbackState.set('paused');
      }
    } catch (err) {
      if (thisSequence === this.loadSequence && this.currentItem()?.id === entry.id) {
        this.playRequested.set(false);
        this.playbackState.set('error');
        const failure = normalizePlaybackFailure(err, track.id);
        this.error.set(failure.message);
        if (recoverOnFailure) await this.handlePlaybackFailure(failure);
      }
    }
  }

  private handleTrackEnded(): void {
    if (this.activeRepeat() === 'one') {
      this.seek(0);
      void this.play();
    } else {
      void this.advanceAfterEnded();
    }
  }

  /** The engine already continued gaplessly into the prepared track; follow it in the queue. */
  private handleTrackAutoAdvanced(track: Track): void {
    if (this.external()) {
      this.preparedCandidateId = null;
      this.preparationReady = false;
      this.followExternal(track);
      return;
    }
    const q = this.queue();
    let nextIndex = this.preparedCandidateId ? q.findIndex((entry) => entry.id === this.preparedCandidateId) : -1;
    if (nextIndex < 0 || q[nextIndex].track.id !== track.id) {
      const current = this.currentIndex();
      nextIndex = q.findIndex((entry, index) => index > current && entry.track.id === track.id);
      if (nextIndex < 0) nextIndex = q.findIndex((entry) => entry.track.id === track.id);
    }
    this.preparedCandidateId = null;
    this.preparationReady = false;
    if (nextIndex >= 0) this.currentIndex.set(nextIndex);
    this.currentTrack.set(track);
    this.playRequested.set(true);
    this.error.set(null);
  }

  private async advanceAfterEnded(): Promise<void> {
    if (this.transitioning) return;
    const candidate = this.nextCandidate();
    if (!candidate) {
      await this.advance();
      return;
    }

    if (this.preparationReady && this.preparedCandidateId === candidate.id) {
      this.transitioning = true;
      const originalId = this.currentItem()?.id;
      try {
        const started = await this.engine.transitionTo(candidate.track, 0);
        if (started && this.currentItem()?.id === originalId && this.followCandidate(candidate)) return;
      } catch { /* Fall back to the regular load path below. */ }
      finally {
        this.transitioning = false;
        this.preparedCandidateId = null;
        this.preparationReady = false;
        this.refreshPreparedCandidate();
      }
    }

    await this.advance();
  }

  private automaticNextIndex(): number {
    const q = this.queue();
    if (!q.length || this.currentIndex() < 0 || this.activeRepeat() === 'one') return -1;
    for (let offset = 1; offset < q.length; offset++) {
      const index = this.currentIndex() + offset;
      if (index >= q.length && this.activeRepeat() !== 'all') break;
      const candidate = index % q.length;
      if (this.isEntryPlayable(q[candidate])) return candidate;
    }
    return -1;
  }

  /** What plays when the current item ends: the source's peek, or the next playable queue entry. */
  private nextCandidate(): PlaybackItem | null {
    const external = this.external();
    if (external) {
      const track = external.source.peek();
      // Keyed to the current item, so a new peek after each track is prepared afresh.
      return track ? { id: `${external.item.id}>${track.id}`, track } : null;
    }
    const index = this.automaticNextIndex();
    return index >= 0 ? this.queue()[index] : null;
  }

  private automaticCandidate(): PlaybackItem | null {
    if (!this.currentTrack() || !this.isPlaying()) return null;
    return this.nextCandidate();
  }

  /** The engine moved into `candidate`: make it the current item. False when the queue lost it. */
  private followCandidate(candidate: PlaybackItem): boolean {
    if (this.external()) {
      this.followExternal(candidate.track);
      return true;
    }
    const nextIndex = this.queue().findIndex((entry) => entry.id === candidate.id);
    if (nextIndex < 0) return false;
    this.currentIndex.set(nextIndex);
    this.currentTrack.set(candidate.track);
    this.playRequested.set(true);
    this.error.set(null);
    return true;
  }

  private clearPreparedCandidate(): void {
    this.preparedCandidateId = null;
    this.preparationReady = false;
    this.engine.cancelPreparedNext();
  }

  private refreshPreparedCandidate(): void {
    if (this.transitioning) return;
    const candidate = this.automaticCandidate();
    if (!candidate) {
      if (this.preparedCandidateId) this.clearPreparedCandidate();
      return;
    }
    if (candidate.id === this.preparedCandidateId) return;
    this.clearPreparedCandidate();
    this.preparedCandidateId = candidate.id;
    void this.engine.prepareNext(candidate.track).then((ready) => {
      if (this.preparedCandidateId !== candidate.id) return;
      this.preparationReady = ready;
      if (ready) this.maybeStartCrossfade(this.currentTime(), this.duration());
    }).catch(() => { if (this.preparedCandidateId === candidate.id) this.preparationReady = false; });
  }

  private maybeStartCrossfade(time: number, duration: number): void {
    if (!this.crossfadeEnabled() || this.transitioning || !this.preparationReady || !Number.isFinite(duration) || duration <= 0) return;
    const candidate = this.automaticCandidate();
    if (!candidate || candidate.id !== this.preparedCandidateId) return;
    const seconds = Math.min(this.crossfadeSeconds(), duration / 2);
    if (duration - time > seconds) return;
    this.transitioning = true;
    const originalId = this.currentItem()?.id;
    void this.engine.transitionTo(candidate.track, seconds).then((started) => {
      if (started && this.currentItem()?.id === originalId) this.followCandidate(candidate);
    }).catch(() => { /* The current track continues until its normal end. */ }).finally(() => {
      this.transitioning = false;
      this.preparedCandidateId = null;
      this.preparationReady = false;
      this.refreshPreparedCandidate();
    });
  }

  private isEntryPlayable(entry: QueueEntry): boolean {
    return entry.track.isAvailable && !this.failedEntryIds.has(entry.id);
  }

  private async handlePlaybackFailure(failure: PlaybackError): Promise<void> {
    if (failure.code === 'OUTPUT_EXCLUSIVE_NOT_ALLOWED' || failure.code === 'OUTPUT_DEVICE_UNAVAILABLE' || failure.code === 'OUTPUT_DEVICE_BUSY' || failure.code === 'OUTPUT_FORMAT_UNSUPPORTED' || failure.code === 'OUTPUT_DEVICE_PERMISSION_DENIED' || failure.code === 'OUTPUT_DEVICE_UNSUPPORTED' || failure.code === 'OUTPUT_MODE_UNSUPPORTED') {
      this.playRequested.set(false);
      this.playbackState.set('paused');
      this.playbackNotice.set(failure.message);
      return;
    }
    const entry = this.currentItem();
    if (!entry || this.recoveringFromFailure || this.failedEntryIds.has(entry.id)) return;
    this.recoveringFromFailure = true;
    try {
      let currentFailure = failure;
      while (true) {
        const failedEntry = this.currentItem();
        if (!failedEntry) return;
        this.failedEntryIds.add(failedEntry.id);
        this.playRequested.set(false);
        this.playbackNotice.set(`${failedEntry.track.title} could not be played and was skipped.`);
        logPlaybackDiagnostic('warn', { operation: 'transition', state: 'error', errorCode: currentFailure.code, trackId: failedEntry.track.id });
        const nextEntry = this.skipFailedItem();
        if (!nextEntry) {
          this.playbackState.set('error');
          this.error.set(this.external() ? 'No playable tracks remain.' : 'No playable tracks remain in the queue.');
          return;
        }
        this.currentTrack.set(nextEntry.track);
        this.playRequested.set(true);
        const sequence = ++this.loadSequence;
        try {
          await this.engine.load(nextEntry.track);
          if (sequence !== this.loadSequence) return;
          await this.engine.play();
          this.error.set(null);
          return;
        } catch (err) {
          if (sequence !== this.loadSequence) return;
          currentFailure = normalizePlaybackFailure(err, nextEntry.track.id);
          if (currentFailure.code.startsWith('OUTPUT_')) {
            this.playRequested.set(false);
            this.playbackState.set('paused');
            this.playbackNotice.set(currentFailure.message);
            return;
          }
        }
      }
    } finally {
      this.recoveringFromFailure = false;
    }
  }

  /** Moves past a track that failed to play: the source's next pick, or the next playable entry. */
  private skipFailedItem(): PlaybackItem | null {
    const external = this.external();
    if (external) {
      const track = external.source.next();
      if (!track) return null;
      const item = this.externalItem(track);
      this.external.set({ ...external, item });
      return item;
    }
    const nextIndex = this.nextPlayableIndexAfterFailure();
    if (nextIndex < 0) return null;
    this.currentIndex.set(nextIndex);
    return this.queue()[nextIndex];
  }

  private nextPlayableIndexAfterFailure(): number {
    const entries = this.queue();
    const start = this.currentIndex();
    return nextPlayableQueueIndex(entries.length, start, this.activeRepeat() === 'all', (index) => this.isEntryPlayable(entries[index]));
  }

  private async handleOutputDevicesChanged(): Promise<void> {
    const wasConnected = this.audioPathStatus()?.isConnected ?? true;
    await this.refreshAudioOutputState();
    const status = this.audioPathStatus();
    if (status && !status.isConnected) {
      this.playRequested.set(false);
      this.playbackNotice.set(this.audioOutputFallbackEnabled() && status.activeDeviceId === SYSTEM_DEFAULT_OUTPUT_ID
        ? 'The preferred audio output was disconnected. System Default is ready; press Play to continue.'
        : 'The preferred audio output was disconnected. Playback has been paused.');
    } else if (!wasConnected) {
      this.playbackNotice.set('The preferred audio output was reconnected. Playback remains paused.');
    } else if (this.outputInterrupted && status?.isConnected) {
      this.outputInterrupted = false;
      this.playbackNotice.set('The audio output is ready. Playback remains paused.');
    }
  }

  private handleSuspend(): void {
    const entry = this.currentItem();
    if (!entry) return;
    this.suspendSnapshot = {
      entryId: entry.id,
      position: this.currentTime(),
      shouldResume: this.isPlaybackActive(),
    };
    logPlaybackDiagnostic('info', { operation: 'suspend', state: this.playbackState(), trackId: entry.track.id });
    this.pause();
  }

  private async handleResume(): Promise<void> {
    const snapshot = this.suspendSnapshot;
    this.suspendSnapshot = null;
    if (!snapshot) return;
    const external = this.external();
    let track: Track;
    if (external) {
      if (external.item.id !== snapshot.entryId) return;
      track = external.item.track;
    } else {
      const index = this.queue().findIndex((entry) => entry.id === snapshot.entryId);
      if (index < 0) return;
      this.currentIndex.set(index);
      track = this.queue()[index].track;
    }
    try {
      this.engine.setOutputFallbackEnabled(this.audioOutputFallbackEnabled());
      await this.engine.selectOutputDevice(this.preferredAudioOutputId());
      await this.refreshAudioOutputState();
      const sequence = ++this.loadSequence;
      await this.engine.load(track);
      if (sequence !== this.loadSequence) return;
      this.currentTrack.set(track);
      this.engine.seek(snapshot.position);
      if (this.audioEngineBackend() === 'chromium' && snapshot.shouldResume && this.audioPathStatus()?.activeDeviceId) {
        this.playRequested.set(true);
        await this.engine.play();
      } else {
        this.playRequested.set(false);
        this.playbackState.set('paused');
      }
      logPlaybackDiagnostic('info', { operation: 'resume', state: snapshot.shouldResume ? 'playing' : 'paused', trackId: track.id, deviceId: this.audioPathStatus()?.activeDeviceId ?? undefined });
    } catch (err) {
      const failure = normalizePlaybackFailure(err, this.currentTrack()?.id);
      this.playRequested.set(false);
      this.playbackState.set('error');
      this.error.set(failure.message);
      this.playbackNotice.set(failure.message);
    }
  }

  private createQueueEntry(track: Track, originalIndex: number): QueueEntry {
    return {
      id: `qe-${Date.now()}-${originalIndex}-${Math.random().toString(36).substring(2, 7)}`,
      track,
      originalIndex,
    };
  }

  private createQueueEntries(tracks: Track[]): QueueEntry[] {
    return tracks.map((track, idx) => this.createQueueEntry(track, idx));
  }

  private shuffleArray<T>(array: T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
