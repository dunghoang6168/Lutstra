import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { audioPathOpen, describeOutput, loadOutput, output as liveOutput } from '../../app-shell';
import { CoverToneService } from '../../cover-tone.service';
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
 * change track, the output path between the times, three transport pills and the shuffle/repeat toggles, all
 * tinted from the cover (`cover-tinted` in _base.scss).
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
  readonly covered = computed(() => this.queueOpen() || this.library.actionTracks() !== null || audioPathOpen());
  /** The transport pill just pressed, which widens for a moment while the others give way. */
  readonly pressed = signal<TransportButton | null>(null);
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  readonly shuffleLabel = computed(() => this.player.smartShuffle() ? 'Shuffle: Smart Shuffle. Tap to turn off'
    : this.player.isShuffle() ? 'Shuffle: on. Tap for Smart Shuffle' : 'Shuffle: off. Tap to turn on');
  readonly shuffleText = computed(() => this.player.smartShuffle() ? 'Smart Shuffle' : this.player.isShuffle() ? 'Shuffle' : 'Shuffle off');
  readonly repeatText = computed(() => this.player.smartShuffle() ? 'Repeat off'
    : { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[this.player.repeatMode()]);
  readonly repeatLabel = computed(() => this.player.smartShuffle() ? 'Repeat: off while Smart Shuffle is on'
    : { off: 'Repeat: off. Tap to repeat all', all: 'Repeat: all. Tap to repeat one', one: 'Repeat: one. Tap to turn off' }[this.player.repeatMode()]);
  readonly close = output<void>();
  readonly openQueue = output<void>();
  /** While the thumb is held the times follow it; the seek happens on release. */
  readonly scrubTime = signal<number | null>(null);
  private scrubbing = false;
  readonly position = computed(() => this.scrubTime() ?? this.player.currentTime());
  /** The cover's hue and chroma, which tint the controls as PixelPlayer's album scheme does; null without a cover. */
  readonly tone = inject(CoverToneService).tone;
  /** Where the sound goes: the path, what Lutstra hands Android and the device's rate. The file's own format is in the ⋯ sheet and the mini player. */
  readonly output = computed(() => describeOutput(liveOutput()));

  constructor() {
    // The plugin keeps the output live (headphones, Bluetooth, a USB DAC); this reads it the first time.
    void loadOutput();
    afterNextRender(() => focusQuietly(this.closeButton()?.nativeElement));
    // Focus returns to the queue button once the sheet is gone and this one is no longer inert.
    let queueWasOpen = false;
    effect(() => {
      const open = this.queueOpen();
      if (queueWasOpen && !open) afterNextRender(() => focusQuietly(this.queueButton()?.nativeElement), { injector: this.injector });
      queueWasOpen = open;
    });
  }

  openAudioPath(): void {
    audioPathOpen.set(true);
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
