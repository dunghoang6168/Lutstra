import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, ViewChild, effect, inject, input } from '@angular/core';
import { AUDIO_ANALYSIS_ENGINE } from '../../../core/contracts';
import { PlayerService } from '../../../core/player/player.service';
import { ThemeService } from '../../../core/theme/theme.service';
import { FrequencyBand, createLogFrequencyBands, decaySpectrumLevels, updateSpectrumLevels } from './spectrum-utils';

const CANVAS_RESIZE_DEBOUNCE_MS = 120;

@Component({
  selector: 'app-spectrum-visualizer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './spectrum-visualizer.component.html',
  styleUrl: './spectrum-visualizer.component.scss',
})
export class SpectrumVisualizerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** Bands from `minHz` to `maxHz`, read once when analysis starts. */
  readonly barCount = input(48);
  readonly minHz = input(40);
  readonly maxHz = input(16_000);
  /** Draw each band twice, mirrored out from the centre (lowest band at the centre). */
  readonly mirrored = input(false);
  /** Bars hang down from the top edge. */
  readonly flipped = input(false);
  /** Canvas only: no frame, label or paused status. */
  readonly bare = input(false);
  /** Colour token for the bars. Accent fades to `--accent-muted`; any other token is drawn solid. */
  readonly colorVar = input('--accent-primary');
  /** Re-read the colour token every frame, for a token that animates (a colour that cycles). */
  readonly liveColor = input(false);

  private readonly analysis = inject(AUDIO_ANALYSIS_ENGINE);
  readonly player = inject(PlayerService);
  private readonly theme = inject(ThemeService);
  private readonly zone = inject(NgZone);
  private readonly host = inject(ElementRef<HTMLElement>);
  private levels = new Float32Array(0);
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private bands: FrequencyBand[] = [];
  private frameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceId: number | null = null;
  private preparing: Promise<boolean> | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private viewReady = false;
  private destroyed = false;
  private accentColor = '#8b5cf6';
  private accentMuted = 'rgba(139, 92, 246, 0.15)';
  private baselineColor = 'rgba(255, 255, 255, 0.12)';

  private readonly playbackEffect = effect(() => {
    this.player.currentTrack();
    this.player.playbackState();
    if (this.viewReady) this.syncPlaybackState();
  });

  private readonly themeEffect = effect(() => {
    this.theme.effectiveTheme();
    this.theme.themePreset();
    this.theme.accentColor();
    this.colorVar();
    if (this.viewReady) {
      this.readThemeColors();
      this.draw();
    }
  });

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.levels = new Float32Array(this.barCount());
    this.host.nativeElement.hidden = !this.analysis.isAnalysisSupported;
    this.context = this.canvasRef.nativeElement.getContext('2d');
    this.readThemeColors();
    this.resizeCanvas();
    if (typeof ResizeObserver === 'function') {
      this.zone.runOutsideAngular(() => {
        this.resizeObserver = new ResizeObserver(() => this.scheduleCanvasResize());
        this.resizeObserver.observe(this.canvasRef.nativeElement);
      });
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.reducedMotion.addEventListener('change', this.onMotionPreferenceChange);
    this.syncPlaybackState();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopLoop();
    this.cancelCanvasResize();
    this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.reducedMotion.removeEventListener('change', this.onMotionPreferenceChange);
  }

  private syncPlaybackState(): void {
    if (!this.player.currentTrack() || !this.player.isPlaying()) {
      this.levels.fill(0);
      this.stopLoop();
      this.draw();
      return;
    }

    void this.ensurePrepared().then((ready) => {
      if (!ready || this.destroyed || document.hidden) return;
      if (this.reducedMotion.matches) {
        if (this.player.isPlaying()) this.readLiveData(0.1);
        else decaySpectrumLevels(this.levels, 0.78);
        this.draw();
        return;
      }
      this.startLoop();
    });
  }

  private ensurePrepared(): Promise<boolean> {
    if (this.frequencyData) return Promise.resolve(true);
    if (!this.analysis.isAnalysisSupported) {
      this.host.nativeElement.hidden = true;
      return Promise.resolve(false);
    }
    if (this.preparing) return this.preparing;

    this.preparing = this.analysis.prepareFrequencyAnalysis().then((binCount) => {
      if (binCount <= 0 || this.destroyed) {
        this.host.nativeElement.hidden = true;
        return false;
      }
      this.frequencyData = new Uint8Array(binCount);
      this.bands = createLogFrequencyBands(binCount, this.levels.length, undefined, this.minHz(), this.maxHz());
      this.host.nativeElement.hidden = false;
      return true;
    }).catch(() => {
      this.host.nativeElement.hidden = true;
      return false;
    }).finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  private startLoop(): void {
    if (this.frameId !== null || this.destroyed || document.hidden) return;
    this.zone.runOutsideAngular(() => {
      let lastFrameTime = performance.now();
      const render = (now: number) => {
        this.frameId = null;
        if (this.destroyed || document.hidden || this.reducedMotion.matches) return;
        const dt = Math.min(0.1, Math.max(0, now - lastFrameTime) / 1000);
        lastFrameTime = now;

        const state = this.player.playbackState();
        let keepRendering = true;
        if (state === 'playing') this.readLiveData(dt);
        else if (state === 'loading') keepRendering = decaySpectrumLevels(this.levels, 0.985);
        else keepRendering = decaySpectrumLevels(this.levels, 0.9);
        if (this.liveColor()) this.readThemeColors();
        this.draw();

        if (keepRendering) this.frameId = requestAnimationFrame(render);
      };
      this.frameId = requestAnimationFrame(render);
    });
  }

  private stopLoop(): void {
    if (this.frameId === null) return;
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private readLiveData(dtSeconds: number): void {
    if (!this.frequencyData || !this.analysis.readFrequencyData(this.frequencyData)) return;
    updateSpectrumLevels(this.frequencyData, this.bands, this.levels, dtSeconds);
  }

  private resizeCanvas(): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private scheduleCanvasResize(): void {
    this.cancelCanvasResize();
    this.resizeDebounceId = window.setTimeout(() => {
      this.resizeDebounceId = null;
      if (this.destroyed) return;
      this.resizeCanvas();
      this.draw();
    }, CANVAS_RESIZE_DEBOUNCE_MS);
  }

  private cancelCanvasResize(): void {
    if (this.resizeDebounceId === null) return;
    window.clearTimeout(this.resizeDebounceId);
    this.resizeDebounceId = null;
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const context = this.context;
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    context.clearRect(0, 0, width, height);

    const horizontalPadding = 12;
    // A bare flipped spectrum hangs from its very top edge.
    const topPadding = this.bare() ? (this.flipped() ? 0 : 4) : 24;
    const bottomPadding = this.bare() ? 4 : 10;
    const availableWidth = Math.max(1, width - horizontalPadding * 2);
    const availableHeight = Math.max(1, height - topPadding - bottomPadding);
    const flipped = this.flipped();
    const baseline = flipped ? topPadding : height - bottomPadding;

    if (!this.player.isPlaying()) {
      context.fillStyle = this.baselineColor;
      context.fillRect(horizontalPadding, flipped ? baseline : baseline - 1, availableWidth, 1);
      return;
    }

    const count = this.levels.length;
    const mirrored = this.mirrored();
    const columns = mirrored ? count * 2 : count;
    const gap = Math.max(2, Math.min(4, availableWidth / 180));
    const barWidth = Math.max(1, (availableWidth - gap * (columns - 1)) / columns);
    // The solid colour sits at the bars' tips, so a flipped spectrum fades downwards.
    const gradient = flipped
      ? context.createLinearGradient(0, height - bottomPadding, 0, topPadding)
      : context.createLinearGradient(0, topPadding, 0, height - bottomPadding);
    gradient.addColorStop(0, this.accentColor);
    gradient.addColorStop(1, this.accentMuted);
    context.fillStyle = gradient;

    const centre = width / 2;
    for (let index = 0; index < count; index++) {
      const barHeight = Math.max(2, this.levels[index] * availableHeight);
      const y = flipped ? baseline : baseline - barHeight;
      if (mirrored) {
        const step = gap / 2 + index * (barWidth + gap);
        drawRoundedBar(context, centre + step, y, barWidth, barHeight);
        drawRoundedBar(context, centre - step - barWidth, y, barWidth, barHeight);
      } else {
        drawRoundedBar(context, horizontalPadding + index * (barWidth + gap), y, barWidth, barHeight);
      }
    }
  }

  private readThemeColors(): void {
    const styles = getComputedStyle(this.host.nativeElement);
    const colorVar = this.colorVar();
    this.accentColor = styles.getPropertyValue(colorVar).trim() || '#8b5cf6';
    this.accentMuted = colorVar === '--accent-primary'
      ? styles.getPropertyValue('--accent-muted').trim() || 'rgba(139, 92, 246, 0.15)'
      : this.accentColor;
    this.baselineColor = styles.getPropertyValue('--border-default').trim()
      || styles.getPropertyValue('--border-subtle').trim()
      || 'rgba(255, 255, 255, 0.12)';
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stopLoop();
    else this.syncPlaybackState();
  };

  private readonly onMotionPreferenceChange = (): void => {
    this.stopLoop();
    this.syncPlaybackState();
  };
}

function drawRoundedBar(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  const radius = Math.min(width / 2, 3);
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}
