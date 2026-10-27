import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, NgZone, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { audioPathOpen, describeOutput, loadOutput, lyricsOpen, output as liveOutput } from '../../app-shell';
import { CurrentLyricsService } from '../../../features/now-playing/current-lyrics.service';
import { CoverToneService } from '../../cover-tone.service';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { RouterLink, Router } from '@angular/router';
import { IconName } from '../../../shared/components/icon/icon.component';
import { MarqueeDirective } from '../../marquee.directive';
import { CarouselCover, PhoneCoverCarouselComponent } from '../cover-carousel/phone-cover-carousel.component';
import { focusQuietly } from '../../focus';
import { PlayheadSample, playheadAt } from '../../playhead';
import { PlayerSheetService } from '../../player-sheet.service';

const REMAINING_KEY = 'lutstra.phone.timeRemaining';
/** Swipe up to the queue: a slow drag must cover this share of the screen; a flick (px/ms) only `SWIPE_UP_MIN_PX`. */
const SWIPE_UP_SHARE = 0.12;
const SWIPE_UP_SPEED = 0.5;
const SWIPE_UP_MIN_PX = 40;
/** How far a finger moves down before the drag is the sheet's, so a tap stays a tap. */
const DRAG_DOWN_SLOP_PX = 8;

type TransportButton = 'prev' | 'play' | 'next';


/** The output pill's icon and short name per kind of device; the Audio path sheet has the rest. */
const DEVICES: Record<string, { icon: IconName; name: string }> = {
  speaker: { icon: 'speaker', name: 'Speaker' },
  wired: { icon: 'headphones', name: 'Wired' },
  bluetooth: { icon: 'bluetooth', name: 'Bluetooth' },
  usb: { icon: 'usb', name: 'USB DAC' },
  capture: { icon: 'cpu', name: 'Capture' },
};

/**
 * Full-screen player over the shell, after PixelPlayer's FullPlayerContent: the blurred cover as ground, a top bar
 * with the output device, a cover carousel that swipes to change track, a scrolling title, the file's format
 * between the times, three transport pills and the shuffle/repeat toggles, all tinted from the cover
 * (`cover-tinted` in _base.scss).
 */
@Component({
  selector: 'app-phone-now-playing',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent, RouterLink, MarqueeDirective, PhoneCoverCarouselComponent],
  templateUrl: './phone-now-playing.component.html',
  styleUrls: ['../../phone-seek.scss', './phone-now-playing.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneNowPlayingComponent {
  readonly player = inject(PlayerService);
  readonly sheet = inject(PlayerSheetService);
  readonly library = inject(PhoneLibraryService);
  private readonly smartShuffle = inject(SmartShuffleService);
  private readonly lyrics = inject(CurrentLyricsService);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly queueButton = viewChild<ElementRef<HTMLButtonElement>>('queueButton');
  private readonly injector = inject(Injector);
  readonly queueOpen = input(false);
  /** Inert under the queue or the track actions sheet, which sit above it. */
  readonly covered = computed(() => this.queueOpen() || this.library.actionTracks() !== null || audioPathOpen() || lyricsOpen());
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
  private readonly router = inject(Router);
  private sample: PlayheadSample = { seconds: 0, at: 0 };
  /** The cover's hue and chroma, which tint the controls as PixelPlayer's album scheme does; null without a cover. */
  readonly tone = inject(CoverToneService).tone;
  /** Where the sound goes: the path, what Lutstra hands Android and the device's rate. The file's own format is in the ⋯ sheet and the mini player. */
  readonly output = computed(() => describeOutput(liveOutput()));
  readonly device = computed(() => DEVICES[liveOutput()?.device?.kind ?? ''] ?? DEVICES['speaker']);
  /** Media3 is fetching data while play is wanted (PixelPlayer's isBuffering); the styles wait a moment before showing it. */
  readonly buffering = computed(() => this.player.playbackState() === 'buffering' || (this.player.isLoading() && this.player.isPlaybackActive()));
  readonly albumId = computed(() => this.libraryIdOf('albums'));
  readonly artistId = computed(() => this.libraryIdOf('artists'));
  /**
   * The carousel's covers from the queue: the one before, the playing one and the one after (wrapping under
   * repeat all). An external source (Music Roulette) has no known neighbours, so its cover stands alone.
   */
  readonly covers = computed<CarouselCover[]>(() => {
    const track = this.player.currentTrack();
    if (!track) return [];
    const queue = this.player.queue();
    const index = this.player.currentIndex();
    const playing = queue[index];
    if (this.player.externalSource() || playing?.track.id !== track.id) return [{ key: `track:${track.id}`, artwork: track.artwork ?? null, rel: 0 }];
    const wrap = this.player.repeatMode() === 'all' && !this.player.smartShuffle() && !this.player.modesLocked();
    const covers: CarouselCover[] = [];
    for (const rel of [0, 1, -1]) {
      let at = index + rel;
      if (wrap) at = (at + queue.length) % queue.length;
      const entry = queue[at];
      if (entry && !covers.some((cover) => cover.key === entry.id)) covers.push({ key: entry.id, artwork: entry.track.artwork ?? null, rel });
    }
    return covers;
  });

  constructor() {
    // The plugin keeps the output live (headphones, Bluetooth, a USB DAC); this reads it the first time.
    void loadOutput();
    // Kept built while the sheet is down (the shell builds it ahead), so focus comes each time it opens, once it
    // rests: focus forces a full restyle, which would cost the opening its frames.
    effect(() => {
      if (this.sheet.covering()) afterNextRender(() => focusQuietly(this.closeButton()?.nativeElement), { injector: this.injector });
    });
    // A new report from the player (every 500 ms, or a seek) restarts the run-on from there.
    effect(() => {
      this.sample = { seconds: this.player.currentTime(), at: performance.now() };
      this.player.isPlaying();
    });
    this.runPlayhead();
    this.followSwipeUp();
    this.followDragDown();
    // Focus returns to the queue button once the sheet is gone and this one is no longer inert.
    let queueWasOpen = false;
    effect(() => {
      const open = this.queueOpen();
      if (queueWasOpen && !open) afterNextRender(() => focusQuietly(this.queueButton()?.nativeElement), { injector: this.injector });
      queueWasOpen = open;
    });
  }

  /** The Lyrics button shows only for a track with lyrics, timed or not. */
  readonly hasLyrics = computed(() => {
    const lyrics = this.lyrics;
    return lyrics.lines().length > 0 || lyrics.plain().length > 0;
  });

  openLyrics(): void {
    lyricsOpen.set(true);
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

  /**
   * A drag down from anywhere takes the sheet back toward the mini player, after PixelPlayer's. While the page is
   * scrolled, a drag down scrolls it first; the seek bar keeps its own drag and sideways stays the cover's track
   * swipe. Touch events, not pointer events: the browser would cancel pointers once the page starts to scroll.
   */
  private followDragDown(): void {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const zone = inject(NgZone);
    const sheet = inject(PlayerSheetService);
    let start: { x: number; y: number; from: number } | null = null;
    let state: 'idle' | 'deciding' | 'dragging' = 'idle';
    let dy = 0;
    let samples: { y: number; t: number }[] = [];
    let swallowClick = false;
    const scroller = () => host.querySelector<HTMLElement>('.now-playing');
    const end = (vy: number): void => {
      state = 'idle';
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
      sheet.endDrag(dy, vy);
      if (!sheet.open()) zone.run(() => this.close.emit());
    };
    zone.runOutsideAngular(() => {
      host.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        const ok = event.touches.length === 1 && !(event.target as Element).closest('input') && !this.covered();
        state = ok ? 'deciding' : 'idle';
        start = ok ? { x: touch.clientX, y: touch.clientY, from: 1 } : null;
        samples = ok ? [{ y: touch.clientY, t: event.timeStamp }] : [];
      }, { passive: true });
      // Not passive: once the drag is the sheet's, it stops the page from scrolling.
      host.addEventListener('touchmove', (event) => {
        if (state === 'idle' || !start) return;
        const touch = event.touches[0];
        const dx = touch.clientX - start.x;
        dy = touch.clientY - start.y;
        if (state === 'deciding') {
          if (Math.abs(dx) < DRAG_DOWN_SLOP_PX && Math.abs(dy) < DRAG_DOWN_SLOP_PX) return;
          if (dy <= 0 || Math.abs(dx) >= dy || (scroller()?.scrollTop ?? 0) > 0) { state = 'idle'; return; }
          state = 'dragging';
          start.y = touch.clientY - DRAG_DOWN_SLOP_PX; // no jump at the start
          dy = DRAG_DOWN_SLOP_PX;
          start.from = sheet.beginDrag();
        }
        if (event.cancelable) event.preventDefault();
        samples = [...samples.filter((sample) => event.timeStamp - sample.t < 100), { y: touch.clientY, t: event.timeStamp }];
        sheet.dragTo(start.from, dy);
      }, { passive: false });
      host.addEventListener('touchend', (event) => {
        if (state !== 'dragging') { state = 'idle'; return; }
        const touch = event.changedTouches[0];
        const first = samples[0];
        end(event.timeStamp > first.t ? (touch.clientY - first.y) / (event.timeStamp - first.t) * 1000 : 0);
      }, { passive: true });
      host.addEventListener('touchcancel', () => { if (state === 'dragging') end(0); else state = 'idle'; }, { passive: true });
    });
    // A drag that started on a button must not also press it.
    host.addEventListener('click', (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  /** Each frame, outside Angular: the bar's --p follows the playhead; the times change only on a new second. */
  /** Per frame while the sheet is on screen and not covered; down, it stops, as PixelPlayer's realtime updates do. */
  private runPlayhead(): void {
    const zone = inject(NgZone);
    let frame = 0;
    let lastP = -1;
    let barWidth = 0;

    const measureBar = () => {
      barWidth = this.seekBar()?.nativeElement.clientWidth ?? 0;
    };

    let resizeObserver: ResizeObserver | null = null;

    effect(() => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (this.sheet.shown() && !this.covered()) {
        const bar = this.seekBar()?.nativeElement;
        if (bar) {
          measureBar();
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => measureBar());
            resizeObserver.observe(bar);
          }
        }
        zone.runOutsideAngular(() => { frame = requestAnimationFrame(tick); });
      }
    });

    const tick = () => {
      const duration = this.player.duration() || 0;
      const isScrubbing = this.scrubTime() !== null || this.dragging();
      const seconds = this.scrubTime() ?? playheadAt(this.sample, performance.now(), this.player.isPlaying(), duration);
      const p = duration > 0 ? Math.min(1, Math.max(0, seconds / duration)) : 0;

      // When scrubbing, write every frame. When playing, only write when moved by >= 1 device px.
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const pxThreshold = barWidth > 0 ? (1 / (barWidth * dpr)) : 0.0005;
      if (isScrubbing || Math.abs(p - lastP) >= pxThreshold || lastP < 0) {
        lastP = p;
        this.seekBar()?.nativeElement.style.setProperty('--p', p.toFixed(4));
      }

      const whole = Math.floor(seconds);
      if (whole !== this.shownSeconds()) zone.run(() => this.shownSeconds.set(whole));
      frame = requestAnimationFrame(tick);
    };

    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    });
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
    if (seconds === null) return;
    // The bar runs on from here at once: the report's effect waits for change detection (coalesced to the next
    // frame), and one frame drawn from the old sample flashed the bar back to where it was.
    this.sample = { seconds, at: performance.now() };
    this.player.seek(seconds);
  }

  toggleRemaining(): void {
    this.showRemaining.update((on) => !on);
    try { localStorage.setItem(REMAINING_KEY, this.showRemaining() ? '1' : '0'); } catch { /* the choice lasts this session */ }
  }

  /** Off → Shuffle → Smart Shuffle → Off, as on the desktop shuffle button. */
  cycleShuffle(): void {
    void this.smartShuffle.cycleShuffle();
  }

  /** The strip has already slid to that cover, so going back always means the track before, never a restart. */
  coverSwiped(direction: 'next' | 'previous'): void {
    if (direction === 'next') void this.player.next(); else void this.player.previous(false);
  }

  /** A tap on the cover opens its album, as PixelPlayer's does; the shell puts Now Playing away on the way. */
  openAlbum(): void {
    const id = this.albumId();
    if (!id) return;
    if (this.showing(['/library/albums', id])) this.close.emit();
    else void this.router.navigate(['/library/albums', id]);
  }

  /** The artist link navigates by itself; when its page is the one already under the sheet, the sheet just closes. */
  openArtist(id: string): void {
    if (this.showing(['/library/artists', id])) this.close.emit();
  }

  /** The page under the sheet is already this one, where navigating does nothing (and so would not close the sheet). */
  private showing(commands: string[]): boolean {
    return this.router.isActive(this.router.createUrlTree(commands), { paths: 'exact', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' });
  }

  private libraryIdOf(kind: 'albums' | 'artists'): string | null {
    const id = this.player.currentTrack()?.id;
    return id ? this.library.snapshot()?.[kind].find((item) => item.trackIds.includes(id))?.id ?? null : null;
  }

  press(button: TransportButton): void {
    this.pressed.set(button);
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.pressed.set(null), 220); // --phone-press-dur
  }
}

function readRemaining(): boolean {
  try { return localStorage.getItem(REMAINING_KEY) === '1'; } catch { return false; }
}
