import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { PlayerService } from '../src/app/core/player/player.service';
import { EqService } from '../src/app/core/eq/eq.service';
import { validSettings } from '../electron/ipc/settings-validation';
import { BUILT_IN_EQ_PRESETS, DESKTOP_EQ_FREQUENCIES, EQ_FILTER_LIMIT_DB, eqCurve, eqResponseDb, eqPresetName, flatEq, isEqCurve, isEqSettings } from '../src/app/core/models';

vi.mock('@angular/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@angular/core')>(),
  effect: vi.fn(() => ({ destroy: vi.fn() })),
}));

describe('eq model', () => {
  it('turns gains into a peak curve with auto preamp under the highest boost', () => {
    const gains = [...BUILT_IN_EQ_PRESETS[1].gains];
    const curve = eqCurve({ enabled: true, autoPreamp: true, preampDb: 3, gains });
    expect(curve.preampDb).toBe(-6);
    expect(curve.bands).toHaveLength(15);
    expect(curve.bands[0]).toMatchObject({ type: 'peak', freq: 25, q: 1.41 });
    expect(eqCurve({ enabled: true, autoPreamp: false, preampDb: 3, gains }).preampDb).toBe(3);
    expect(Object.is(eqCurve(flatEq()).preampDb, 0)).toBe(true);
  });

  it('matches each slider at its band centre with no dips between equal neighbours', () => {
    const patterns = [new Array(15).fill(6), [...BUILT_IN_EQ_PRESETS[3].gains], DESKTOP_EQ_FREQUENCIES.map((_, i) => (i % 2 ? -12 : 12)),
      DESKTOP_EQ_FREQUENCIES.map((_, i) => (i === 8 ? 12 : 0))];
    for (const gains of patterns) {
      const curve = { ...eqCurve({ enabled: true, autoPreamp: false, preampDb: 0, gains }), enabled: true };
      DESKTOP_EQ_FREQUENCIES.forEach((freq, i) => expect(Math.abs(eqResponseDb(curve, freq) - gains[i])).toBeLessThan(0.05));
      for (const band of curve.bands) expect(Math.abs(band.gainDb)).toBeLessThanOrEqual(EQ_FILTER_LIMIT_DB);
      expect(isEqCurve(curve)).toBe(true);
    }
    // All +6: between the centres the response stays within 2 dB of +6 (it was 6 dB of ripple with plain slider gains).
    const level = { ...eqCurve({ enabled: true, autoPreamp: false, preampDb: 0, gains: new Array(15).fill(6) }), enabled: true };
    for (let f = 30; f < 14000; f *= 1.02) expect(Math.abs(eqResponseDb(level, f) - 6)).toBeLessThan(2);
    // Flat stays exactly flat.
    expect(eqCurve(flatEq()).bands.every((band) => band.gainDb === 0)).toBe(true);
  });

  it('keeps built-in presets on the desktop band set and names matching curves', () => {
    for (const preset of BUILT_IN_EQ_PRESETS) expect(preset.gains).toHaveLength(DESKTOP_EQ_FREQUENCIES.length);
    expect(eqPresetName(flatEq().gains, BUILT_IN_EQ_PRESETS)).toBe('Flat');
    expect(eqPresetName([1, ...flatEq().gains.slice(1)], BUILT_IN_EQ_PRESETS)).toBeNull();
  });

  it('accepts only what the host accepts', () => {
    expect(isEqCurve(eqCurve({ ...flatEq(), enabled: true }))).toBe(true);
    expect(isEqCurve({ enabled: true, preampDb: 7, bands: [] })).toBe(false);
    expect(isEqCurve({ enabled: true, preampDb: 0, bands: [{ type: 'notch', freq: 1000, gainDb: 0, q: 1 }] })).toBe(false);
    expect(isEqCurve({ enabled: true, preampDb: 0, bands: new Array(16).fill({ type: 'peak', freq: 1000, gainDb: 0, q: 1 }) })).toBe(false);
    expect(isEqSettings({ ...flatEq(), gains: [13] })).toBe(false);
  });

  it('validates stored EQ and presets over IPC', () => {
    const eq = { dac: { ...flatEq(), enabled: true } };
    expect(validSettings({ eq, eqPresets: [{ name: 'Mine', gains: flatEq().gains }] })).toEqual({ eq, eqPresets: [{ name: 'Mine', gains: flatEq().gains }] });
    expect(() => validSettings({ eq: { dac: { ...flatEq(), preampDb: -13 } } })).toThrow();
    expect(() => validSettings({ eq: [] })).toThrow();
    expect(() => validSettings({ eqPresets: [{ name: ' ', gains: [0] }] })).toThrow();
  });
});

function setup(stored: Record<string, unknown> = {}) {
  const time = new Subject<any>();
  const engine = { timeUpdate$: time, setEq: vi.fn() };
  const settings = { getSettings: vi.fn(async () => stored), saveSettings: vi.fn(async (value: any) => value) };
  const player = { audioEngineBackend: signal('native-shared'), preferredAudioOutputId: signal('dac') };
  const injector = Injector.create({ providers: [
    { provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: settings },
    { provide: PlayerService, useValue: player }, { provide: EqService },
  ] });
  return { eq: injector.get(EqService), engine, settings, player, time };
}

describe('EqService', () => {
  it('keeps one curve per output and saves once a drag settles', async () => {
    vi.useFakeTimers();
    const { eq, settings, player } = setup();
    await vi.runAllTimersAsync();
    eq.setEnabled(true);
    eq.setGain(0, 4.3);
    eq.setGain(0, 13);
    expect(eq.current().gains[0]).toBe(12);
    expect(eq.preampDb()).toBe(-12);
    expect(eq.processing()).toBe(true);
    player.preferredAudioOutputId.set('speakers');
    expect(eq.current()).toEqual(flatEq());
    expect(eq.processing()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    expect(settings.saveSettings.mock.calls[0][0].eq.dac.gains[0]).toBe(12);
    vi.useRealTimers();
  });

  it('applies presets, refuses built-in names and drops stored curves of another band count', async () => {
    const { eq } = setup({ eq: { dac: { ...flatEq(10), enabled: true } }, eqPresets: [{ name: 'Old', gains: [1, 2] }] });
    await Promise.resolve(); await Promise.resolve();
    expect(eq.current().enabled).toBe(false);
    expect(eq.userPresets()).toEqual([]);
    eq.applyPreset('Vocal');
    expect(eq.presetName()).toBe('Vocal');
    expect(eq.savePreset('Flat')).toBe(false);
    expect(eq.savePreset('  My DAC ')).toBe(true);
    expect(eq.presetName()).toBe('Vocal');
    eq.setGain(14, 1);
    expect(eq.presetName()).toBeNull();
    eq.deletePreset('My DAC');
    expect(eq.userPresets()).toEqual([]);
  });

  it('starts manual preamp where auto left it, and lights the clip warning', async () => {
    vi.useFakeTimers();
    const { eq, player, time } = setup();
    await vi.runAllTimersAsync();
    eq.applyPreset('Bass boost');
    eq.setAutoPreamp(false);
    expect(eq.preampDb()).toBe(-6);
    eq.setPreamp(-3);
    eq.zeroAll();
    expect(eq.current().gains.every((gain) => gain === 0)).toBe(true);
    expect(eq.preampDb()).toBe(0);
    time.next({ currentTime: 1, duration: 2, clipDb: 0.4 });
    expect(eq.clipping()).toBe(true);
    await vi.advanceTimersByTimeAsync(1600);
    expect(eq.clipping()).toBe(false);
    player.audioEngineBackend.set('chromium');
    expect(eq.processing()).toBe(false);
    vi.useRealTimers();
  });
});
