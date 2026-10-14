import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TimelineScrub, timelineFraction } from '../../utils/timeline-scrub';
import { CurrentLyricsService, centerLyricLine } from '../../../features/now-playing/current-lyrics.service';
import { PlayerService } from '../../../core/player/player.service';
import { RightPanelService } from '../../../core/layout/right-panel.service';
import { DurationPipe } from '../../pipes/duration.pipe';
import { IconComponent } from '../icon/icon.component';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { RangeSliderComponent } from '../range-slider/range-slider.component';
import { TipDirective } from '../../directives/tip.directive';
import { SignalPathComponent } from '../signal-path/signal-path.component';
import { MarqueeDirective } from '../../directives/marquee.directive';
import { formatKhz, trackQuality } from '../../../features/home/library-quality';

export type PlayerVariant = 'strip' | 'rail' | 'pill';

@Component({
  selector: 'app-player-bar',
  standalone: true,
  imports: [NgTemplateOutlet, RouterModule, DurationPipe, IconComponent, CoverArtComponent, RangeSliderComponent, SignalPathComponent, TipDirective, MarqueeDirective],
  templateUrl: './player-bar.component.html',
  styleUrl: './player-bar.component.scss'
})
export class PlayerBarComponent {
  readonly player = inject(PlayerService);
  readonly rightPanels = inject(RightPanelService);
  readonly variant = input<PlayerVariant>('strip');
  readonly isQueueOpen = input<boolean>(false);
  readonly toggleQueue = output<void>();
  readonly isVolumeAdjusting = signal(false);
  /** Shows the volume tooltip briefly after a keyboard volume change. */
  readonly isVolumeFlashing = signal(false);
  private volumeFlashTimer?: ReturnType<typeof setTimeout>;
  readonly volumePercent = computed(() => Math.round(this.player.volume() * 100));
  readonly volumePosition = computed(() => `${this.volumePercent()}%`);
  readonly volumeTooltip = computed(() => this.player.isMuted()
    ? `Muted · ${this.volumePercent()}%`
    : `${this.volumePercent()}%`);
  readonly volumeAriaText = computed(() => this.player.isMuted()
    ? `Muted, volume ${this.volumePercent()} percent`
    : `${this.volumePercent()} percent`);

  private readonly scrub = new TimelineScrub();
  readonly displayTime = computed(() => this.scrub.time() ?? this.player.currentTime());
  readonly displayPercent = computed(() => {
    const duration = this.player.duration();
    return duration > 0 ? Math.min(100, Math.max(0, this.displayTime() / duration * 100)) : 0;
  });
  readonly timelineValueText = computed(() =>
    `${formatClock(this.displayTime())} of ${formatClock(this.player.duration())}`);

  /** Ambient's dock: resolution only ("24bit/96kHz", lossy "320 kbps"); accent still marks Hi-Res. */
  readonly pillFormat = computed(() => {
    const track = this.player.currentTrack();
    const quality = track ? trackQuality(track) : null;
    if (!track || !quality) return null;
    const hires = quality === 'hires';
    if (quality === 'lossy') return track.bitrate ? { label: `${Math.round(track.bitrate / 1000)} kbps`, hires } : null;
    if (!track.sampleRate) return null;
    const khz = `${formatKhz(track.sampleRate)}kHz`;
    return { label: track.bitDepth ? `${track.bitDepth}bit/${khz}` : khz, hires };
  });
  /** Amber absence stays visible in the dock even though the rest of the signal path moved to Now Playing. */
  readonly outputDisconnected = computed(() => this.player.audioPathStatus()?.isConnected === false);

  /** Gallery's rail shows the current track's lyrics between the signal path and the timeline. */
  readonly lyrics = inject(CurrentLyricsService);
  readonly railPanelEnabled = signal(false);
  private readonly lyricsViewport = viewChild<ElementRef<HTMLElement>>('lyricsViewport');
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const media = window.matchMedia('(min-height: 701px)');
      const update = () => this.railPanelEnabled.set(media.matches);
      update();
      media.addEventListener('change', update);
      this.destroyRef.onDestroy(() => media.removeEventListener('change', update));
    });
    // Keep the active line centred; re-runs when the line, the track's lines or the viewport change.
    afterRenderEffect(() => {
      const viewport = this.lyricsViewport()?.nativeElement;
      const active = this.lyrics.activeLineIndex();
      this.lyrics.lines();
      if (viewport) centerLyricLine(viewport, active);
    });
  }

  flashVolume(): void {
    this.isVolumeFlashing.set(true);
    clearTimeout(this.volumeFlashTimer);
    this.volumeFlashTimer = setTimeout(() => this.isVolumeFlashing.set(false), 1000);
  }

  /** ↑/↓ on the volume slider step 5% like the app shortcut; ←/→ and dragging keep the native 1%. */
  stepVolume(event: Event, delta: number): void {
    event.preventDefault();
    this.player.setVolume(Math.round((this.player.volume() + delta) * 100) / 100);
  }

  onTimelinePointerDown(event: PointerEvent): void {
    if (!this.canSeek()) return;
    const target = event.currentTarget as HTMLElement;
    try { target.setPointerCapture(event.pointerId); } catch { /* Synthetic events may not own a pointer. */ }
    this.previewFromClientX(event.clientX, target);
    event.preventDefault();
  }

  onTimelinePointerMove(event: PointerEvent): void {
    if (!this.scrub.active) return;
    this.previewFromClientX(event.clientX, event.currentTarget as HTMLElement);
  }

  onTimelinePointerUp(event: PointerEvent): void {
    if (!this.scrub.active) return;
    this.previewFromClientX(event.clientX, event.currentTarget as HTMLElement);
    const time = this.scrub.end();
    if (time !== null) this.player.seek(time);
    this.releasePointer(event);
  }

  onTimelinePointerCancel(event: PointerEvent): void {
    this.scrub.cancel();
    this.releasePointer(event);
  }

  onTimelineKeyDown(event: KeyboardEvent): void {
    if (!this.canSeek()) return;
    const duration = this.player.duration();
    let nextPosition: number | null = null;
    if (event.key === 'ArrowLeft') nextPosition = this.player.currentTime() - 5;
    else if (event.key === 'ArrowRight') nextPosition = this.player.currentTime() + 5;
    else if (event.key === 'Home') nextPosition = 0;
    else if (event.key === 'End') nextPosition = duration;
    if (nextPosition === null) return;
    event.preventDefault();
    this.player.seek(Math.max(0, Math.min(duration, nextPosition)));
  }

  private previewFromClientX(clientX: number, target: HTMLElement): void {
    const fraction = timelineFraction(clientX, target.getBoundingClientRect());
    if (fraction !== null && this.player.duration() > 0) this.scrub.preview(fraction * this.player.duration());
  }

  private releasePointer(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    try {
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    } catch { /* Pointer capture may already be released. */ }
  }

  private canSeek(): boolean {
    return Boolean(this.player.currentTrack()) && this.player.duration() > 0;
  }
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
