import { Component, DestroyRef, ElementRef, Injector, NgZone, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { audioPathOpen, describeOutput, loadOutput, output as liveOutput } from '../../app-shell';
import { CoverToneService } from '../../cover-tone.service';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { SwipeDirection, SwipeDirective } from '../../swipe.directive';
import { focusQuietly } from '../../focus';
import { PlayheadSample, playheadAt } from '../../playhead';

const REMAINING_KEY = 'lutstra.phone.timeRemaining';
/** Swipe up to the queue: a slow drag must cover this share of the screen; a flick (px/ms) only `SWIPE_UP_MIN_PX`. */
const SWIPE_UP_SHARE = 0.12;
const SWIPE_UP_SPEED = 0.5;
const SWIPE_UP_MIN_PX = 40;

type TransportButton = 'prev' | 'play' | 'next';


/**
 * Full-screen player over the shell, after PixelPlayer's: the blurred cover as ground, a cover that swipes to
 * change track, the output path between the times, three transport pills and the shuffle/repeat toggles, all
 * tinted from the cover (`cover-tinted` in _base.scss).
 */
@Component({
  selector: 'app-phone-now-playing',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent, SwipeDirective],
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
  /** While the bar is held the times follow the finger; the seek happens on release. */
  readonly scrubTime = signal<number | null>(null);
  readonly dragging = signal(false);
  /** The playhead's whole second, for the times; the bar itself moves every frame (see the constructor). */
  private readonly shownSeconds = signal(0);
  readonly position = computed(() => this.scrubTime() ?? this.shownSeconds());
  readonly remaining = computed(() => Math.max(0, (this.player.duration() || 0) - this.position()));
  /** The right-hand time shows the length or, after a tap, the time left; kept for this phone only. */
  readonly showRemaining = signal(readRemaining());
  private readonly seekBar = viewChild<ElementRef<HTMLElement>>('seekBar');
  private readonly cover = viewChild('cover', { read: CoverArtComponent });
  private sample: PlayheadSample = { seconds: 0, at: 0 };
  /** The cover's hue and chroma, which tint the controls as PixelPlayer's album scheme does; null without a cover. */
  readonly tone = inject(CoverToneService).tone;
  /** Where the sound goes: the path, what Lutstra hands Android and the device's rate. The file's own format is in the ⋯ sheet and the mini player. */
  readonly output = computed(() => describeOutput(liveOutput()));

  constructor() {
    // The plugin keeps the output live (headphones, Bluetooth, a USB DAC); this reads it the first time.
    void loadOutput();
    afterNextRender(() => focusQuietly(this.closeButton()?.nativeElement));
    // A new report from the player (every 500 ms, or a seek) restarts the run-on from there.
    effect(() => {
      this.sample = { seconds: this.player.currentTime(), at: performance.now() };
      this.player.isPlaying();
    });
    this.runPlayhead();
    this.followSwipeUp();
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

  /**
   * A swipe up opens the queue, after PixelPlayer's. It counts only when the sheet did not scroll and sits at its end,
   * so on a short screen scrolling down still scrolls; the seek bar keeps its own drag. Outside Angular until it fires.
   */
  private followSwipeUp(): void {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const zone = inject(NgZone);
    let start: { x: number; y: number; t: number; scroll: number } | null = null;
    const sheet = () => host.querySelector<HTMLElement>('.now-playing');
    zone.runOutsideAngular(() => {
      host.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        const target = event.target as Element;
        start = event.touches.length === 1 && !target.closest('input') && !this.queueOpen()
          ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp, scroll: sheet()?.scrollTop ?? 0 }
          : null;
      }, { passive: true });
      host.addEventListener('touchend', (event) => {
        const from = start;
        start = null;
        const el = sheet();
        if (!from || !el) return;
        const touch = event.changedTouches[0];
        const up = from.y - touch.clientY;
        const sideways = Math.abs(touch.clientX - from.x);
        const quick = up / Math.max(1, event.timeStamp - from.t) >= SWIPE_UP_SPEED;
        const far = up >= innerHeight * SWIPE_UP_SHARE || (quick && up >= SWIPE_UP_MIN_PX);
        const settled = el.scrollTop === from.scroll && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if (far && up > 2 * sideways && settled) zone.run(() => this.openQueue.emit());
      }, { passive: true });
    });
  }

  /** Each frame, outside Angular: the bar's --p follows the playhead; the times change only on a new second. */
  private runPlayhead(): void {
    const zone = inject(NgZone);
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

  /** A drag only moves the times; a key press (or a tap) seeks at once. */
  onSeekInput(event: Event): void {
    const seconds = Number((event.target as HTMLInputElement).value);
    if (this.dragging()) this.scrubTime.set(seconds);
    else this.player.seek(seconds);
  }

  onSeekCommit(): void {
    const seconds = this.scrubTime();
    this.dragging.set(false);
    this.scrubTime.set(null);
    if (seconds !== null) this.player.seek(seconds);
  }

  toggleRemaining(): void {
    this.showRemaining.update((on) => !on);
    try { localStorage.setItem(REMAINING_KEY, this.showRemaining() ? '1' : '0'); } catch { /* the choice lasts this session */ }
  }

  /** Off → Shuffle → Smart Shuffle → Off, as on the desktop shuffle button. */
  cycleShuffle(): void {
    void this.smartShuffle.cycleShuffle();
  }

  coverSwiped(direction: SwipeDirection): void {
    if (direction === 'left') this.player.next(); else this.player.previous();
  }

  /** The swipe is the transition: the new cover drops in without its crossfade, so the old one never slides back in. */
  readonly coverReady = () => this.cover()?.showNow(this.player.currentTrack()?.artwork ?? null);

  press(button: TransportButton): void {
    this.pressed.set(button);
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.pressed.set(null), 220); // --phone-press-dur
  }
}

function readRemaining(): boolean {
  try { return localStorage.getItem(REMAINING_KEY) === '1'; } catch { return false; }
}
