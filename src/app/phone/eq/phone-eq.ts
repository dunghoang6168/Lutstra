import { EQ_GAIN_LIMIT_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB, EqBand, matchedGains } from '../../core/models/eq.model';

/** The phone's graphic EQ: ten octave bands. */
export const PHONE_EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
/**
 * Wider than the bands' octave spacing (Q 1.41) so equal neighbours meet without a dip between them; matchedGains()
 * cancels the overlap. The same width-to-spacing ratio as the desktop's Q 1.41 on 2/3 octaves; Q 1 still matches
 * alternating ±12 dB, with filter gains up to about 27 dB (the native side takes ±30).
 */
export const PHONE_EQ_Q = 1;
export const PHONE_EQ_BANDS = PHONE_EQ_FREQUENCIES.length;

export type PhoneEffect = 'bassBoost' | 'virtualizer' | 'loudness';
export const PHONE_EFFECTS: readonly PhoneEffect[] = ['bassBoost', 'virtualizer', 'loudness'];

export interface PhoneEffectState {
  on: boolean;
  /** 0..100 */
  amount: number;
}

/** One output's EQ as the user set it. */
export interface PhoneEqState {
  gains: number[];
  /** Set by hand only, 0 dB by default: a boost on a loud master can clip, and lowering this is the user's call. */
  preampDb: number;
  effects: Record<PhoneEffect, PhoneEffectState>;
}

export interface PhoneEqPreset {
  name: string;
  gains: number[];
}

export const PHONE_EQ_PRESETS: readonly PhoneEqPreset[] = [
  { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass', gains: [5, 4, 3, 1.5, 0.5, 0, 0, 0, 0, 0] },
  { name: 'Treble', gains: [0, 0, 0, 0, 0, 0, 1, 2.5, 4, 5] },
  { name: 'Vocal', gains: [-3, -2, -1, 0, 1, 2, 3, 2, 1, 0] },
  // A phone or small speaker cannot play the lowest octave; lifting the next ones and the presence region carries better.
  { name: 'Loudspeaker', gains: [-6, -3, 1, 2, 1, 0, 1, 2, 1, 0] },
];

export function flatPhoneEq(): PhoneEqState {
  return {
    gains: new Array<number>(PHONE_EQ_BANDS).fill(0),
    preampDb: 0,
    effects: { bassBoost: { on: false, amount: 30 }, virtualizer: { on: false, amount: 30 }, loudness: { on: false, amount: 30 } },
  };
}

/** What the native EQ runs. */
export interface PhoneEqSpec {
  preampDb: number;
  filters: EqBand[];
  /** 0..1 */
  crossfeed: number;
}

/** The effects as filters: Bass Boost a low shelf, Loudness a low and a high shelf (a fixed equal-loudness lift). */
export function effectFilters(effects: PhoneEqState['effects']): EqBand[] {
  const filters: EqBand[] = [];
  const bass = effects.bassBoost;
  if (bass.on && bass.amount > 0) filters.push({ type: 'lowshelf', freq: 90, gainDb: round(9 * bass.amount / 100), q: 0.707 });
  const loud = effects.loudness;
  if (loud.on && loud.amount > 0) {
    filters.push({ type: 'lowshelf', freq: 60, gainDb: round(6 * loud.amount / 100), q: 0.707 });
    filters.push({ type: 'highshelf', freq: 10000, gainDb: round(4 * loud.amount / 100), q: 0.707 });
  }
  return filters;
}

export function crossfeedOf(effects: PhoneEqState['effects']): number {
  const virtualizer = effects.virtualizer;
  return virtualizer.on ? Math.max(0, Math.min(1, virtualizer.amount / 100)) : 0;
}

/** The bands and effects as filters, before the preamp. */
export function phoneEqFilters(state: PhoneEqState): EqBand[] {
  const graphic = matchedGains(state.gains, PHONE_EQ_FREQUENCIES, PHONE_EQ_Q)
    .map((gainDb, index): EqBand => ({ type: 'peak', freq: PHONE_EQ_FREQUENCIES[index], gainDb, q: PHONE_EQ_Q }));
  return [...graphic.filter((band) => band.gainDb !== 0), ...effectFilters(state.effects)];
}

export function phoneEqSpec(state: PhoneEqState): PhoneEqSpec {
  const filters = phoneEqFilters(state);
  return { preampDb: state.preampDb, filters, crossfeed: crossfeedOf(state.effects) };
}

/** Flat with every effect off: the native side passes audio through bit for bit. */
export function isFlatSpec(spec: PhoneEqSpec): boolean {
  return spec.preampDb === 0 && spec.crossfeed === 0 && spec.filters.every((filter) => filter.gainDb === 0);
}

/** Summed response of the filters at `freq`, in dB (RBJ biquads, as the native side runs them). */
export function responseDb(filters: readonly EqBand[], freq: number, rate = 48000): number {
  return filters.reduce((sum, filter) => sum + biquadDb(filter, freq, rate), 0);
}

function biquadDb(filter: EqBand, freq: number, rate: number): number {
  if (filter.gainDb === 0 || filter.freq >= 0.45 * rate) return 0;
  const [b0, b1, b2, a1, a2] = coefficients(filter, rate);
  const w = 2 * Math.PI * freq / rate;
  const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const ni = -b1 * Math.sin(w) - b2 * Math.sin(2 * w);
  const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
  const di = -a1 * Math.sin(w) - a2 * Math.sin(2 * w);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

function coefficients(filter: EqBand, rate: number): number[] {
  const a = Math.pow(10, filter.gainDb / 40);
  const w0 = 2 * Math.PI * filter.freq / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * filter.q);
  const s = 2 * Math.sqrt(a) * alpha;
  let b: number[];
  let d: number[];
  if (filter.type === 'lowshelf') {
    b = [a * ((a + 1) - (a - 1) * cos + s), 2 * a * ((a - 1) - (a + 1) * cos), a * ((a + 1) - (a - 1) * cos - s)];
    d = [(a + 1) + (a - 1) * cos + s, -2 * ((a - 1) + (a + 1) * cos), (a + 1) + (a - 1) * cos - s];
  } else if (filter.type === 'highshelf') {
    b = [a * ((a + 1) + (a - 1) * cos + s), -2 * a * ((a - 1) + (a + 1) * cos), a * ((a + 1) + (a - 1) * cos - s)];
    d = [(a + 1) - (a - 1) * cos + s, 2 * ((a - 1) - (a + 1) * cos), (a + 1) - (a - 1) * cos - s];
  } else {
    b = [1 + alpha * a, -2 * cos, 1 - alpha * a];
    d = [1 + alpha / a, -2 * cos, 1 - alpha / a];
  }
  return [b[0] / d[0], b[1] / d[0], b[2] / d[0], d[1] / d[0], d[2] / d[0]];
}

/** The matching built-in or user preset, or null for a custom curve. */
export function phonePresetName(gains: readonly number[], presets: readonly PhoneEqPreset[]): string | null {
  return presets.find((preset) => preset.gains.every((gain, index) => gain === gains[index]))?.name ?? null;
}

const numberIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function isPhoneEqState(value: unknown): value is PhoneEqState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const effects = v['effects'] as Record<string, unknown> | undefined;
  return Array.isArray(v['gains']) && v['gains'].length === PHONE_EQ_BANDS &&
    v['gains'].every((gain) => numberIn(gain, -EQ_GAIN_LIMIT_DB, EQ_GAIN_LIMIT_DB)) &&
    numberIn(v['preampDb'], EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) &&
    !!effects && PHONE_EFFECTS.every((name) => {
      const effect = effects[name] as Record<string, unknown> | undefined;
      return !!effect && typeof effect['on'] === 'boolean' && numberIn(effect['amount'], 0, 100);
    });
}

export function isPhoneEqPreset(value: unknown): value is PhoneEqPreset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['name'] === 'string' && v['name'].trim().length > 0 && v['name'].length <= 40 &&
    Array.isArray(v['gains']) && v['gains'].length === PHONE_EQ_BANDS &&
    v['gains'].every((gain) => numberIn(gain, -EQ_GAIN_LIMIT_DB, EQ_GAIN_LIMIT_DB));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Tangents for a monotone cubic (harmonic mean of the neighbouring slopes): no overshoot, flat at peaks and ends. */
export function monotoneSlopes(ys: readonly number[], step: number): number[] {
  const d = ys.slice(1).map((y, i) => (y - ys[i]) / step);
  return ys.map((_, i) => {
    if (i === 0 || i === ys.length - 1) return 0;
    const [a, b] = [d[i - 1], d[i]];
    return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
  });
}
