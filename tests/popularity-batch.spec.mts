import { describe, expect, it } from 'vitest';
import { chunkByLength, groupByQuery, searchQuery } from '../electron/utils/youtube-match';
import { missingIds } from '../src/app/features/folders/popularity-fetch.service';

describe('groupByQuery', () => {
  it('shares one search between tracks with the same query', () => {
    const groups = groupByQuery([
      { id: 'a', artist: 'RPT MCK', title: 'Tay To' },
      { id: 'b', artist: 'RPT MCK', title: 'Tay To (Live)' },
      { id: 'c', artist: 'BTS', title: 'Dynamite' },
    ]);
    expect([...groups.keys()]).toEqual(['RPT MCK Tay To', 'BTS Dynamite']);
    expect(groups.get('RPT MCK Tay To')!.map((track) => track.id)).toEqual(['a', 'b']);
  });

  it('keeps every query on one line', () => {
    expect(searchQuery('A\nB', 'Song\r\nTitle\t2')).toBe('A B Song Title 2');
  });
});

describe('chunkByLength', () => {
  it('splits queries into runs that fit the command line', () => {
    expect(chunkByLength(['aaaa', 'bbbb', 'cccc', 'dddddddddddd'], 10)).toEqual([['aaaa', 'bbbb'], ['cccc'], ['dddddddddddd']]);
    expect(chunkByLength([], 10)).toEqual([]);
  });
});

describe('missingIds', () => {
  it('keeps uncached ids once, in order', () => {
    expect(missingIds(['a', 'b', 'a', 'c'], new Map([['b', {}]]))).toEqual(['a', 'c']);
  });
});
