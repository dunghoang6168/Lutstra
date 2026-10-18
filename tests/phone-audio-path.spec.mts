import { describe, expect, it } from 'vitest';
import { NativeOutput } from '../src/app/core/android/android-playback.engine';
import { PathPart, audioPath } from '../src/app/phone/audio-path';

const out = (changes: Partial<NativeOutput> = {}): NativeOutput => ({
  device: { kind: 'speaker' },
  stream: { encoding: 'float', sampleRate: 44100, channels: 2, offload: false },
  mixer: { sampleRate: 48000, matched: false, bitPerfect: false },
  codecAccess: 'granted',
  usbMode: 'shared',
  usbCapable: true,
  ...changes,
});
const text = (parts: PathPart[]) => parts.map((part) => part.text).join('');
const float = (sampleRate: number) => ({ encoding: 'float', sampleRate, channels: 2, offload: false });

describe('phone audio path', () => {
  it('says the speaker path resamples, and names the decoder', () => {
    const path = audioPath(out({ decoder: 'c2.android.flac.decoder' }));
    expect(text(path.verdict.parts)).toBe('Android resamples 44.1 → 48 kHz');
    expect(path.verdict.ok).toBe(false);
    expect(path.steps.map((step) => step.label)).toEqual(['Decoder', 'Lutstra', 'Android mixer', 'Device']);
    expect(text(path.steps[0].value)).toBe('Android FLAC decoder');
    expect(text(path.steps[3].value)).toBe('Phone speaker');
  });

  it('marks a USB DAC at the file rate as nothing resampled', () => {
    const path = audioPath(out({ device: { kind: 'usb', name: 'USB-Audio - TE-C' }, stream: float(96000),
      mixer: { sampleRate: 96000, encoding: 'pcm32', matched: true, bitPerfect: false }, usbMode: 'match' }));
    expect(path.verdict.ok).toBe(true);
    expect(text(path.steps[2].value)).toBe('96 kHz · 32-bit · File rate');
    expect(path.usb).toBe(true);
  });

  it('follows LDAC: resampled up to the link, or the same rate', () => {
    const headphones = { kind: 'bluetooth' as const, name: 'ROSE Ceramics MK2' };
    const link = { codec: 'LDAC', sampleRate: 96000, bits: 32, ldac: 'adaptive' };
    const up = audioPath(out({ device: headphones, stream: float(48000), bluetooth: link, mixer: { matched: false, bitPerfect: false } }));
    expect(text(up.verdict.parts)).toBe('Android resamples 48 → 96 kHz for LDAC');
    expect(text(up.steps[3].value)).toBe('LDAC adaptive · 96 kHz · 32-bit');
    const same = audioPath(out({ device: headphones, stream: float(96000), bluetooth: { ...link, ldac: '990' }, mixer: { matched: false, bitPerfect: false } }));
    expect(text(same.verdict.parts)).toBe('Nothing resampled; LDAC still re-encodes it');
    expect(text(same.steps[3].value)).toBe('LDAC 990 kbps · 96 kHz · 32-bit');
  });

  it('does not guess a rate Android leaves out', () => {
    const path = audioPath(out({ device: { kind: 'bluetooth' }, mixer: { matched: false, bitPerfect: false }, codecAccess: 'needed' }));
    expect(text(path.steps[2].value)).toBe('Rate not reported');
    expect(path.steps[3].detail).toContain('Nearby devices');
  });
});
