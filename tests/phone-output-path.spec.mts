import { describe, expect, it } from 'vitest';
import { outputPath } from '../src/app/phone/app-shell';

describe('phone output path', () => {
  it('names the mixer rate and marks a file at another rate as resampled', () => {
    expect(outputPath(44100, 48000)).toEqual({ khz: '48', resampled: true });
    expect(outputPath(48000, 48000)).toEqual({ khz: '48', resampled: false });
    expect(outputPath(null, 44100)).toEqual({ khz: '44.1', resampled: false });
  });

  it('says nothing while the mixer rate is unknown', () => {
    expect(outputPath(44100, null)).toBeNull();
  });
});
