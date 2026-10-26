import { describe, expect, it } from 'vitest';
import { splitDuplicates, suggestionTailStart } from '../src/app/shared/utils/list-media';

const entries = [{ trackId: 'a' }, { trackId: 'b' }];

describe('splitDuplicates', () => {
  it('keeps every track fresh when the playlist has none', () => {
    expect(splitDuplicates(entries, ['c', 'd'])).toEqual({ duplicates: [], fresh: ['c', 'd'] });
  });
  it('flags every track already in the playlist', () => {
    expect(splitDuplicates(entries, ['b', 'a'])).toEqual({ duplicates: ['b', 'a'], fresh: [] });
  });
  it('splits a partial overlap in selection order', () => {
    expect(splitDuplicates(entries, ['c', 'a', 'd'])).toEqual({ duplicates: ['a'], fresh: ['c', 'd'] });
  });
  it('keeps repeated selection ids', () => {
    expect(splitDuplicates(entries, ['a', 'c', 'a', 'c'])).toEqual({ duplicates: ['a', 'a'], fresh: ['c', 'c'] });
  });
});

describe('suggestionTailStart', () => {
  const q = (...flags: boolean[]) => flags.map((suggested) => ({ suggested }));
  it('starts at the first waiting suggestion', () => {
    expect(suggestionTailStart(q(false, false, true, true), 1)).toBe(2);
  });
  it('keeps suggestions that already played or are playing', () => {
    expect(suggestionTailStart(q(false, true, true, true), 2)).toBe(3);
  });
  it('is the queue length when nothing waits', () => {
    expect(suggestionTailStart(q(false, true, false), 0)).toBe(3);
  });
});
