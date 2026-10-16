import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { formatTrackQualityLine } from '../../../features/home/library-quality';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { RangeSliderComponent } from '../../../shared/components/range-slider/range-slider.component';

/** Full-screen player over the shell: cover, the file's full measurements between the times, transport and mode. */
@Component({
  selector: 'app-phone-now-playing',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent, RangeSliderComponent],
  templateUrl: './phone-now-playing.component.html',
  styleUrl: './phone-now-playing.component.scss',
})
export class PhoneNowPlayingComponent {
  readonly player = inject(PlayerService);
  private readonly smartShuffle = inject(SmartShuffleService);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly queueButton = viewChild<ElementRef<HTMLButtonElement>>('queueButton');
  private readonly injector = inject(Injector);
  readonly queueOpen = input(false);
  readonly close = output<void>();
  readonly openQueue = output<void>();
  /** While the thumb is held the times follow it; the seek happens on release. */
  readonly scrubTime = signal<number | null>(null);
  private scrubbing = false;
  readonly position = computed(() => this.scrubTime() ?? this.player.currentTime());
  readonly quality = computed(() => {
    const track = this.player.currentTrack();
    return track ? formatTrackQualityLine(track) : null;
  });

  constructor() {
    afterNextRender(() => this.closeButton()?.nativeElement.focus());
    // Focus returns to the queue button once the sheet is gone and this one is no longer inert.
    let queueWasOpen = false;
    effect(() => {
      const open = this.queueOpen();
      if (queueWasOpen && !open) afterNextRender(() => this.queueButton()?.nativeElement.focus(), { injector: this.injector });
      queueWasOpen = open;
    });
  }

  onSeekInput(seconds: number): void {
    if (this.scrubbing) this.scrubTime.set(seconds);
    else this.player.seek(seconds);
  }

  onScrubbing(active: boolean): void {
    this.scrubbing = active;
    if (active) return;
    const seconds = this.scrubTime();
    this.scrubTime.set(null);
    if (seconds !== null) this.player.seek(seconds);
  }

  cyclePlaybackMode(): void {
    void this.smartShuffle.cyclePlaybackMode();
  }
}
