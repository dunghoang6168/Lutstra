import { describe, expect, it } from 'vitest';
import { normalizeSearch, rankMatches } from '../src/app/shared/utils/search-rank';

describe('search ranking', () => {
  it('ignores case and Vietnamese diacritics, including đ', () => {
    expect(normalizeSearch('Đường Về Nhà')).toBe('duong ve nha');
    expect(normalizeSearch('Cuộc Gọi Nhỡ')).toBe('cuoc goi nho');
  });

  it('puts title prefixes first, then title matches, then other fields', () => {
    const items = [
      { title: 'Một bài khác', artist: 'Ngọt' },
      { title: 'Ngày mai', artist: null },
      { title: 'Em ngoan', artist: null },
      { title: 'Không khớp', artist: null },
    ];
    const ranked = rankMatches(items, normalizeSearch('ngo'), (item) => item.title, (item) => [item.artist]);
    expect(ranked.map((item) => item.title)).toEqual(['Em ngoan', 'Một bài khác']);
    expect(rankMatches(items, normalizeSearch('ngay'), (item) => item.title, () => []).map((item) => item.title)).toEqual(['Ngày mai']);
  });
});
