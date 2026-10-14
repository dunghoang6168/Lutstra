import { AfterViewChecked, Component, computed, ElementRef, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { PlayerService } from '../../core/player/player.service';
import { DurationPipe } from '../../shared/pipes/duration.pipe';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { SpectrumVisualizerComponent } from '../../shared/components/spectrum-visualizer/spectrum-visualizer.component';
import { RightPanelService } from '../../core/layout/right-panel.service';
import { LayoutPreferenceService } from '../../core/layout/layout-preference.service';
import { ArtworkGlowPositionService } from '../../core/layout/artwork-glow-position.service';
import { LyricLine } from '../../core/models';
import { CurrentLyricsService, centerLyricLine } from './current-lyrics.service';
import { InlineVolumeControlComponent } from './inline-volume-control.component';
import { SignalPathComponent } from '../../shared/components/signal-path/signal-path.component';
import { WaveformSeekComponent } from './waveform-seek.component';
import { TimelineScrub, timelineFraction } from '../../shared/utils/timeline-scrub';
import { AudioVisualizationPreferenceService } from '../../core/layout/audio-visualization-preference.service';
import { TipDirective } from '../../shared/directives/tip.directive';

@Component({
  selector: 'app-now-playing',
  standalone: true,
  imports: [CommonModule, RouterModule, DurationPipe, IconComponent, SpectrumVisualizerComponent, InlineVolumeControlComponent, WaveformSeekComponent, SignalPathComponent, TipDirective],
  templateUrl: './now-playing.component.html',
  styleUrl: './now-playing.component.scss'
})
export class NowPlayingComponent implements AfterViewChecked, OnDestroy {
  readonly player = inject(PlayerService);
  readonly rightPanels = inject(RightPanelService);
  readonly layoutPreference = inject(LayoutPreferenceService);
  readonly audioVisualization = inject(AudioVisualizationPreferenceService);
  private readonly artworkGlowPosition = inject(ArtworkGlowPositionService);
  private readonly lyrics = inject(CurrentLyricsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly lyricsStatus = this.lyrics.status;
  readonly lyricLines = this.lyrics.lines;
  readonly activeLineIndex = this.lyrics.activeLineIndex;
  readonly trackMetadataLabel = computed(() => {
    const track = this.player.currentTrack();
    if (!track) return '';
    return [track.artist || 'Unknown Artist', track.album, track.year?.toString(), track.genre]
      .filter((value): value is string => Boolean(value))
      .join(' • ');
  });
  private readonly scrub = new TimelineScrub();
  readonly displayTime = computed(() => this.scrub.time() ?? this.player.currentTime());
  readonly displayPercent = computed(() => {
    const duration = this.player.duration();
    return duration > 0 ? Math.min(100, Math.max(0, this.displayTime() / duration * 100)) : 0;
  });
  private destroyed = false;
  private lastScrolledLine: number | null = null;
  private lastScrolledLines: LyricLine[] | null = null;
  private scrollFrame: number | null = null;
  private glowFrame: number | null = null;
  private glowCard: HTMLElement | null = null;
  private glowPage: HTMLElement | null = null;
  private glowObserver: ResizeObserver | null = null;
  private readonly scheduleGlowPosition = (): void => {
    if (this.glowFrame !== null) return;
    this.glowFrame = requestAnimationFrame(() => {
      this.glowFrame = null;
      if (this.destroyed || !this.glowCard) return;
      const appLayout = this.host.nativeElement.closest<HTMLElement>('.app-layout');
      if (!appLayout) return;
      const cover = this.glowCard.getBoundingClientRect();
      const layout = appLayout.getBoundingClientRect();
      if (!cover.width || !cover.height) return;
      this.artworkGlowPosition.setBounds({
        left: cover.left - layout.left,
        top: cover.top - layout.top,
        width: cover.width,
        height: cover.height,
      });
    });
  };

  openTrackDetails(event: MouseEvent): void {
    this.rightPanels.openTrackDetails(event.currentTarget as HTMLElement);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.disconnectGlow();
    this.rightPanels.closeTrackDetails(false);
  }

  ngAfterViewChecked(): void {
    this.syncGlowTarget();
    if (this.lyricsStatus() !== 'ready') return;
    const active = this.activeLineIndex();
    const lines = this.lyricLines();
    if (active === this.lastScrolledLine && lines === this.lastScrolledLines) return;
    this.lastScrolledLine = active;
    this.lastScrolledLines = lines;
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      const viewport = this.host.nativeElement.querySelector<HTMLElement>('.lyrics-lines');
      if (!viewport || this.destroyed) return;
      centerLyricLine(viewport, active);
    });
  }

  private syncGlowTarget(): void {
    const card = this.layoutPreference.mode() === 'inset' && this.player.currentTrack()?.artwork
      ? this.host.nativeElement.querySelector<HTMLElement>('.large-artwork-card') : null;
    if (card === this.glowCard) {
      if (card) this.scheduleGlowPosition();
      return;
    }
    this.disconnectGlow();
    if (!card) return;

    this.glowCard = card;
    this.glowPage = this.host.nativeElement.querySelector<HTMLElement>('.now-playing-page');
    this.glowPage?.addEventListener('scroll', this.scheduleGlowPosition, { passive: true });
    window.addEventListener('resize', this.scheduleGlowPosition);
    this.glowObserver = new ResizeObserver(this.scheduleGlowPosition);
    this.glowObserver.observe(card);
    const content = this.host.nativeElement.querySelector<HTMLElement>('.now-playing-content');
    if (content) this.glowObserver.observe(content);
    const main = this.host.nativeElement.closest<HTMLElement>('.main-content');
    if (main) this.glowObserver.observe(main);
    this.scheduleGlowPosition();
  }

  private disconnectGlow(): void {
    this.glowObserver?.disconnect();
    this.glowObserver = null;
    this.glowPage?.removeEventListener('scroll', this.scheduleGlowPosition);
    this.glowPage = null;
    window.removeEventListener('resize', this.scheduleGlowPosition);
    if (this.glowFrame !== null) cancelAnimationFrame(this.glowFrame);
    this.glowFrame = null;
    this.glowCard = null;
    this.artworkGlowPosition.clear();
  }

  seekToLyric(line: LyricLine): void { this.lyrics.seek(line); }

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

  formatFileSize(bytes: number | null): string {
    if (!bytes) return 'N/A';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
}
