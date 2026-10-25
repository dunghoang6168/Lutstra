import { DestroyRef, Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';

/** After PixelPlayer's AutoScrollingTextOnDemand: 25 dp/s, a 2 s wait (in the styles), 30 dp between the copies. */
const SPEED_PX_S = 25;
const GAP_PX = 30;

/**
 * Scrolls one line of text that does not fit, as PixelPlayer's title and artist do. The host holds a single
 * `.marquee-run` child showing `marqueeText`; when the run is wider than the host, the host gets
 * `data-marquee="still"` (a fade at the end) or, while `appMarquee` is true, `"moving"` (both edges fade and the run
 * loops with a copy behind it, drawn from the run's `data-text`). The styles that use these live with the host's page.
 */
@Directive({ selector: '[appMarquee]', standalone: true })
export class MarqueeDirective {
  /** Whether it may move (PixelPlayer's `canScroll`: only while playing). */
  readonly moving = input(true, { alias: 'appMarquee' });
  readonly text = input('', { alias: 'marqueeText' });
  /** Whether it is on screen: measuring forces a layout, which a hidden host (a parked Now Playing) puts off. */
  readonly live = input(true, { alias: 'marqueeLive' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private shownText: string | null = null;

  constructor() {
    const resize = new ResizeObserver(() => this.measure());
    resize.observe(this.host);
    inject(DestroyRef).onDestroy(() => resize.disconnect());
    afterRenderEffect(() => { this.moving(); this.text(); this.live(); this.measure(); });
  }

  private measure(): void {
    if (!this.live()) return;
    const run = this.host.querySelector<HTMLElement>('.marquee-run');
    if (!run) return;
    // A new text starts over from its wait.
    if (this.text() !== this.shownText) {
      this.shownText = this.text();
      run.dataset['text'] = this.shownText;
      this.host.removeAttribute('data-marquee');
      void this.host.offsetWidth;
    }
    // offsetWidth: the copy hangs outside the run, so it never counts.
    const shift = run.offsetWidth + GAP_PX;
    this.host.style.setProperty('--marquee-shift', `${-shift}px`);
    this.host.style.setProperty('--marquee-gap', `${GAP_PX}px`);
    this.host.style.setProperty('--marquee-dur', `${shift / SPEED_PX_S}s`);
    if (run.offsetWidth <= this.host.clientWidth + 1) this.host.removeAttribute('data-marquee');
    else this.host.setAttribute('data-marquee', this.moving() ? 'moving' : 'still');
  }
}
