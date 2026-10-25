import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, NgZone, afterRenderEffect, inject, input, output } from '@angular/core';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { CarouselGeometry, carouselGeometry, carouselRelease, carouselSlot } from '../../cover-carousel';
import { haptic } from '../../haptics';

/** One cover on the strip: `rel` is its place from the playing one (-1 previous, 0 playing, 1 next). */
export interface CarouselCover {
  key: string;
  artwork: string | null;
  rel: number;
}

/** How far a finger moves before the gesture is the strip's rather than a tap. */
const SLOP_PX = 10;
const SETTLE_MS = 320;
/** A strip asked to change track and left waiting this long goes back, in case the player did not move. */
const STUCK_MS = 700;

/**
 * Now Playing's covers after PixelPlayer's NO_PEEK carousel (cover-carousel.ts has the geometry). A sideways drag
 * moves the whole strip under the finger and a release settles on the next, the previous or the same cover without
 * bounce; `swiped` then asks for the track. When the playing cover changes by other means (the buttons, a track
 * ending) the strip slides the same way. Paused, the covers shrink to 0.95 as PixelPlayer's do. Per frame it only
 * restyles its slots, outside Angular.
 */
@Component({
  selector: 'app-phone-cover-carousel',
  standalone: true,
  imports: [CoverArtComponent],
  template: `
    <div class="strip" [class.paused]="paused()">
      @for (cover of covers(); track cover.key) {
        <div class="slot" [attr.data-rel]="cover.rel" [attr.aria-hidden]="cover.rel === 0 ? null : 'true'">
          <app-cover-art class="art" [src]="cover.artwork" [alt]="cover.rel === 0 ? label() : ''" [iconSize]="64" />
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: var(--carousel-h, 100vw);
      touch-action: pan-y; /* sideways is the strip's */
      user-select: none;
    }

    /* The neighbours wait outside, as the pager clips them; the shadow below still shows. */
    .strip {
      position: absolute;
      inset: 0;
      clip-path: inset(0 0 -48px 0);
      transition: scale 260ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .strip.paused { scale: 0.95; }

    .slot {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      overflow: hidden;
      border-radius: 18px;
      box-shadow: var(--cover-shadow);
      will-change: translate, width;
    }

    .art {
      display: block;
      width: 100%;
      height: 100%;
    }

    @media (prefers-reduced-motion: reduce) {
      .strip { transition: none; }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneCoverCarouselComponent {
  readonly covers = input<CarouselCover[]>([]);
  readonly paused = input(false);
  /** The playing cover's alt text. */
  readonly label = input('');
  readonly swiped = output<'next' | 'previous'>();
  /** A tap on the playing cover. */
  readonly tapped = output<void>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private geometry: CarouselGeometry = carouselGeometry(0);
  /** How far the strip has moved toward the next cover, in pages (negative toward the previous one). */
  private drag = 0;
  private start: { id: number; x: number; y: number; from: number } | null = null;
  private samples: { x: number; t: number }[] = [];
  private dragging = false;
  private swallowClick = false;
  private frame = 0;
  private stuck: ReturnType<typeof setTimeout> | undefined;
  private shown = new Map<string, number>();

  constructor() {
    const resize = new ResizeObserver(() => this.measure());
    resize.observe(this.host);
    inject(DestroyRef).onDestroy(() => { resize.disconnect(); cancelAnimationFrame(this.frame); clearTimeout(this.stuck); });

    // A new playing cover that was on the strip already: carry the strip's position over so nothing jumps, then glide.
    afterRenderEffect(() => {
      const covers = this.covers();
      const playing = covers.find((cover) => cover.rel === 0)?.key;
      const was = playing === undefined ? undefined : this.shown.get(playing);
      this.shown = new Map(covers.map((cover) => [cover.key, cover.rel]));
      if (was === undefined) { this.drag = 0; cancelAnimationFrame(this.frame); }
      else if (was !== 0) {
        this.drag -= was;
        if (this.start) this.start.from -= was;
        clearTimeout(this.stuck);
      }
      this.paint();
      if (!this.dragging && this.drag !== 0) this.settleTo(0);
    });

    this.zone.runOutsideAngular(() => {
      this.host.addEventListener('pointerdown', (event) => this.down(event));
      this.host.addEventListener('pointermove', (event) => this.move(event));
      this.host.addEventListener('pointerup', (event) => this.up(event));
      this.host.addEventListener('pointercancel', (event) => {
        if (event.pointerId !== this.start?.id) return;
        if (this.dragging) this.release(0); else this.start = null;
      });
    });
    this.host.addEventListener('click', (event) => {
      if (this.swallowClick) { this.swallowClick = false; event.stopImmediatePropagation(); return; }
      const playing = this.host.querySelector<HTMLElement>('.slot[data-rel="0"]');
      if (playing?.contains(event.target as Node)) this.tapped.emit();
    }, { capture: true });
  }

  private measure(): void {
    if (!this.host.clientWidth) return;
    this.geometry = carouselGeometry(this.host.clientWidth);
    this.host.style.setProperty('--carousel-h', `${this.geometry.height}px`);
    this.paint();
  }

  private has(rel: number): boolean {
    return this.covers().some((cover) => cover.rel === rel);
  }

  private down(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.start = { id: event.pointerId, x: event.clientX, y: event.clientY, from: this.drag };
    this.samples = [{ x: event.clientX, t: event.timeStamp }];
    this.dragging = this.swallowClick = false;
  }

  private move(event: PointerEvent): void {
    if (event.pointerId !== this.start?.id) return;
    const dx = event.clientX - this.start.x;
    if (!this.dragging) {
      if (Math.abs(dx) < SLOP_PX || Math.abs(dx) < Math.abs(event.clientY - this.start.y)) return;
      this.dragging = true;
      cancelAnimationFrame(this.frame);
      this.host.setPointerCapture(event.pointerId);
    }
    this.samples = [...this.samples.filter((sample) => event.timeStamp - sample.t < 100), { x: event.clientX, t: event.timeStamp }];
    let to = this.start.from - dx / this.step();
    // No cover that way: the strip gives a little and comes back.
    if ((to > 0 && !this.has(1)) || (to < 0 && !this.has(-1))) to = 0.15 * Math.tanh(to / 0.15);
    this.drag = Math.max(-1, Math.min(1, to));
    this.paint();
  }

  private up(event: PointerEvent): void {
    if (event.pointerId !== this.start?.id) return;
    this.swallowClick = this.dragging;
    if (!this.dragging) { this.start = null; return; }
    const first = this.samples[0];
    const speed = event.timeStamp > first.t ? (event.clientX - first.x) / ((event.timeStamp - first.t) / 1000) : 0;
    this.release(speed);
  }

  /** Where the strip stands decides, not where the finger started: a drag can catch a strip still gliding. */
  private release(speed: number): void {
    this.start = null;
    this.dragging = false;
    let to: number = carouselRelease(-this.drag * this.step(), speed, this.step());
    if (!this.has(to)) to = 0;
    this.settleTo(to);
  }

  private step(): number {
    return this.geometry.width + this.geometry.gap || 1;
  }

  /** Glides `drag` to `to`; at ±1 asks for that track and waits on that cover for the strip to change. */
  private settleTo(to: number): void {
    cancelAnimationFrame(this.frame);
    const from = this.drag;
    const begin = performance.now();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SETTLE_MS;
    const tick = (now: number) => {
      const t = duration ? Math.min(1, (now - begin) / duration) : 1;
      this.drag = from + (to - from) * (1 - (1 - t) ** 3);
      this.paint();
      if (t < 1) { this.frame = requestAnimationFrame(tick); return; }
      if (to === 0) return;
      haptic('end');
      this.zone.run(() => this.swiped.emit(to > 0 ? 'next' : 'previous'));
      clearTimeout(this.stuck);
      this.stuck = setTimeout(() => { if (this.drag === to) this.settleTo(0); }, STUCK_MS);
    };
    this.zone.runOutsideAngular(() => { this.frame = requestAnimationFrame(tick); });
  }

  private paint(): void {
    for (const slot of this.host.querySelectorAll<HTMLElement>('.slot')) {
      const { left, width } = carouselSlot(this.geometry, Number(slot.dataset['rel']) - this.drag);
      slot.style.translate = `${left}px 0`;
      slot.style.width = `${width}px`;
    }
  }
}
