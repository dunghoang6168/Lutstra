/**
 * Now Playing's cover carousel, after PixelPlayer's NO_PEEK style (RoundedParallaxCarousell.kt): at rest only the
 * playing cover shows, square and as wide as the content; the neighbours sit one page away (the width and an 8px gap)
 * and come in only while a drag moves the strip. Owner's choice 2026-10-24: the ONE_PEEK strip of the next cover
 * read as a slide already under way.
 */
export interface CarouselGeometry {
  width: number;
  height: number;
  gap: number;
}

/** A flick this fast (px/s) the way the finger went commits, if it also moved `FLING_MIN_PX`. */
const FLING_SPEED = 300;
const FLING_MIN_PX = 16;

export function carouselGeometry(width: number, gap = 8): CarouselGeometry {
  return { width, height: width, gap };
}

/** Where the item `rel` pages from the playing one sits (fractional while the strip moves). */
export function carouselSlot(g: CarouselGeometry, rel: number): { left: number; width: number } {
  return { left: rel * (g.width + g.gap), width: g.width };
}

/**
 * Which way a released drag goes: 1 to the next cover, -1 to the previous one, 0 back. `dx` is the finger's travel
 * (left is negative), `speed` its speed in px/s, `step` one page. A flick the same way wins, then the halfway mark.
 */
export function carouselRelease(dx: number, speed: number, step: number): -1 | 0 | 1 {
  const toward = dx < 0 ? 1 : -1;
  if (Math.abs(speed) >= FLING_SPEED && Math.abs(dx) >= FLING_MIN_PX && Math.sign(speed) === Math.sign(dx)) return toward;
  return Math.abs(dx) > step / 2 ? toward : 0;
}
