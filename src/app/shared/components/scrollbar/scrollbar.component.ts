import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, effect, inject, input, viewChild } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { ScrollMetrics, scrollFraction, scrollTopForThumb, thumbTop } from './scrollbar-math';

/** Thumb height and the gap between it and each half of the track, as PixelPlayer's ExpressiveScrollBar. */
const THUMB = 48;
const GAP = 8;

/**
 * Scrollbar after PixelPlayer's ExpressiveScrollBar, for any scroller: an 8px track split around a 48px thumb.
 * Pressed, the thumb widens with ⇕; dragged, it scrolls the list and a bubble shows `label(fraction)`. A tap on the
 * track jumps there. It hides while the scroller cannot scroll. The host sits over the scroller's right edge
 * (the parent is `position: relative`); give the list about 22px of right padding so it clears the thumb.
 * The native scroll, wheel and keyboard keep working, so it stays out of the accessibility tree.
 */
@Component({
  selector: 'app-scrollbar',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './scrollbar.component.html',
  styleUrl: './scrollbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class ScrollbarComponent {
  /** The element that scrolls. */
  readonly scroller = input.required<HTMLElement>({ alias: 'for' });
  /** The bubble's text while dragging, for how far along the list the thumb is (0 to 1); null shows none. */
  readonly label = input<((fraction: number) => string | null) | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private readonly thumb = viewChild.required<ElementRef<HTMLElement>>('thumb');
  private readonly above = viewChild.required<ElementRef<HTMLElement>>('above');
  private readonly below = viewChild.required<ElementRef<HTMLElement>>('below');
  private readonly bubble = viewChild.required<ElementRef<HTMLElement>>('bubble');
  private drag: { id: number; grab: number } | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Outside Angular: scrolling and dragging only restyle a few elements.
    effect((onCleanup) => {
      const scroller = this.scroller();
      this.zone.runOutsideAngular(() => {
        const update = (): void => this.render();
        scroller.addEventListener('scroll', update, { passive: true });
        // Rows added or removed change the scroll range without a scroll event.
        const resize = new ResizeObserver(update);
        const watch = (): void => { resize.disconnect(); resize.observe(scroller); for (const child of scroller.children) resize.observe(child); };
        const mutations = new MutationObserver(watch);
        mutations.observe(scroller, { childList: true });
        watch();
        onCleanup(() => { scroller.removeEventListener('scroll', update); resize.disconnect(); mutations.disconnect(); });
      });
    });
    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('pointerdown', (event) => this.down(event));
      this.host.addEventListener('pointermove', (event) => this.move(event));
      this.host.addEventListener('pointerup', (event) => this.up(event));
      this.host.addEventListener('pointercancel', (event) => this.up(event));
    });
    destroyRef.onDestroy(() => { this.drag = null; });
  }

  private metrics(): ScrollMetrics {
    const { scrollTop, scrollHeight, clientHeight } = this.scroller();
    return { scrollTop, scrollHeight, clientHeight };
  }

  /** Puts the thumb where the scroller is and splits the track around it. */
  private render(): void {
    const metrics = this.metrics();
    const track = this.host.clientHeight;
    this.host.classList.toggle('off', metrics.scrollHeight - metrics.clientHeight < 1);
    const top = thumbTop(metrics, track, THUMB);
    this.thumb().nativeElement.style.translate = `0 ${top}px`;
    this.above().nativeElement.style.height = `${Math.max(0, top - GAP)}px`;
    this.below().nativeElement.style.height = `${Math.max(0, track - top - THUMB - GAP)}px`;
    if (this.drag) {
      const text = this.label()?.(scrollFraction(metrics)) ?? null;
      const bubble = this.bubble().nativeElement;
      bubble.textContent = text ?? '';
      bubble.classList.toggle('shown', !!text);
      bubble.style.translate = `0 ${top + THUMB / 2}px`;
    }
  }

  private down(event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    const y = event.clientY - this.host.getBoundingClientRect().top;
    const top = thumbTop(this.metrics(), this.host.clientHeight, THUMB);
    // On the thumb it moves from where it was held; on the track it jumps so its middle is under the finger.
    const grab = y >= top && y <= top + THUMB ? y - top : THUMB / 2;
    this.drag = { id: event.pointerId, grab };
    this.host.setPointerCapture(event.pointerId);
    this.host.classList.add('pressed');
    this.scrollTo(y);
  }

  private move(event: PointerEvent): void {
    if (event.pointerId !== this.drag?.id) return;
    this.scrollTo(event.clientY - this.host.getBoundingClientRect().top);
  }

  private up(event: PointerEvent): void {
    if (event.pointerId !== this.drag?.id) return;
    this.drag = null;
    this.host.classList.remove('pressed');
    this.bubble().nativeElement.classList.remove('shown');
  }

  private scrollTo(y: number): void {
    if (!this.drag) return;
    this.scroller().scrollTop = scrollTopForThumb(y - this.drag.grab, this.metrics(), this.host.clientHeight, THUMB);
    this.render();
  }
}
