import { Directive, ElementRef, NgZone, inject, output } from '@angular/core';

/** How far a finger moves before the gesture is read, so a tap stays a tap. */
const SLOP_PX = 8;
/** Released past this share of the sheet's height, or flicked down this fast (px/ms), the sheet closes. */
const CLOSE_SHARE = 0.25;
const CLOSE_SPEED = 0.5;
const CLOSE_MIN_PX = 24;
/** Lutstra's ease-out (--motion-ease): a sheet let go early glides back up. */
const SETTLE_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Parts with a drag of their own (the queue's reorder handle, sliders). */
const OWN_DRAG = '.drag-handle, input';

/**
 * Drag a bottom sheet down from anywhere on it to close it, as Android's bottom sheets do. Inside a list that
 * is scrolled, a downward drag scrolls it first; once the list is at its top, the drag moves the sheet instead.
 * Sideways moves stay with row swipes. The sheet follows the finger as `translate`, so the shell's
 * `sheet-leaving` slide carries on from where it was let go; a short drag glides back.
 * Touch events, not pointer events: the browser would cancel pointers once the list starts to scroll.
 * Runs outside Angular until it closes.
 */
@Directive({ selector: '[appSheetDrag]', standalone: true })
export class SheetDragDirective {
  readonly dismissed = output<void>({ alias: 'sheetDismissed' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private start: { x: number; y: number; scroller: HTMLElement | null } | null = null;
  private samples: { y: number; t: number }[] = [];
  private state: 'idle' | 'deciding' | 'dragging' = 'idle';
  private swallowClick = false;

  constructor() {
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('touchstart', (event) => this.down(event), { passive: true });
      // Not passive: once the drag is the sheet's, it stops the list from scrolling.
      this.host.addEventListener('touchmove', (event) => this.move(event), { passive: false });
      this.host.addEventListener('touchend', (event) => this.up(event), { passive: true });
      this.host.addEventListener('touchcancel', () => { if (this.state === 'dragging') this.settle(); this.state = 'idle'; }, { passive: true });
    });
    // A drag that started on a button must not also press it.
    this.host.addEventListener('click', (event) => {
      if (!this.swallowClick) return;
      this.swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  private down(event: TouchEvent): void {
    const target = event.target as Element;
    if (event.touches.length !== 1 || target.closest(OWN_DRAG)) { this.state = 'idle'; return; }
    const touch = event.touches[0];
    this.start = { x: touch.clientX, y: touch.clientY, scroller: this.scrollerOf(target) };
    this.samples = [{ y: touch.clientY, t: event.timeStamp }];
    this.state = 'deciding';
    this.swallowClick = false;
  }

  private move(event: TouchEvent): void {
    if (this.state === 'idle' || !this.start) return;
    const touch = event.touches[0];
    const dx = touch.clientX - this.start.x;
    const dy = touch.clientY - this.start.y;
    if (this.state === 'deciding') {
      if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
      // Down, mostly vertical, with nothing above to scroll back to: the sheet's. Anything else is left alone.
      const atTop = !this.start.scroller || this.start.scroller.scrollTop <= 0;
      if (dy <= 0 || Math.abs(dx) >= dy || !atTop) { this.state = 'idle'; return; }
      this.state = 'dragging';
      this.start.y = touch.clientY - SLOP_PX; // no jump at the start
      this.host.getAnimations().forEach((animation) => animation.cancel());
    }
    if (event.cancelable) event.preventDefault();
    this.samples = [...this.samples.filter((sample) => event.timeStamp - sample.t < 100), { y: touch.clientY, t: event.timeStamp }];
    this.host.style.translate = `0 ${Math.max(0, touch.clientY - this.start.y)}px`;
  }

  private up(event: TouchEvent): void {
    if (this.state !== 'dragging' || !this.start) { this.state = 'idle'; return; }
    const touch = event.changedTouches[0];
    const dy = touch.clientY - this.start.y;
    const first = this.samples[0];
    const speed = event.timeStamp > first.t ? (touch.clientY - first.y) / (event.timeStamp - first.t) : 0;
    this.state = 'idle';
    this.swallowClick = true;
    setTimeout(() => this.swallowClick = false, 400);
    if (dy >= this.host.offsetHeight * CLOSE_SHARE || (speed >= CLOSE_SPEED && dy >= CLOSE_MIN_PX)) {
      this.zone.run(() => this.dismissed.emit());
    } else {
      this.settle();
    }
  }

  private settle(): void {
    const from = this.host.style.translate;
    this.host.style.translate = '';
    if (from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.host.animate([{ translate: from }, { translate: '0 0' }], { duration: 300, easing: SETTLE_EASE });
    }
  }

  /** The nearest list from the touch up to the sheet itself that can scroll vertically. */
  private scrollerOf(target: Element): HTMLElement | null {
    for (let el: Element | null = target; el && el !== this.host.parentElement; el = el.parentElement) {
      if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  }
}
