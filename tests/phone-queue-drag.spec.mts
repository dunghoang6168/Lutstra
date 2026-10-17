import { describe, expect, it } from 'vitest';
import { dropSlot } from '../src/app/phone/queue-drag';

const rows = [{ id: 'a', middle: 50 }, { id: 'b', middle: 150 }, { id: 'c', middle: 250 }];

describe('phone queue drag', () => {
  it('lands before the first row whose middle is below the finger', () => {
    expect(dropSlot(rows, 10)).toEqual({ targetId: 'a', placement: 'before' });
    expect(dropSlot(rows, 120)).toEqual({ targetId: 'b', placement: 'before' });
  });

  it('lands after the last row past every middle, and nowhere on an empty list', () => {
    expect(dropSlot(rows, 400)).toEqual({ targetId: 'c', placement: 'after' });
    expect(dropSlot([], 10)).toEqual({ targetId: null, placement: 'after' });
  });
});
