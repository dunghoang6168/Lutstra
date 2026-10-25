import { Component, DestroyRef, ElementRef, EnvironmentInjector, NgZone, afterNextRender, computed, effect, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { CurrentLyricsService, centerLyricLine } from '../../../features/now-playing/current-lyrics.service';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { lyricsOpen } from '../../app-shell';
import { CoverToneService } from '../../cover-tone.service';
import { focusQuietly } from '../../focus';
import { PlayheadSample, playheadAt } from '../../playhead';
import { SwipeDirection, SwipeDirective } from '../../swipe.directive';

/** After the reader scrolls the lines, they are left alone this long before following the song again. */
const FOLLOW_PAUSE_MS = 3000;

/**
 * The playing track's lyrics over Now Playing, after PixelPlayer's LyricsSheet: a solid sheet in the cover's colour,
 * the track in a floating pill (its round cover spins while playing), the lines (the sung one lit and kept in the
 * middle; a tap seeks to it), and at the thumb Play, a seek pill, Back and Synced | Plain. A sideways swipe on the
 * lines changes track. Lyrics come from CurrentLyricsService (a "<same name>.lrc" next to the file). It closes on
 * Escape, which Android Back sends.
 */
@Component({
  selector: 'app-phone-lyrics-sheet',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent, SwipeDirective],
  templateUrl: './phone-lyrics-sheet.component.html',
  styleUrl: './phone-lyrics-sheet.component.scss',
})
export class PhoneLyricsSheetComponent {
  readonly player = inject(PlayerService);
  readonly lyrics = inject(CurrentLyricsService);
  readonly tone = inject(CoverToneService).tone;
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly rootInjector = inject(EnvironmentInjector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly seekBar = viewChild<ElementRef<HTMLElement>>('seekBar');
  /** Synced while the file has timed lines; a file without any timing only reads as Plain. */
  readonly synced = computed(() => this.lyrics.lines().length > 0);
  readonly mode = linkedSignal<boolean, 'synced' | 'plain'>({ source: this.synced, computation: (synced) => synced ? 'synced' : 'plain' });
  readonly active = this.lyrics.activeLineIndex;
  readonly scrubTime = signal<number | null>(null);
  private readonly shownSeconds = signal(0);
  readonly position = computed(() => this.scrubTime() ?? this.shownSeconds());
  private sample: PlayheadSample = { seconds: 0, at: 0 };
  private scrolledAt = 0;

  constructor() {
    afterNextRender(() => {
      focusQuietly(this.host.querySelector<HTMLElement>('.back'));
      // A finger moving or a wheel on the lines (not a tap, nor the follow's own scrolling) pauses the follow.
      // Outside Angular: nothing on screen changes with it.
      const lines = this.viewport()?.nativeElement;
      const scrolled = () => { this.scrolledAt = performance.now(); };
      this.zone.runOutsideAngular(() => {
        lines?.addEventListener('touchmove', scrolled, { passive: true });
        lines?.addEventListener('wheel', scrolled, { passive: true });
      });
    });
    effect(() => {
      this.sample = { seconds: this.player.currentTime(), at: performance.now() };
      this.player.isPlaying();
    });
    this.runPlayhead();
    // The sung line stays in the middle, unless the reader has just scrolled away to read ahead.
    effect(() => {
      const index = this.active();
      const viewport = this.viewport()?.nativeElement;
      if (this.mode() !== 'synced' || !viewport || performance.now() - this.scrolledAt < FOLLOW_PAUSE_MS) return;
      requestAnimationFrame(() => centerLyricLine(viewport, index));
    });
  }

  /** 0 for the sung line, 1 for its neighbours, 2 for the rest: how lit a line is. */
  distance(index: number): number {
    return Math.min(2, Math.abs(index - this.active()));
  }

  setMode(mode: 'synced' | 'plain'): void {
    this.mode.set(mode);
    this.scrolledAt = 0;
    afterNextRender(() => {
      const viewport = this.viewport()?.nativeElement;
      if (viewport) centerLyricLine(viewport, mode === 'synced' ? this.active() : -1);
    }, { injector: this.rootInjector });
  }

  swiped(direction: SwipeDirection): void {
    if (direction === 'left') void this.player.next(); else void this.player.previous(false);
  }

  onSeekInput(event: Event): void {
    this.scrubTime.set(Number((event.target as HTMLInputElement).value));
  }

  onSeekCommit(): void {
    const seconds = this.scrubTime();
    this.scrubTime.set(null);
    if (seconds !== null) this.player.seek(seconds);
  }

  close(): void {
    lyricsOpen.set(false);
    const opener = this.opener;
    afterNextRender(() => { if (opener?.isConnected) focusQuietly(opener); }, { injector: this.rootInjector });
  }

  /** As Now Playing's: the bar's --p follows the playhead each frame, the times change once a second. */
  private runPlayhead(): void {
    const zone = this.zone;
    let frame = 0;
    const tick = () => {
      const duration = this.player.duration() || 0;
      const seconds = this.scrubTime() ?? playheadAt(this.sample, performance.now(), this.player.isPlaying(), duration);
      this.seekBar()?.nativeElement.style.setProperty('--p', String(duration > 0 ? Math.min(1, seconds / duration) : 0));
      const whole = Math.floor(seconds);
      if (whole !== this.shownSeconds()) zone.run(() => this.shownSeconds.set(whole));
      frame = requestAnimationFrame(tick);
    };
    zone.runOutsideAngular(() => { frame = requestAnimationFrame(tick); });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(frame));
  }
}
