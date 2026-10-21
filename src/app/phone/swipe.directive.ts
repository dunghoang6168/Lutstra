import { Directive, ElementRef, NgZone, inject, input, output } from '@angular/core';
import { haptic } from './haptics';

export type SwipeDirection = 'left' | 'right';

/** How far a finger moves before the gesture counts as a swipe rather than a tap or a scroll. */
const SLOP_PX = 10;
/** A flick this fast (CSS px/s) commits on its own, if it also travelled `FLING_MIN` of the screen. */
const FLING_SPEED = 300;
const FLING_MIN = 0.05;
/** Dismiss: the first `TENSION_PX` of travel move the row only `TENSION_SHOWN_PX`. */
const TENSION_PX = 60;
const TENSION_SHOWN_PX = 20;
/** Lutstra's ease-out (--motion-ease), with no overshoot: a released swipe glides home. */
const SETTLE_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** The longest a skip waits for `swipeBeforeEnter` before coming back in anyway. */
const ENTER_WAIT_MS = 100;

/**
 * Horizontal swipe on a touch target, tuned after PixelPlayer's mini player and queue gestures
 * (MiniPlayerSkipGestureHandler, QueueItemDismissGestureHandler). Distances are fractions of the screen width.
 *
 * - `swipeMode="skip"`: both ways; the card resists past half the screen, commits at `swipeThreshold` or on a
 *   flick, leaves fading, and after `swiped` comes back in from the other side.
 * - `swipeMode="dismiss"`: left only; the first 60 px barely move it, so a scroll never removes a row; it
 *   commits at `swipeThreshold`, slides out, and `swiped` removes it.
 *
 * Vertical moves stay with scrolling (pair it with `touch-action: pan-y`), and the click that ends a swipe is swallowed.
 */
@Directive({ selector: '[appSwipe]', standalone: true })
export class SwipeDirective {
  readonly mode = input<'skip' | 'dismiss'>('skip', { alias: 'swipeMode' });
  readonly threshold = input(0.22, { alias: 'swipeThreshold' });
  readonly disabled = input(false, { alias: 'swipeDisabled' });
  /** Skip mode: awaited (up to `ENTER_WAIT_MS`) after `swiped`, while the host is invisible, so it comes back in already changed. */
  readonly beforeEnter = input<() => Promise<unknown> | undefined>(() => undefined, { alias: 'swipeBeforeEnter' });
  readonly swiped = output<SwipeDirection>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private start: { id: number; x: number; y: number } | null = null;
  private samples: { x: number; t: number }[] = [];
  private swiping = false;
  private loose = false;
  private armed = false;
  private busy = false;
  private swallowClick = false;

  constructor() {
    // Outside Angular: a finger move only restyles the host, so it must not run change detection for the whole app.
    // `swiped` goes back in through `emit`.
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('pointerdown', (event) => this.down(event));
      this.host.addEventListener('pointermove', (event) => this.move(event));
      this.host.addEventListener('pointerup', (event) => this.up(event));
      this.host.addEventListener('pointercancel', (event) => { if (event.pointerId === this.start?.id) this.settle(); });
    });
    // Capture runs before the host's own (click) binding, so a swipe never also counts as a tap.
    this.host.addEventListener('click', (event) => {
      if (!this.swallowClick) return;
      this.swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  private down(event: PointerEvent): void {
    if (event.pointerType === 'mouse' || this.busy || this.disabled()) return;
    this.start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.samples = [{ x: event.clientX, t: event.timeStamp }];
    this.swiping = this.loose = this.armed = this.swallowClick = false;
  }

  private move(event: PointerEvent): void {
    if (event.pointerId !== this.start?.id) return;
    const dx = event.clientX - this.start.x;
    if (!this.swiping) {
      if (Math.abs(dx) < SLOP_PX || Math.abs(dx) < Math.abs(event.clientY - this.start.y)) return;
      if (this.mode() === 'dismiss' && dx > 0) return;
      this.swiping = true;
      this.host.setPointerCapture(event.pointerId);
    }
    this.samples = [...this.samples.filter((sample) => event.timeStamp - sample.t < 100), { x: event.clientX, t: event.timeStamp }];
    this.host.style.translate = `${this.visual(dx)}px 0`;
    const armed = Math.abs(dx) >= innerWidth * this.threshold() && !(this.mode() === 'dismiss' && dx > 0);
    if (armed !== this.armed) {
      this.armed = armed;
      haptic(armed ? 'activate' : 'deactivate');
    }
  }

  private up(event: PointerEvent): void {
    if (event.pointerId !== this.start?.id) return;
    const dx = event.clientX - this.start.x;
    this.swallowClick = this.swiping;
    if (!this.swiping) { this.start = null; return; }
    const first = this.samples[0];
    const speed = event.timeStamp > first.t ? (event.clientX - first.x) / ((event.timeStamp - first.t) / 1000) : 0;
    const flung = Math.abs(speed) >= FLING_SPEED && Math.abs(dx) >= innerWidth * FLING_MIN && Math.sign(speed) === Math.sign(dx);
    if ((this.armed || flung) && !(this.mode() === 'dismiss' && dx > 0)) void this.commit(dx < 0 ? 'left' : 'right');
    else this.settle();
  }

  /** Where the host sits for a finger `dx` away from where it started. */
  private visual(dx: number): number {
    if (this.mode() === 'skip') {
      // Asymptotic resistance: 1:1 at first, never past half the screen.
      const travel = innerWidth * 0.5;
      return travel * Math.tanh(dx / travel);
    }
    if (!this.loose && Math.abs(dx) < TENSION_PX) return Math.min(0, dx) * (TENSION_SHOWN_PX / TENSION_PX);
    if (!this.loose) { this.loose = true; haptic('tick'); }
    return Math.min(0, dx);
  }

  private async commit(direction: SwipeDirection): Promise<void> {
    this.start = null;
    this.busy = true;
    const sign = direction === 'left' ? -1 : 1;
    haptic('end');
    try {
      if (this.mode() === 'dismiss') {
        await this.animate({ translate: `${sign * this.host.offsetWidth}px 0` }, 180, 'cubic-bezier(0.4, 0, 0.2, 1)');
        this.emit(direction);
        // The row normally goes away with its entry; if it is still here, it slides back.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.host.isConnected) await this.animate({ translate: '0 0' }, 300, SETTLE_EASE);
        return;
      }
      // Shared-axis swap: leave fading, change the track while invisible, come in from the other side.
      await this.animate({ translate: `${sign * innerWidth * 0.34}px 0`, opacity: 0 }, 130, 'cubic-bezier(0.4, 0, 1, 1)');
      this.emit(direction);
      await Promise.race([this.beforeEnter()(), new Promise((resolve) => setTimeout(resolve, ENTER_WAIT_MS))]);
      this.host.style.translate = `${-sign * innerWidth * 0.26}px 0`;
      await this.animate({ translate: '0 0', opacity: 1 }, 260, SETTLE_EASE);
    } finally {
      this.busy = false;
    }
  }

  private emit(direction: SwipeDirection): void {
    this.zone.run(() => this.swiped.emit(direction));
  }

  private settle(): void {
    this.start = null;
    this.swiping = this.armed = false;
    void this.animate({ translate: '0 0' }, 300, SETTLE_EASE);
  }

  /** Animates the host to `to` and keeps it there as inline style; reduced motion jumps straight there. */
  private async animate(to: { translate: string; opacity?: number }, duration: number, easing: string): Promise<void> {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await this.host.animate([to], { duration, easing, fill: 'forwards' }).finished.catch(() => undefined);
    }
    this.host.style.translate = to.translate === '0 0' ? '' : to.translate;
    this.host.style.opacity = to.opacity === undefined || to.opacity === 1 ? '' : String(to.opacity);
    this.host.getAnimations().forEach((animation) => animation.cancel());
  }
}
