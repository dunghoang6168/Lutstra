import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../contracts';
import {
  BUILT_IN_EQ_PRESETS, DESKTOP_EQ_FREQUENCIES, EQ_GAIN_LIMIT_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB, EqPreset, EqSettings,
  eqCurve, eqPreampDb, eqPresetName, flatEq, isEqPreset, isEqSettings,
} from '../models';
import { PlayerService } from '../player/player.service';

const BANDS = DESKTOP_EQ_FREQUENCIES.length;
/** How long the clip light stays on after the last clipped buffer. */
const CLIP_HOLD_MS = 1500;
/** Slider drags save once they settle. */
const SAVE_DELAY_MS = 400;

/**
 * The EQ of the output Lutstra plays to: each output keeps its own, so the DAC, the speakers and a
 * Bluetooth speaker can each have a curve. It runs only on the native host.
 */
@Injectable({ providedIn: 'root' })
export class EqService {
  private readonly player = inject(PlayerService);
  private readonly engine = inject(PLAYBACK_ENGINE);
  private readonly settingsGateway = inject(SETTINGS_GATEWAY, { optional: true });
  private readonly byOutput = signal<Record<string, EqSettings>>({});
  private readonly loaded = signal(false);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private clipTimer: ReturnType<typeof setTimeout> | undefined;

  readonly userPresets = signal<EqPreset[]>([]);
  readonly presets = computed(() => [...BUILT_IN_EQ_PRESETS, ...this.userPresets()]);
  /** Chromium Shared is frozen and has no EQ. */
  readonly available = computed(() => this.player.audioEngineBackend() === 'native-shared');
  readonly current = computed(() => this.byOutput()[this.player.preferredAudioOutputId()] ?? flatEq(BANDS));
  readonly preampDb = computed(() => eqPreampDb(this.current()));
  /** The matching preset's name, or null for a custom curve. */
  readonly presetName = computed(() => eqPresetName(this.current().gains, this.presets()));
  /** The EQ is changing what plays, so the signal path must say so. */
  readonly processing = computed(() => this.available() && this.current().enabled &&
    (this.preampDb() !== 0 || this.current().gains.some((gain) => gain !== 0)));
  readonly clipping = signal(false);

  constructor() {
    void this.restore();
    effect(() => {
      const curve = eqCurve(this.current());
      if (this.loaded()) this.engine.setEq?.(curve);
    });
    this.engine.timeUpdate$.subscribe((event) => {
      if (!event.clipDb) return;
      this.clipping.set(true);
      clearTimeout(this.clipTimer);
      this.clipTimer = setTimeout(() => this.clipping.set(false), CLIP_HOLD_MS);
    });
  }

  setEnabled(enabled: boolean): void { this.update({ enabled }); }

  setGain(index: number, gainDb: number): void {
    const gains = [...this.current().gains];
    gains[index] = clampStep(gainDb, -EQ_GAIN_LIMIT_DB, EQ_GAIN_LIMIT_DB);
    this.update({ gains });
  }

  setAutoPreamp(autoPreamp: boolean): void {
    // Turning auto off starts manual preamp where auto left it, so nothing jumps.
    this.update(autoPreamp ? { autoPreamp } : { autoPreamp, preampDb: this.preampDb() });
  }

  setPreamp(preampDb: number): void {
    this.update({ autoPreamp: false, preampDb: clampStep(preampDb, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) });
  }

  applyPreset(name: string): void {
    const preset = this.presets().find((candidate) => candidate.name === name);
    if (preset) this.update({ enabled: true, gains: [...preset.gains] });
  }

  /** Every band and a manual preamp back to 0 dB. */
  zeroAll(): void { this.update({ gains: flatEq(BANDS).gains, preampDb: 0 }); }

  /** Saves the current curve under a name; a built-in name is refused. Returns whether it saved. */
  savePreset(name: string): boolean {
    const trimmed = name.trim();
    const preset = { name: trimmed, gains: [...this.current().gains] };
    if (!isEqPreset(preset) || BUILT_IN_EQ_PRESETS.some((builtIn) => builtIn.name === trimmed)) return false;
    this.userPresets.update((presets) => [...presets.filter((existing) => existing.name !== trimmed), preset]);
    void this.settingsGateway?.saveSettings({ eqPresets: this.userPresets() });
    return true;
  }

  deletePreset(name: string): void {
    this.userPresets.update((presets) => presets.filter((preset) => preset.name !== name));
    void this.settingsGateway?.saveSettings({ eqPresets: this.userPresets() });
  }

  private update(patch: Partial<EqSettings>): void {
    const output = this.player.preferredAudioOutputId();
    this.byOutput.update((all) => ({ ...all, [output]: { ...this.current(), ...patch } }));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.settingsGateway?.saveSettings({ eq: this.byOutput() }), SAVE_DELAY_MS);
  }

  private async restore(): Promise<void> {
    try {
      const settings = await this.settingsGateway?.getSettings();
      const stored = Object.entries(settings?.eq ?? {}).filter(([, eq]) => isEqSettings(eq) && eq.gains.length === BANDS);
      this.byOutput.set(Object.fromEntries(stored));
      this.userPresets.set((settings?.eqPresets ?? []).filter((preset) => isEqPreset(preset) && preset.gains.length === BANDS));
    } finally {
      this.loaded.set(true);
    }
  }
}

/** Sliders move in half-decibel steps. */
function clampStep(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value * 2) / 2)) || 0;
}
