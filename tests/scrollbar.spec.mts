import { describe, expect, it } from 'vitest';
import { scrollFraction, scrollTopForThumb, thumbTop } from '../src/app/shared/components/scrollbar/scrollbar-math';

const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 1100, clientHeight: 100 });

describe('scrollbar math', () => {
  it('maps the scroll range onto the track minus the thumb', () => {
    expect(thumbTop(at(0), 248, 48)).toBe(0);
    expect(thumbTop(at(500), 248, 48)).toBe(100);
    expect(thumbTop(at(1000), 248, 48)).toBe(200);
  });

  it('clamps overscroll and treats a list that cannot scroll as the top', () => {
    expect(scrollFraction(at(-40))).toBe(0);
    expect(scrollFraction(at(1200))).toBe(1);
    expect(scrollFraction({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0);
  });

  it('turns a dragged thumb back into a scroll position', () => {
    expect(scrollTopForThumb(100, at(0), 248, 48)).toBe(500);
    expect(scrollTopForThumb(-30, at(0), 248, 48)).toBe(0);
    expect(scrollTopForThumb(999, at(0), 248, 48)).toBe(1000);
  });
});
