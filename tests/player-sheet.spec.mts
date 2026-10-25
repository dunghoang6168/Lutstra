import { describe, expect, it } from 'vitest';
import { releaseTarget } from '../src/app/phone/player-sheet.service';

describe('player sheet release (after PixelPlayer)', () => {
  it('keeps an open sheet open when it was pulled back up', () => {
    expect(releaseTarget(true, -3, 900, 0.9)).toBe(1);
    expect(releaseTarget(true, 0, 0, 1)).toBe(1);
  });

  it('follows the direction of any drag past a few pixels', () => {
    expect(releaseTarget(false, -6, 0, 0.02)).toBe(1);
    expect(releaseTarget(true, 6, 0, 0.98)).toBe(0);
  });

  it('then a flick, then the halfway mark', () => {
    expect(releaseTarget(false, -4, -200, 0.01)).toBe(1);
    expect(releaseTarget(false, -4, 0, 0.01)).toBe(0);
    expect(releaseTarget(false, 3, 0, 0.6)).toBe(1);
  });
});
