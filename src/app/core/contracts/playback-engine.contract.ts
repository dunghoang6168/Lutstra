import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { AudioEngineBackend, AudioOutputDevice, AudioPathStatus, EqCurve, OutputMode, Track, PlaybackStateEvent, PlaybackTimeEvent, PlaybackVolumeEvent } from '../models';

export interface PlaybackEngine {
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(positionSeconds: number): void;
  setVolume(volume: number): void;
  setMute(isMuted: boolean): void;
  /** `following` is passed only to an engine with `playsFollowing`. */
  prepareNext(track: Track, following?: Track[]): Promise<boolean>;
  cancelPreparedNext(): void;
  /** Loops the current track in the engine itself (Android's Media3, so Repeat one holds while the web sleeps); it then never reports 'ended'. */
  setRepeatOne?(on: boolean): void;
  transitionTo(track: Track, crossfadeSeconds: number): Promise<boolean>;
  listOutputDevices(): Promise<AudioOutputDevice[]>;
  selectOutputDevice(deviceId: string): Promise<void>;
  setOutputFallbackEnabled(enabled: boolean): void;
  setOutputMode(mode: OutputMode, bufferMs?: number): Promise<void>;
  /** Engines without an EQ leave this out. */
  setEq?(curve: EqCurve): void;
  getAudioPathStatus(): Promise<AudioPathStatus>;
  subscribeDeviceChanges(listener: () => void): () => void;
  getBackend(): AudioEngineBackend;
  setBackend(backend: AudioEngineBackend): Promise<void>;
  dispose(): void;

  readonly stateChange$: Observable<PlaybackStateEvent>;
  readonly timeUpdate$: Observable<PlaybackTimeEvent>;
  readonly volumeChange$: Observable<PlaybackVolumeEvent>;
  readonly outputInterrupted$?: Observable<'device-invalidated' | 'device-busy'>;
  /**
   * The engine plays on through the tracks after the prepared one by itself (Android's Media3, which keeps going
   * while the web sleeps), so prepareNext also takes them; it reports each move on `trackAutoAdvanced$`.
   */
  readonly playsFollowing?: boolean;
  /** Emits when the engine itself continued gaplessly into the prepared track. */
  readonly trackAutoAdvanced$?: Observable<Track>;
}

export const PLAYBACK_ENGINE = new InjectionToken<PlaybackEngine>('PLAYBACK_ENGINE');
