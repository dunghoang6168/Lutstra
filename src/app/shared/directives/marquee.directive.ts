import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** Pixels per second the text travels; each end also holds for 10% of the cycle (keyframes in _primitives.scss). */
const SPEED_PX_S = 40;
const MIN_DURATION_S = 4;

/**
 * Ping-pong marquee for one line of text that may not fit. The host clips; its first child (`.marquee-text`)
 * slides to the end and back, only while it overflows. Reduced motion falls back to an ellipsis.
 */
@Directive({
  selector: '[appMarquee]',
  standalone: true,
  host: { class: 'marquee' },
})
export class MarqueeDirective {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const measure = () => {
        const text = host.firstElementChild as HTMLElement | null;
        const shift = text ? text.scrollWidth - host.clientWidth : 0;
        host.classList.toggle('is-overflowing', shift > 1);
        host.style.setProperty('--marquee-shift', `${Math.max(0, shift)}px`);
        host.style.setProperty('--marquee-duration', `${Math.max(MIN_DURATION_S, (shift / SPEED_PX_S) / 0.8)}s`);
      };
      // The host resizes with the layout; the text resizes when the track (and so its content) changes.
      const observer = new ResizeObserver(measure);
      observer.observe(host);
      if (host.firstElementChild) observer.observe(host.firstElementChild);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
