import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { EqService } from '../../core/eq/eq.service';
import { BUILT_IN_EQ_PRESETS, DESKTOP_EQ_FREQUENCIES, EQ_GAIN_LIMIT_DB, EQ_PREAMP_MAX_DB, EQ_PREAMP_MIN_DB, eqCurve, eqResponseDb } from '../../core/models';
import { PlayerService } from '../../core/player/player.service';
import { RangeSliderComponent } from '../../shared/components/range-slider/range-slider.component';
import { FilterChoice, SearchableFilterSelectComponent } from '../../shared/components/searchable-filter-select/searchable-filter-select.component';

/** Response graph geometry: 20 Hz–20 kHz on a log axis, ±15 dB. Its width is the bands' min-width (38rem), so labels never render below their size. */
const GRAPH = { width: 608, height: 172, left: 34, right: 8, top: 30, bottom: 20, db: 15 };
const graphX = (freq: number) => GRAPH.left + (GRAPH.width - GRAPH.left - GRAPH.right) * Math.log(freq / 20) / Math.log(1000);
const graphY = (db: number) => GRAPH.top + (GRAPH.height - GRAPH.top - GRAPH.bottom) * (GRAPH.db - db) / (2 * GRAPH.db);

/** Bass, mid and treble, split halfway (geometrically) between neighbouring bands: 160|250 → 200 Hz, 2.5k|4k → 3.2 kHz. */
const REGIONS = [{ name: 'Bass', from: 20, to: 200 }, { name: 'Mid', from: 200, to: 3200 }, { name: 'Treble', from: 3200, to: 20000 }];
const regionOf = (freq: number) => REGIONS.findIndex((region) => freq >= region.from && freq < region.to);

/** Settings › Equalizer: the 15-band EQ of the output Lutstra plays to. */
@Component({
  selector: 'app-eq-settings',
  standalone: true,
  imports: [SearchableFilterSelectComponent, RangeSliderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './eq-settings.component.html',
  styleUrl: './eq-settings.component.scss',
})
export class EqSettingsComponent {
  readonly eq = inject(EqService);
  readonly player = inject(PlayerService);
  readonly gainLimit = EQ_GAIN_LIMIT_DB;
  readonly preampMin = EQ_PREAMP_MIN_DB;
  readonly preampMax = EQ_PREAMP_MAX_DB;
  readonly graph = GRAPH;
  readonly bands = DESKTOP_EQ_FREQUENCIES.map((freq, index, all) => ({
    index, region: regionOf(freq), label: hzLabel(freq), name: `${hzName(freq)} gain`,
    // A lit region is one shape, so only its outer columns round their corners.
    regionStart: index === 0 || regionOf(all[index - 1]) !== regionOf(freq),
    regionEnd: index === all.length - 1 || regionOf(all[index + 1]) !== regionOf(freq),
  }));
  readonly regions = REGIONS.map((region, index) => ({
    index, name: region.name, x: graphX(region.from), width: graphX(region.to) - graphX(region.from), labelX: (graphX(region.from) + graphX(region.to)) / 2,
  }));
  /** The region under the pointer or keyboard focus: the graph and its sliders light together. */
  readonly hoveredRegion = signal(-1);
  readonly gridLines = [12, 6, 0, -6, -12].map((db) => ({ db, y: graphY(db), label: db > 0 ? `+${db}` : `${db}` }));
  readonly decades = [100, 1000, 10000].map((freq) => ({ x: graphX(freq), label: `${hzLabel(freq)}Hz` }));
  readonly saveName = signal('');
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  readonly disabled = computed(() => !this.eq.available());
  /** A curve that matches no preset shows as Custom, which cannot be picked. */
  readonly presetOptions = computed<FilterChoice[]>(() => [
    ...(this.eq.presetName() ? [] : [{ value: '', label: 'Custom' }]),
    ...this.eq.presets().map((preset) => ({ value: preset.name, label: preset.name })),
  ]);
  readonly isUserPreset = computed(() => {
    const name = this.eq.presetName();
    return !!name && !BUILT_IN_EQ_PRESETS.some((preset) => preset.name === name);
  });
  /** The curve as heard, drawn with the host's own filter design at 48 kHz. */
  readonly responsePoints = computed(() => {
    const curve = { ...eqCurve(this.eq.current()), enabled: true };
    const points: string[] = [];
    for (let step = 0; step <= 240; step++) {
      const freq = 20 * Math.pow(1000, step / 240);
      const db = Math.max(-GRAPH.db, Math.min(GRAPH.db, eqResponseDb(curve, freq)));
      points.push(`${graphX(freq).toFixed(1)},${graphY(db).toFixed(1)}`);
    }
    return points.join(' ');
  });

  readonly formatDb = formatDb;

  startSave(): void {
    this.saveName.set(this.isUserPreset() ? this.eq.presetName()! : '');
    this.saveError.set(null);
    this.saving.set(true);
  }

  confirmSave(event: Event): void {
    event.preventDefault();
    if (this.eq.savePreset(this.saveName())) this.saving.set(false);
    else this.saveError.set('Use a name up to 60 characters that is not a built-in preset.');
  }
}

function hzLabel(freq: number): string {
  return freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
}

function hzName(freq: number): string {
  return freq >= 1000 ? `${freq / 1000} kHz` : `${freq} Hz`;
}

/** Signed, with a true minus sign: "+6", "−2.5", "0". */
export function formatDb(value: number): string {
  const magnitude = Number.isInteger(value) ? `${Math.abs(value)}` : Math.abs(value).toFixed(1);
  return value > 0 ? `+${magnitude}` : value < 0 ? `−${magnitude}` : '0';
}
