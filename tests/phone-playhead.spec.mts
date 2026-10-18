import { describe, expect, it } from 'vitest';
import { playheadAt } from '../src/app/phone/playhead';

describe('playheadAt', () => {
  it('runs on between reports while playing', () => {
    expect(playheadAt({ seconds: 10, at: 1000 }, 1250, true, 200)).toBeCloseTo(10.25);
  });

  it('stays put while paused, and never passes the end', () => {
    expect(playheadAt({ seconds: 10, at: 1000 }, 5000, false, 200)).toBe(10);
    expect(playheadAt({ seconds: 199.9, at: 0 }, 1000, true, 200)).toBe(200);
  });
});
