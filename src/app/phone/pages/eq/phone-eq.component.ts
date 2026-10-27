import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EQ_GAIN_LIMIT_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB } from '../../../core/models/eq.model';
import { IconComponent, IconName } from '../../../shared/components/icon/icon.component';
import { describeOutput, output } from '../../app-shell';
import { PhoneEqService } from '../../eq/phone-eq.service';
import { PHONE_EFFECTS, PHONE_EQ_FREQUENCIES, PhoneEffect, effectFilters, monotoneSlopes, responseDb } from '../../eq/phone-eq';

const CURVE_W = 334;
const CURVE_H = 64;
/** ±15 dB, as the desktop graph: a +12 band and its slight overshoot stay inside the box. */
const CURVE_DB = 15;
/** Half a decibel per step on the cut side (24 steps to -12 dB). */
const PREAMP_STEPS = 24;
const EFFECT_INFO: Record<PhoneEffect, { label: string; hint: string; icon: IconName }> = {
  bassBoost: { label: 'Bass Boost', hint: 'Low shelf for more weight', icon: 'speaker' },
  virtualizer: { label: 'Virtualizer', hint: 'Wider stereo for headphones', icon: 'headphones' },
  loudness: { label: 'Loudness', hint: 'Keeps bass and treble at low volume', icon: 'volume-2' },
};

/** The EQ tab in Material 3 cards: presets, the response curve over ten bands, preamp, three effects. Always on; Flat is off. */
@Component({
  selector: 'app-phone-eq',
  standalone: true,
  imports: [RouterLink, IconComponent],
  templateUrl: './phone-eq.component.html',
  styleUrls: ['../../phone-seek.scss', './phone-eq.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneEqComponent {
  readonly eq = inject(PhoneEqService);
  readonly limit = EQ_GAIN_LIMIT_DB;
  readonly preampMin = EQ_PREAMP_MIN_DB;
  readonly preampMax = EQ_PREAMP_MAX_DB;
  readonly curveW = CURVE_W;
  readonly curveH = CURVE_H;
  /** The EQ is kept per output, so the card says which one it is editing. */
  readonly outputName = computed(() => describeOutput(output())?.device ?? 'Phone speaker');

  readonly bands = computed(() => PHONE_EQ_FREQUENCIES.map((freq, index) => {
    const gain = this.eq.current().gains[index];
    return { index, label: freq >= 1000 ? `${freq / 1000}k` : String(freq), freq, gain, ...railFill(gain, -this.limit, this.limit) };
  }));

  /**
   * 0 dB sits mid-rail: each half spans its own range (cut to -12, boost to +6), so the rail reads the same both ways.
   * The input runs in rail steps, -PREAMP_STEPS..PREAMP_STEPS; p (0–1) places the slider's thumb.
   */
  readonly preampSteps = PREAMP_STEPS;
  readonly preamp = computed(() => {
    const value = this.eq.preampDb();
    const at = value < 0 ? -value / this.preampMin * -PREAMP_STEPS : value / this.preampMax * PREAMP_STEPS;
    return { value, at, p: (at + PREAMP_STEPS) / (2 * PREAMP_STEPS) };
  });

  /**
   * A smooth line through the sliders, each point over its column, as Poweramp and PixelPlayer draw it. Effects add
   * their lift at each band. Monotone, so equal neighbours meet in a flat line instead of a bump or a dip; the filters'
   * own ripple between centres (about ±0.5 dB) is left out on purpose.
   */
  readonly curvePath = computed(() => {
    const effects = effectFilters(this.eq.current().effects);
    const gains = this.eq.current().gains.map((gain, i) => gain + responseDb(effects, PHONE_EQ_FREQUENCIES[i]));
    const step = CURVE_W / gains.length;
    const ys = gains.map((db) => CURVE_H / 2 - Math.max(-CURVE_DB, Math.min(CURVE_DB, db)) / CURVE_DB * (CURVE_H / 2 - 4));
    const slopes = monotoneSlopes(ys, step);
    const x = (i: number) => (i + 0.5) * step;
    let d = `M0,${ys[0].toFixed(1)} L${x(0).toFixed(1)},${ys[0].toFixed(1)}`;
    for (let i = 0; i < ys.length - 1; i++) {
      const c1 = `${(x(i) + step / 3).toFixed(1)},${(ys[i] + slopes[i] * step / 3).toFixed(1)}`;
      const c2 = `${(x(i + 1) - step / 3).toFixed(1)},${(ys[i + 1] - slopes[i + 1] * step / 3).toFixed(1)}`;
      d += ` C${c1} ${c2} ${x(i + 1).toFixed(1)},${ys[i + 1].toFixed(1)}`;
    }
    return `${d} L${CURVE_W},${ys[ys.length - 1].toFixed(1)}`;
  });
  readonly curveFill = computed(() => `${this.curvePath()} L${CURVE_W},${CURVE_H} L0,${CURVE_H} Z`);

  readonly effects = computed(() => PHONE_EFFECTS.map((name) => ({ name, ...EFFECT_INFO[name], ...this.eq.current().effects[name] })));

  onGain(index: number, event: Event): void {
    this.eq.setGain(index, Number((event.target as HTMLInputElement).value));
  }

  onPreamp(event: Event): void {
    const at = Number((event.target as HTMLInputElement).value);
    this.eq.setPreamp(at < 0 ? at / PREAMP_STEPS * -this.preampMin : at / PREAMP_STEPS * this.preampMax);
  }

  onEffectAmount(name: PhoneEffect, event: Event): void {
    this.eq.setEffect(name, { amount: Number((event.target as HTMLInputElement).value) });
  }

  savePreset(): void {
    const name = prompt('Name this preset');
    if (name === null) return;
    if (!this.eq.savePreset(name)) alert('Choose a name that is not a built-in preset, up to 40 characters.');
  }

  /** A long press on one of your presets offers to delete it. */
  onPresetHold(event: Event, name: string): void {
    if (!this.eq.isUserPreset(name)) return;
    event.preventDefault();
    if (confirm(`Delete the preset “${name}”?`)) this.eq.deletePreset(name);
  }

  dbText(value: number): string {
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
  }

  /** Band values over narrow columns: "+5", "-1.5", "0". */
  dbShort(value: number): string {
    return `${value > 0 ? '+' : ''}${value % 1 ? value.toFixed(1) : value}`;
  }
}

/** Where a rail's thumb and its fill from 0 dB sit, as percentages from the bottom. */
function railFill(value: number, min: number, max: number): { pos: number; fillFrom: number; fillSize: number } {
  const at = (v: number) => (v - min) / (max - min) * 100;
  const pos = at(value);
  const zero = at(0);
  return { pos, fillFrom: Math.min(pos, zero), fillSize: Math.abs(pos - zero) };
}
