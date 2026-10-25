import { describe, expect, it } from 'vitest';
import { carouselGeometry, carouselRelease, carouselSlot } from '../src/app/phone/cover-carousel';

describe('cover carousel (after PixelPlayer NO_PEEK)', () => {
  const g = carouselGeometry(342);

  it('shows only the playing cover at rest, square and full width', () => {
    expect(g).toEqual({ width: 342, height: 342, gap: 8 });
    expect(carouselSlot(g, 0)).toEqual({ left: 0, width: 342 });
  });

  it('keeps the neighbours a page away, off the frame', () => {
    expect(carouselSlot(g, 1).left).toBe(350);
    expect(carouselSlot(g, -1).left + 342).toBe(-8);
  });

  it('moves the next cover in behind the playing one while dragging', () => {
    expect(carouselSlot(g, 0 - 0.5).left).toBe(-175);
    expect(carouselSlot(g, 1 - 0.5).left).toBe(175);
  });

  it('commits past halfway or on a flick the way the finger went', () => {
    expect(carouselRelease(-180, 0, 350)).toBe(1);
    expect(carouselRelease(180, 0, 350)).toBe(-1);
    expect(carouselRelease(-100, 0, 350)).toBe(0);
    expect(carouselRelease(-40, -900, 350)).toBe(1);
    expect(carouselRelease(-40, 900, 350)).toBe(0);
    expect(carouselRelease(-10, -900, 350)).toBe(0);
  });
});
