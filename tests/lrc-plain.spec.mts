import { describe, expect, it } from 'vitest';
import { plainLyrics } from '../src/app/features/now-playing/lrc-parser';

describe('plain lyrics (the phone Plain view)', () => {
  it('drops timestamps, tag rows and blank lines', () => {
    expect(plainLyrics('[ar:Someone]\n[ti:Song]\n[00:01.00]First line\n\n[00:05.20][01:05.20]  Chorus  \r\n[offset:+200]')).toEqual(['First line', 'Chorus']);
  });

  it('keeps a file without any timing as it is', () => {
    expect(plainLyrics('Line one\nLine two\n')).toEqual(['Line one', 'Line two']);
  });
});
