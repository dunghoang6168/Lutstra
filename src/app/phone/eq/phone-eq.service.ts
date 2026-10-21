import { Injectable, computed, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { NativeOutput, androidPlayback } from '../../core/android/android-playback.engine';
import { EQ_GAIN_LIMIT_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB } from '../../core/models/eq.model';
import { loadOutput, output } from '../app-shell';
import {
  PHONE_EQ_PRESETS, PhoneEffect, PhoneEqPreset, PhoneEqState, flatPhoneEq, isFlatSpec, isPhoneEqPreset, isPhoneEqState,
  phoneEqSpec, phonePresetName,
} from './phone-eq';

const STORAGE_KEY = 'lutstra.phone.eq';
/** Slider drags save once they settle. */
const SAVE_DELAY_MS = 400;

interface Stored {
  byOutput: Record<string, PhoneEqState>;
  presets: PhoneEqPreset[];
}

/** Each output keeps its own EQ: the speaker, a wired headset, each Bluetooth device and each USB DAC. */
export function outputKey(out: NativeOutput | null): string {
  const device = out?.device;
  if (!device || device.kind === 'speaker' || device.kind === 'wired') return device?.kind ?? 'speaker';
  return `${device.kind}:${device.name ?? ''}`;
}

/**
 * The phone EQ: always on, flat by default. It works out the filters (matched band gains, effects, auto preamp)
 * and hands them to the native sink, which runs them, or passes audio through untouched when they are flat.
 */
@Injectable({ providedIn: 'root' })
export class PhoneEqService {
  private readonly stored = read();
  private readonly byOutput = signal<Record<string, PhoneEqState>>(this.stored.byOutput);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  readonly userPresets = signal<PhoneEqPreset[]>(this.stored.presets);
  readonly presets = computed(() => [...PHONE_EQ_PRESETS, ...this.userPresets()]);
  readonly key = computed(() => outputKey(output()));
  readonly current = computed(() => this.byOutput()[this.key()] ?? flatPhoneEq());
  readonly spec = computed(() => phoneEqSpec(this.current()));
  readonly preampDb = computed(() => this.spec().preampDb);
  /** The matching preset's name, or null for a custom curve. */
  readonly presetName = computed(() => phonePresetName(this.current().gains, this.presets()));
  /** A USB DAC set to bit-perfect gets the file untouched, so nothing here can run. */
  readonly bitPerfect = computed(() => {
    const out = output();
    return out?.device?.kind === 'usb' && out.usbMode === 'bitperfect' && !!out.usb?.bitPerfect;
  });
  /** The EQ is changing what plays, so the Audio path must say so. */
  readonly processing = computed(() => !isFlatSpec(this.spec()) && !this.bitPerfect());

  constructor() {
    // The output decides which EQ runs and whether bit-perfect blocks it.
    void loadOutput();
    effect(() => {
      const spec = this.spec();
      if (Capacitor.getPlatform() === 'android') void androidPlayback.setEq(spec).catch(() => undefined);
    });
  }

  setGain(index: number, gainDb: number): void {
    const gains = [...this.current().gains];
    gains[index] = step(gainDb, -EQ_GAIN_LIMIT_DB, EQ_GAIN_LIMIT_DB);
    this.update({ gains });
  }

  setPreamp(preampDb: number): void {
    this.update({ preampDb: step(preampDb, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) });
  }

  setEffect(name: PhoneEffect, patch: Partial<PhoneEqState['effects'][PhoneEffect]>): void {
    const effects = this.current().effects;
    const amount = patch.amount === undefined ? undefined : Math.round(Math.max(0, Math.min(100, patch.amount)));
    this.update({ effects: { ...effects, [name]: { ...effects[name], ...patch, ...(amount === undefined ? {} : { amount }) } } });
  }

  applyPreset(name: string): void {
    const preset = this.presets().find((candidate) => candidate.name === name);
    if (preset) this.update({ gains: [...preset.gains] });
  }

  /** Saves the current curve under a name; a built-in name is refused. Returns whether it saved. */
  savePreset(name: string): boolean {
    const preset = { name: name.trim(), gains: [...this.current().gains] };
    if (!isPhoneEqPreset(preset) || PHONE_EQ_PRESETS.some((builtIn) => builtIn.name === preset.name)) return false;
    this.userPresets.update((presets) => [...presets.filter((existing) => existing.name !== preset.name), preset]);
    this.save();
    return true;
  }

  deletePreset(name: string): void {
    this.userPresets.update((presets) => presets.filter((preset) => preset.name !== name));
    this.save();
  }

  isUserPreset(name: string): boolean {
    return this.userPresets().some((preset) => preset.name === name);
  }

  private update(patch: Partial<PhoneEqState>): void {
    const key = this.key();
    this.byOutput.update((all) => ({ ...all, [key]: { ...this.current(), ...patch } }));
    this.save();
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ byOutput: this.byOutput(), presets: this.userPresets() } satisfies Stored));
      } catch { /* Losing a save only costs the curve; the native side keeps the last one it ran. */ }
    }, SAVE_DELAY_MS);
  }
}

function read(): Stored {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Stored> | null;
    return {
      byOutput: Object.fromEntries(Object.entries(parsed?.byOutput ?? {}).filter(([, state]) => isPhoneEqState(state))),
      presets: (parsed?.presets ?? []).filter(isPhoneEqPreset),
    };
  } catch {
    return { byOutput: {}, presets: [] };
  }
}

/** Sliders move in half-decibel steps. */
function step(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value * 2) / 2)) || 0;
}
