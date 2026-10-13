import { describe, it, expect } from 'vitest';
import { validMediaControlsInfo } from '../electron/ipc/ipc-validation';

const hash = 'a'.repeat(64);
const resolve = (value: string) => value === hash ? 'C:/cache/a.jpg' : null;

describe('validMediaControlsInfo', () => {
  it('resolves only app artwork URLs to a file path', () => {
    const info = validMediaControlsInfo({ title: 'Phù Du', artist: 'Da LAB', album: 'x', artwork: `music://artwork/${hash}`, state: 'playing' }, resolve);
    expect(info).toEqual({ title: 'Phù Du', artist: 'Da LAB', album: 'x', artworkPath: 'C:/cache/a.jpg', state: 'playing' });
    expect(validMediaControlsInfo({ artwork: 'C:/Windows/win.ini', state: 'paused' }, resolve).artworkPath).toBeNull();
  });

  it('rejects unknown states and clamps text', () => {
    expect(() => validMediaControlsInfo({ state: 'stopped' }, resolve)).toThrow();
    expect(validMediaControlsInfo({ title: 'x'.repeat(2000), state: 'none' }, resolve).title).toHaveLength(512);
  });
});
