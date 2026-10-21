/** Equalizer settings, presets and the curve the playback engine runs. */

export const EQ_GAIN_LIMIT_DB = 12;
export const EQ_PREAMP_MIN_DB = -12;
export const EQ_PREAMP_MAX_DB = 6;
export const EQ_MAX_BANDS = 15;

/** Desktop graphic EQ: the ISO 2/3-octave centres. */
export const DESKTOP_EQ_FREQUENCIES = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000] as const;
/**
 * Wider than the bands' 2/3-octave spacing (Q 2.15) so neighbours blend without dips between them; matchedGains()
 * then cancels the overlap. Q 1.41 halves the ripple of Q 2.15 and, unlike Q 1, still matches alternating ±12 dB.
 */
export const DESKTOP_EQ_Q = 1.41;
/** A filter's own gain may pass the slider limit: matching alternating ±12 dB sliders needs about 28 dB. */
export const EQ_FILTER_LIMIT_DB = 30;

export type EqBandType = 'peak' | 'lowshelf' | 'highshelf';

export interface EqBand {
  type: EqBandType;
  freq: number;
  gainDb: number;
  q: number;
}

/** What the engine runs. With `enabled` false, audio passes untouched. */
export interface EqCurve {
  enabled: boolean;
  preampDb: number;
  bands: EqBand[];
}

/** One output's EQ as the user set it: a gain per graphic band. */
export interface EqSettings {
  enabled: boolean;
  /** Preamp follows the highest boost, so boosting a band does not clip a full-scale track. */
  autoPreamp: boolean;
  /** Used while autoPreamp is off. */
  preampDb: number;
  gains: number[];
}

export interface EqPreset {
  name: string;
  gains: number[];
}

export const BUILT_IN_EQ_PRESETS: readonly EqPreset[] = [
  { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Bass boost', gains: [6, 6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble boost', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6] },
  { name: 'Vocal', gains: [-3, -3, -2, -1, 0, 0.5, 1, 1.5, 2, 3, 3, 2, 1, 0, 0] },
  { name: 'Loudness', gains: [4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3] },
];

export function flatEq(bandCount: number = DESKTOP_EQ_FREQUENCIES.length): EqSettings {
  return { enabled: false, autoPreamp: true, preampDb: 0, gains: new Array<number>(bandCount).fill(0) };
}

export function eqPreampDb(settings: EqSettings): number {
  return settings.autoPreamp ? -Math.max(0, ...settings.gains) : settings.preampDb;
}

export function eqCurve(settings: EqSettings, frequencies: readonly number[] = DESKTOP_EQ_FREQUENCIES, q = DESKTOP_EQ_Q): EqCurve {
  return {
    enabled: settings.enabled,
    // A clean zero: the engine skips a 0 dB preamp, and -0 would still compare equal.
    preampDb: eqPreampDb(settings) || 0,
    bands: matchedGains(frequencies.map((_, index) => settings.gains[index] ?? 0), frequencies, q)
      .map((gainDb, index) => ({ type: 'peak', freq: frequencies[index], gainDb, q })),
  };
}

/**
 * Filter gains whose summed response hits each slider's gain at its band centre, after Välimäki and Liski,
 * "Accurate cascade graphic equalizer" (2017). Overlapping peaks fed the slider gains directly overshoot and ripple,
 * so this solves the bands' interaction matrix, then refines for the filters' gain nonlinearity.
 * ponytail: solved at 48 kHz; at other rates the top band drifts slightly. Solve per rate in the host if that is ever audible.
 */
export function matchedGains(target: readonly number[], frequencies: readonly number[], q: number, rate = 48000): number[] {
  // Flat stays exactly flat, so the host skips every band and the signal stays bit-identical.
  if (target.every((gain) => gain === 0)) return target.map(() => 0);
  const interaction = frequencies.map((at) => frequencies.map((centre) => peakDb(centre, 1, q, at, rate)));
  let gains = solveLinear(interaction, [...target]);
  for (let pass = 0; pass < 4; pass++) {
    const error = frequencies.map((at, i) => target[i] - frequencies.reduce((sum, centre, j) => sum + peakDb(centre, gains[j], q, at, rate), 0));
    const step = solveLinear(interaction, error);
    gains = gains.map((gain, i) => gain + step[i]);
  }
  return gains.map((gain) => Math.round(Math.max(-EQ_FILTER_LIMIT_DB, Math.min(EQ_FILTER_LIMIT_DB, gain)) * 1000) / 1000 || 0);
}

/** Gaussian elimination with partial pivoting; the interaction matrix is small and well conditioned. */
function solveLinear(matrix: readonly number[][], values: number[]): number[] {
  const rows = matrix.map((row, i) => [...row, values[i]]);
  const n = values.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = rows[r][col] / rows[col][col];
      for (let c = col; c <= n; c++) rows[r][c] -= factor * rows[col][c];
    }
  }
  return rows.map((row, i) => row[n] / row[i]);
}

/** The preset these gains match exactly, if any; otherwise the curve is custom. */
export function eqPresetName(gains: readonly number[], presets: readonly EqPreset[]): string | null {
  return presets.find((preset) => preset.gains.length === gains.length && preset.gains.every((gain, index) => gain === gains[index]))?.name ?? null;
}

const isNumberIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const isGains = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= EQ_MAX_BANDS &&
  value.every((gain) => isNumberIn(gain, -EQ_GAIN_LIMIT_DB, EQ_GAIN_LIMIT_DB));

export function isEqSettings(value: unknown): value is EqSettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['enabled'] === 'boolean' && typeof v['autoPreamp'] === 'boolean' &&
    isNumberIn(v['preampDb'], EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) && isGains(v['gains']);
}

export function isEqPreset(value: unknown): value is EqPreset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['name'] === 'string' && v['name'].trim().length > 0 && v['name'].length <= 60 && isGains(v['gains']);
}

/** The same limits the native host enforces on set-eq. */
export function isEqCurve(value: unknown): value is EqCurve {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['enabled'] === 'boolean' && isNumberIn(v['preampDb'], EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) &&
    Array.isArray(v['bands']) && v['bands'].length <= EQ_MAX_BANDS && v['bands'].every((band: unknown) => {
      if (!band || typeof band !== 'object') return false;
      const b = band as Record<string, unknown>;
      return ['peak', 'lowshelf', 'highshelf'].includes(b['type'] as string) && isNumberIn(b['freq'], 10, 40000) &&
        isNumberIn(b['gainDb'], -EQ_FILTER_LIMIT_DB, EQ_FILTER_LIMIT_DB) && isNumberIn(b['q'], 0.1, 20);
    });
}

/** The curve's gain at one frequency, in dB: what a response graph draws. Same RBJ design as the native host. */
export function eqResponseDb(curve: EqCurve, freq: number, rate = 48000): number {
  if (!curve.enabled) return 0;
  return curve.bands.reduce((db, band) =>
    !band.gainDb || band.type !== 'peak' || band.freq >= 0.45 * rate ? db : db + peakDb(band.freq, band.gainDb, band.q, freq, rate), curve.preampDb);
}

/** One RBJ peak filter's gain at `freq`, in dB. */
function peakDb(centre: number, gainDb: number, q: number, freq: number, rate: number): number {
  const a = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * centre / rate;
  const alpha = Math.sin(w0) / (2 * q), cos = Math.cos(w0), w = 2 * Math.PI * freq / rate;
  const b = [1 + alpha * a, -2 * cos, 1 - alpha * a], d = [1 + alpha / a, -2 * cos, 1 - alpha / a];
  const power = (k: number[]) => (k[0] + k[1] * Math.cos(w) + k[2] * Math.cos(2 * w)) ** 2 + (k[1] * Math.sin(w) + k[2] * Math.sin(2 * w)) ** 2;
  return 10 * Math.log10(power(b) / power(d));
}
