import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { historyRangeStart } from '../src/app/core/history/history-days';
import { pillRows, pillWidth } from '../src/app/phone/pages/home/phone-home.component';

describe('recently played pills', () => {
  it('steps the width with the text, as PixelPlayer', () => {
    expect(pillWidth('her', 'JVKE')).toBe(148);
    expect(pillWidth('this is what winter feels like', 'JVKE')).toBe(184);
    expect(pillWidth('butterflies (feat. TAEYEON)', 'KIM CHAEWON of LE SSERAFIM')).toBe(202);
    expect(pillWidth('a'.repeat(60), 'b')).toBe(220);
  });

  it('deals the newest down the first column of three rows', () => {
    expect(pillRows([1, 2, 3, 4, 5, 6, 7])).toEqual([[1, 4, 7], [2, 5], [3, 6]]);
    expect(pillRows([1, 2])).toEqual([[1], [2]]);
  });
});

describe('historyRangeStart', () => {
  const now = new Date(2026, 9, 29, 15, 30).getTime(); // Thursday 29 October 2026

  it('starts today at midnight, the week on Monday and the month on the 1st', () => {
    expect(historyRangeStart('today', now)).toBe(new Date(2026, 9, 29).getTime());
    expect(historyRangeStart('week', now)).toBe(new Date(2026, 9, 26).getTime());
    expect(historyRangeStart('month', now)).toBe(new Date(2026, 9, 1).getTime());
    expect(historyRangeStart('all', now)).toBe(0);
  });

  it('keeps a Sunday in the week that began on Monday', () => {
    expect(historyRangeStart('week', new Date(2026, 10, 1, 9).getTime())).toBe(new Date(2026, 9, 26).getTime());
  });
});
