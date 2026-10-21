import { NgZone } from '@angular/core';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { AudioAnalysisEngine, PlaybackEngine } from '../contracts';
import {
  AudioOutputDevice, AudioPathStatus, OutputMode, PlaybackErrorCode, PlaybackState, PlaybackStateEvent,
  PlaybackTimeEvent, PlaybackVolumeEvent, SYSTEM_DEFAULT_OUTPUT_ID, Track,
} from '../models';

export interface NativeQueueItem { id: string; uri: string; title: string; artist: string | null; album: string | null }

export interface NativePlaybackState {
  playing: boolean;
  playWhenReady: boolean;
  /** Media3 Player.STATE_*: 1 idle, 2 buffering, 3 ready, 4 ended. */
  playbackState: number;
  positionMs: number;
  durationMs: number;
  mediaId: string | null;
}

export interface NativePlayback {
  load(item: NativeQueueItem): Promise<NativePlaybackState>;
  prepareNext(item: NativeQueueItem): Promise<void>;
  cancelPreparedNext(): Promise<void>;
  play(): Promise<NativePlaybackState>;
  pause(): Promise<NativePlaybackState>;
  next(): Promise<NativePlaybackState>;
  seekTo(options: { positionMs: number }): Promise<NativePlaybackState>;
  setVolume(options: { volume: number }): Promise<void>;
  getState(): Promise<NativePlaybackState>;
  addListener(event: 'state', listener: (state: NativePlaybackState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'advanced', listener: (event: { mediaId: string | null; auto: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', listener: (event: { code: string; message: string }) => void): Promise<PluginListenerHandle>;
  getOutput(): Promise<NativeOutput>;
  setUsbMode(options: { mode: UsbMode }): Promise<NativeOutput>;
  requestBluetoothAccess(): Promise<NativeOutput>;
  addListener(event: 'output', listener: (output: NativeOutput) => void): Promise<PluginListenerHandle>;
  /** The phone EQ's filters (`EqAudioSink`); a flat spec passes audio through untouched. */
  setEq(spec: { preampDb: number; filters: { type: 'peak' | 'lowshelf' | 'highshelf'; freq: number; gainDb: number; q: number }[]; crossfeed: number }): Promise<void>;
  getEqStats(): Promise<{ running: boolean; hasWork: boolean; frames?: number; nanos?: number; clippedSamples?: number; peak?: number }>;
}

/** capture: another app records playback (a screen mirror's remote submix), and media goes there. */
export type OutputDeviceKind = 'speaker' | 'wired' | 'usb' | 'bluetooth' | 'capture' | 'other';
/** How a USB DAC is played to (Android 14+): through the shared mixer, the mixer at the stream's rate, or unmixed. */
export type UsbMode = 'shared' | 'match' | 'bitperfect';

/** What the audio goes through now (`AudioOutputState.snapshot`); absent fields are unknown. */
export interface NativeOutput {
  /** The routed device; encodings are the PCM formats it takes (pcm16, pcm24, pcm32, float). */
  device?: { kind: OutputDeviceKind; name?: string; encodings?: string[] };
  /** The AudioTrack ExoPlayer writes: encoding is pcm16, pcm24, pcm32 or float. */
  stream?: { encoding: string; sampleRate: number; channels: number; offload: boolean };
  /** The device's mixer: its rate when known, whether it runs at Lutstra's request (matched) and unmixed (bitPerfect). */
  mixer: { sampleRate?: number; encoding?: string; matched: boolean; bitPerfect: boolean };
  /** The Bluetooth link while media plays to Bluetooth: codec, its rate and bits, and LDAC's bitrate (990, 660, 330 or adaptive). */
  bluetooth?: { codec: string; sampleRate?: number; bits?: number; ldac?: string };
  /** Whether the codec can be read: Nearby devices granted, still to ask for, or not on this Android. */
  codecAccess: 'granted' | 'needed' | 'unsupported';
  /** The MediaCodec decoder for the current file, e.g. c2.android.flac.decoder. */
  decoder?: string;
  usbMode: UsbMode;
  /** Android 14+, where a USB DAC's mixer can be set. */
  usbCapable: boolean;
  /** The plugged USB DAC and the modes it offers. */
  usb?: { name: string; match: boolean; bitPerfect: boolean };
}

/** The Media3 playback plugin; Now Playing and Settings also read the output from it. */
export const androidPlayback = registerPlugin<NativePlayback>('AndroidPlayback');

export function queueItemFor(track: Track): NativeQueueItem {
  return { id: track.id, uri: track.path, title: track.title, artist: track.artist, album: track.album };
}

export function stateFrom(native: NativePlaybackState): PlaybackState {
  if (native.playbackState === 4) return 'ended';
  if (native.playing) return 'playing';
  if (native.playbackState === 2 && native.playWhenReady) return 'buffering';
  if (native.playbackState === 1) return 'idle';
  return 'paused';
}

export function errorCodeFor(code: string): PlaybackErrorCode {
  if (/FILE_NOT_FOUND|NO_PERMISSION/.test(code)) return 'FILE_UNAVAILABLE';
  if (/DECODING|DECODER|PARSING/.test(code)) return 'MEDIA_DECODE';
  return 'PLAYBACK_FAILED';
}

/**
 * Playback through the Android Media3 service, which keeps playing and advancing with the app in the
 * background. The PlayerService still owns the queue: it loads one track and prepares the next, and
 * Media3 continues into the prepared track gaplessly. A crossfade request waits for that gapless
 * continuation at the natural end instead of fading.
 */
export class AndroidPlaybackEngine implements PlaybackEngine, AudioAnalysisEngine {
  readonly isAnalysisSupported = false;

  private current: Track | null = null;
  private prepared: Track | null = null;
  /** Every track handed to Media3 since the last load, by media ID; headset and notification controls move between them. */
  private known = new Map<string, Track>();
  private sequence = 0;
  private volume = 0.8;
  private muted = false;
  private lastState: PlaybackState = 'idle';
  private pending: { track: Track; resolve: (done: boolean) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** A seek just sent: a report from before it landed would pull the timeline back, so it is dropped for a moment. */
  private pendingSeek: { seconds: number; until: number } | null = null;
  private readonly listeners: Promise<PluginListenerHandle>[];

  private readonly stateSubject = new BehaviorSubject<PlaybackStateEvent>({ state: 'idle', track: null });
  private readonly timeSubject = new Subject<PlaybackTimeEvent>();
  private readonly volumeSubject = new BehaviorSubject<PlaybackVolumeEvent>({ volume: 0.8, isMuted: false });
  private readonly advancedSubject = new Subject<Track>();

  readonly stateChange$: Observable<PlaybackStateEvent> = this.stateSubject.asObservable();
  readonly timeUpdate$: Observable<PlaybackTimeEvent> = this.timeSubject.asObservable();
  readonly volumeChange$: Observable<PlaybackVolumeEvent> = this.volumeSubject.asObservable();
  readonly trackAutoAdvanced$: Observable<Track> = this.advancedSubject.asObservable();

  constructor(
    private readonly zone: NgZone,
    private readonly native: NativePlayback = androidPlayback,
  ) {
    // Capacitor delivers plugin events outside Angular's zone.
    this.listeners = [
      native.addListener('state', (state) => this.zone.run(() => this.handleState(state))),
      native.addListener('advanced', (event) => this.zone.run(() => this.handleAdvanced(event))),
      native.addListener('error', (event) => this.zone.run(() => this.handleError(event))),
    ];
  }

  async load(track: Track): Promise<void> {
    this.settlePending(false);
    this.sequence++;
    this.prepared = null;
    this.current = track;
    this.known = new Map([[track.id, track]]);
    this.emitState('loading');
    if (!track.isAvailable) {
      this.emitError('FILE_UNAVAILABLE', 'This audio file is unavailable or missing.');
      throw new Error(`Track ${track.id} is unavailable`);
    }
    await this.native.load(queueItemFor(track));
    this.emitState('paused');
    this.timeSubject.next({ currentTime: 0, duration: track.duration });
  }

  async play(): Promise<void> {
    if (!this.current) return;
    this.handleState(await this.native.play());
  }

  pause(): void {
    void this.native.pause().then((state) => this.zone.run(() => this.handleState(state)));
  }

  seek(positionSeconds: number): void {
    const seconds = Math.max(0, positionSeconds);
    void this.native.seekTo({ positionMs: Math.round(seconds * 1000) });
    this.pendingSeek = { seconds, until: Date.now() + 1500 };
    this.timeSubject.next({ currentTime: seconds, duration: this.current?.duration ?? 0 });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyVolume();
  }

  setMute(isMuted: boolean): void {
    this.muted = isMuted;
    this.applyVolume();
  }

  async prepareNext(track: Track): Promise<boolean> {
    if (!track.isAvailable) return false;
    const sequence = this.sequence;
    await this.native.prepareNext(queueItemFor(track));
    if (sequence !== this.sequence) return false;
    this.prepared = track;
    this.known.set(track.id, track);
    return true;
  }

  cancelPreparedNext(): void {
    this.settlePending(false);
    this.sequence++;
    this.prepared = null;
    void this.native.cancelPreparedNext();
  }

  async transitionTo(track: Track, crossfadeSeconds: number): Promise<boolean> {
    if (this.prepared?.id !== track.id && !(await this.prepareNext(track))) return false;
    if (crossfadeSeconds > 0) {
      // No fading: resolve when Media3 reaches the end and continues into the prepared track.
      this.settlePending(false);
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => this.settlePending(false), (crossfadeSeconds + 2) * 1000);
        this.pending = { track, resolve, timeout };
      });
    }
    this.sequence++;
    this.prepared = null;
    this.current = track;
    this.handleState(await this.native.next());
    return true;
  }

  async listOutputDevices(): Promise<AudioOutputDevice[]> {
    return [{ id: SYSTEM_DEFAULT_OUTPUT_ID, name: 'System Default', isDefault: true, isConnected: true, supportedModes: ['shared'], supportedFormats: null, mixFormat: null }];
  }
  async selectOutputDevice(_deviceId: string): Promise<void> {}
  setOutputFallbackEnabled(_enabled: boolean): void {}
  async setOutputMode(mode: OutputMode): Promise<void> {
    if (mode !== 'shared') throw Object.assign(new Error('Android plays through the shared system output only.'), { code: 'OUTPUT_MODE_UNSUPPORTED' });
  }
  async getAudioPathStatus(): Promise<AudioPathStatus> {
    // ponytail: reports the 'chromium' backend because AudioEngineBackend has no Android member; add one when the settings UI shows Android.
    return {
      backend: 'chromium', hostState: 'unavailable', resamplingActive: false, channelConversionActive: false,
      bitPerfectEligible: false, processingReasons: ['Android Media3 shared output'],
      preferredDeviceId: SYSTEM_DEFAULT_OUTPUT_ID, activeDeviceId: SYSTEM_DEFAULT_OUTPUT_ID, deviceName: 'System Default',
      mode: 'shared',
      sourceFormat: this.current ? { sampleRate: this.current.sampleRate, bitDepth: this.current.bitDepth, channels: this.current.channels } : null,
      outputFormat: null, isConnected: true, capabilitiesAvailable: false,
      reason: 'Android mixes all apps through the system output.',
    };
  }
  subscribeDeviceChanges(_listener: () => void): () => void { return () => undefined; }
  getBackend(): 'chromium' { return 'chromium'; }
  async setBackend(backend: 'chromium' | 'native-shared'): Promise<void> {
    if (backend !== 'chromium') throw Object.assign(new Error('The Native Audio Host is desktop only.'), { code: 'AUDIO_HOST_UNAVAILABLE' });
  }

  async prepareFrequencyAnalysis(): Promise<number> { return 0; }
  readFrequencyData(_target: Uint8Array<ArrayBuffer>): boolean { return false; }

  dispose(): void {
    this.settlePending(false);
    this.stopTicker();
    for (const listener of this.listeners) void listener.then((handle) => handle.remove());
    this.current = null;
    this.prepared = null;
    this.known.clear();
    this.emitState('idle');
  }

  private handleState(native: NativePlaybackState): void {
    if (!this.current) return;
    const state = stateFrom(native);
    if (state === 'playing') this.startTicker(); else this.stopTicker();
    if (state !== this.lastState) this.emitState(state);
    this.emitTime(native);
  }

  /** Media3 moved to another item on its own, or from a headset or notification control: follow it. */
  private handleAdvanced(event: { mediaId: string | null; auto: boolean }): void {
    const track = event.mediaId ? this.known.get(event.mediaId) : undefined;
    if (!track || track.id === this.current?.id) return;
    this.current = track;
    this.prepared = null;
    // A waiting crossfade request reports the move itself; otherwise the player follows this event.
    if (this.pending?.track.id === track.id) this.settlePending(true);
    else this.advancedSubject.next(track);
    this.emitState(this.lastState === 'paused' ? 'paused' : 'playing');
  }

  private handleError(event: { code: string; message: string }): void {
    this.stopTicker();
    this.emitError(errorCodeFor(event.code), event.message || event.code);
  }

  private settlePending(done: boolean): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timeout);
    this.pending.resolve(done);
    this.pending = null;
  }

  private emitState(state: PlaybackState): void {
    this.lastState = state;
    this.stateSubject.next({ state, track: this.current });
  }

  private emitError(code: PlaybackErrorCode, message: string): void {
    this.lastState = 'error';
    this.stateSubject.next({ state: 'error', track: this.current, error: { code, message, trackId: this.current?.id } });
  }

  private emitTime(native: NativePlaybackState): void {
    const duration = native.durationMs > 0 ? native.durationMs / 1000 : this.current?.duration ?? 0;
    const seconds = Math.max(0, native.positionMs / 1000);
    const pending = this.pendingSeek;
    if (pending && Date.now() < pending.until && Math.abs(seconds - pending.seconds) > 1) return;
    this.pendingSeek = null;
    this.timeSubject.next({ currentTime: seconds, duration });
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.native.getState().then((state) => this.zone.run(() => this.emitTime(state)));
    }, 500);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * The phone has no in-app volume (the hardware keys set the system's), so the player stays at unity: nothing is
   * scaled before the mixer, which bit-perfect USB output needs. Mute still silences it.
   */
  private applyVolume(): void {
    void this.native.setVolume({ volume: this.muted ? 0 : 1 });
    this.volumeSubject.next({ volume: this.volume, isMuted: this.muted });
  }
}
