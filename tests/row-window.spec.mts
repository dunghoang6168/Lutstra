import { describe, expect, it } from 'vitest';
import { rowWindow, scrollTopToReveal } from '../src/app/shared/utils/row-window';

describe('rowWindow', () => {
  it('renders the rows in view plus the overscan on each side', () => {
    expect(rowWindow(4400, 440, 44, 1000, 5)).toEqual({ start: 95, end: 115 });
  });
  it('clamps at the top and the bottom of the list', () => {
    expect(rowWindow(0, 440, 44, 1000, 20)).toEqual({ start: 0, end: 30 });
    expect(rowWindow(44000, 440, 44, 1000, 20)).toEqual({ start: 980, end: 1000 });
  });
  it('keeps the last rows when a filter shrinks the list under the old scroll position', () => {
    expect(rowWindow(40000, 440, 44, 12, 20)).toEqual({ start: 11, end: 12 });
  });
  it('renders everything before the row height is known, and nothing for an empty list', () => {
    expect(rowWindow(0, 440, 0, 30)).toEqual({ start: 0, end: 30 });
    expect(rowWindow(0, 440, 44, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('scrollTopToReveal', () => {
  it('scrolls up to a row above the view and down to one below it', () => {
    expect(scrollTopToReveal(10, 880, 440, 44)).toBe(440);
    expect(scrollTopToReveal(40, 880, 440, 44)).toBe(1364);
  });
  it('leaves a row already in view alone', () => {
    expect(scrollTopToReveal(22, 880, 440, 44)).toBeNull();
  });
});
