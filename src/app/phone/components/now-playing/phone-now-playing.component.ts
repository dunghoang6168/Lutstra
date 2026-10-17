import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { formatTrackQualityLine } from '../../../features/home/library-quality';
import { loadMixerRate, mixerRate, outputPath } from '../../app-shell';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { RangeSliderComponent } from '../../../shared/components/range-slider/range-slider.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { SwipeDirection, SwipeDirective } from '../../swipe.directive';
import { focusQuietly } from '../../focus';

type TransportButton = 'prev' | 'play' | 'next';


/**
 * Full-screen player over the shell, after PixelPlayer's: the blurred cover as ground, a cover that swipes to
 * change track, the file's measurements between the times, three transport pills and the shuffle/repeat toggles.
 */
@Component({
  selector: 'app-phone-now-playing',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent, RangeSliderComponent, SwipeDirective],
  templateUrl: './phone-now-playing.component.html',
  styleUrl: './phone-now-playing.component.scss',
})
export class PhoneNowPlayingComponent {
  readonly player = inject(PlayerService);
  readonly library = inject(PhoneLibraryService);
  private readonly smartShuffle = inject(SmartShuffleService);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly queueButton = viewChild<ElementRef<HTMLButtonElement>>('queueButton');
  private readonly injector = inject(Injector);
  readonly queueOpen = input(false);
  /** Inert under the queue or the track actions sheet, which sit above it. */
  readonly covered = computed(() => this.queueOpen() || this.library.actionTracks() !== null);
  /** The transport pill just pressed, which widens for a moment while the others give way. */
  readonly pressed = signal<TransportButton | null>(null);
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  readonly shuffleLabel = computed(() => this.player.smartShuffle() ? 'Shuffle: Smart Shuffle. Tap to turn off'
    : this.player.isShuffle() ? 'Shuffle: on. Tap for Smart Shuffle' : 'Shuffle: off. Tap to turn on');
  readonly repeatLabel = computed(() => this.player.smartShuffle() ? 'Repeat: off while Smart Shuffle is on'
    : { off: 'Repeat: off. Tap to repeat all', all: 'Repeat: all. Tap to repeat one', one: 'Repeat: one. Tap to turn off' }[this.player.repeatMode()]);
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

  /** Where the sound goes: the mixer's rate, and whether this file is resampled to reach it. */
  readonly output = computed(() => outputPath(this.player.currentTrack()?.sampleRate ?? null, mixerRate()));

  constructor() {
    // The output can change while the app is open (headphones, Bluetooth), so it is read on every open.
    void loadMixerRate();
    afterNextRender(() => focusQuietly(this.closeButton()?.nativeElement));
    // Focus returns to the queue button once the sheet is gone and this one is no longer inert.
    let queueWasOpen = false;
    effect(() => {
      const open = this.queueOpen();
      if (queueWasOpen && !open) afterNextRender(() => focusQuietly(this.queueButton()?.nativeElement), { injector: this.injector });
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

  /** Off → Shuffle → Smart Shuffle → Off, as on the desktop shuffle button. */
  cycleShuffle(): void {
    void this.smartShuffle.cycleShuffle();
  }

  coverSwiped(direction: SwipeDirection): void {
    if (direction === 'left') this.player.next(); else this.player.previous();
  }

  press(button: TransportButton): void {
    this.pressed.set(button);
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.pressed.set(null), 220); // --phone-press-dur
  }
}
