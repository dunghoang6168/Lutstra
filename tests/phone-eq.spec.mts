import { describe, expect, it } from 'vitest';
import {
  PHONE_EQ_FREQUENCIES, PHONE_EQ_PRESETS, crossfeedOf, effectFilters, monotoneSlopes, flatPhoneEq, isFlatSpec, isPhoneEqState,
  phoneEqSpec, phonePresetName, responseDb,
} from '../src/app/phone/eq/phone-eq';

describe('phone EQ', () => {
  it('runs nothing when flat with the effects off, so the native side passes audio through', () => {
    const spec = phoneEqSpec(flatPhoneEq());
    expect(spec).toEqual({ preampDb: 0, filters: [], crossfeed: 0 });
    expect(isFlatSpec(spec)).toBe(true);
  });

  it('hits each slider at its band centre', () => {
    const state = { ...flatPhoneEq(), gains: [5, 4, 3, 1.5, 0.5, 0, 0, 0, 0, 0] };
    const filters = phoneEqSpec(state).filters;
    PHONE_EQ_FREQUENCIES.forEach((freq, i) => expect(responseDb(filters, freq)).toBeCloseTo(state.gains[i], 1));
  });

  it('keeps equal neighbours flat between their centres, and still matches alternating ±12 dB', () => {
    const pair = phoneEqSpec({ ...flatPhoneEq(), gains: [0, 0, 0, 0, 12, 12, 0, 0, 0, 0] }).filters;
    expect(responseDb(pair, Math.SQRT1_2 * 1000)).toBeGreaterThan(11.5);
    const gains = PHONE_EQ_FREQUENCIES.map((_, i) => (i % 2 ? -12 : 12));
    const alternating = phoneEqSpec({ ...flatPhoneEq(), gains }).filters;
    PHONE_EQ_FREQUENCIES.forEach((freq, i) => expect(responseDb(alternating, freq)).toBeCloseTo(gains[i], 1));
    alternating.forEach((filter) => expect(Math.abs(filter.gainDb)).toBeLessThanOrEqual(30));
  });

  it('draws equal neighbours flat and never overshoots a peak', () => {
    expect(monotoneSlopes([0, 0, 10, 10, 0, 0], 1)).toEqual([0, 0, 0, 0, 0, 0]);
    const rising = monotoneSlopes([0, 2, 6, 7], 1);
    expect(rising.every((slope) => slope >= 0)).toBe(true);
  });

  it('leaves the preamp where the user set it, however much the bands boost', () => {
    const state = { ...flatPhoneEq(), gains: [12, 12, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(phoneEqSpec(state).preampDb).toBe(0);
    expect(phoneEqSpec({ ...state, preampDb: -4 }).preampDb).toBe(-4);
  });

  it('turns the effects into shelves and crossfeed only while they are on', () => {
    const effects = flatPhoneEq().effects;
    expect(effectFilters(effects)).toEqual([]);
    expect(crossfeedOf(effects)).toBe(0);
    const on = { bassBoost: { on: true, amount: 50 }, virtualizer: { on: true, amount: 40 }, loudness: { on: true, amount: 100 } };
    expect(effectFilters(on)).toEqual([
      { type: 'lowshelf', freq: 90, gainDb: 4.5, q: 0.707 },
      { type: 'lowshelf', freq: 60, gainDb: 6, q: 0.707 },
      { type: 'highshelf', freq: 10000, gainDb: 4, q: 0.707 },
    ]);
    expect(crossfeedOf(on)).toBe(0.4);
    expect(isFlatSpec(phoneEqSpec({ ...flatPhoneEq(), effects: on }))).toBe(false);
  });

  it('names the matching preset and validates what it reads back', () => {
    expect(phonePresetName(PHONE_EQ_PRESETS[1].gains, PHONE_EQ_PRESETS)).toBe('Bass');
    expect(phonePresetName([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], PHONE_EQ_PRESETS)).toBeNull();
    expect(isPhoneEqState(flatPhoneEq())).toBe(true);
    expect(isPhoneEqState({ ...flatPhoneEq(), gains: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toBe(false);
    expect(isPhoneEqState({ ...flatPhoneEq(), gains: [0, 0] })).toBe(false);
  });
});
