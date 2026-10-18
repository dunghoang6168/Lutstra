import { describe, expect, it } from 'vitest';
import { NativeOutput } from '../src/app/core/android/android-playback.engine';
import { PathPart, audioPath } from '../src/app/phone/audio-path';
import { describeOutput } from '../src/app/phone/app-shell';

const out = (changes: Partial<NativeOutput> = {}): NativeOutput => ({
  device: { kind: 'speaker', encodings: ['pcm16'] },
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
  it('names the decoder and the speaker output, bits before the rate', () => {
    const path = audioPath(out({ decoder: 'c2.android.flac.decoder' }), 24);
    expect(text(path.verdict.parts)).toBe('Android resamples 44.1 → 48 kHz');
    expect(path.steps.map((step) => step.label)).toEqual(['Decoder', 'Lutstra → Android', 'Android mixer', 'Output']);
    expect(text(path.steps[0].value)).toBe('Android FLAC decoder');
    expect(text(path.steps[1].value)).toBe('32-bit float · 44.1 kHz');
    expect(text(path.steps[3].value)).toBe('Phone speaker · 16-bit · 48 kHz');
    expect(path.note).toMatch(/^Your 24-bit file is cut to 16-bit at the speaker\./);
  });

  it('leaves the bits out when the device lists more than one format', () => {
    const path = audioPath(out({ device: { kind: 'wired', encodings: ['pcm16', 'pcm24'] }, stream: float(48000) }));
    expect(text(path.steps[3].value)).toBe('Wired headphones · 48 kHz');
    expect(text(path.verdict.parts)).toBe('Nothing resampled; Android mixes it');
  });

  it('marks a USB DAC at the file rate as nothing resampled', () => {
    const path = audioPath(out({ device: { kind: 'usb', name: 'USB-Audio - TE-C' }, stream: float(96000),
      mixer: { sampleRate: 96000, encoding: 'pcm32', matched: true, bitPerfect: false }, usbMode: 'match' }));
    expect(path.verdict.ok).toBe(true);
    expect(text(path.steps[3].value)).toBe('USB-Audio - TE-C · 32-bit · 96 kHz');
    expect(path.usb).toBe(true);
  });

  it('follows LDAC: resampled up to the link, or the same rate', () => {
    const headphones = { kind: 'bluetooth' as const, name: 'ROSE Ceramics MK2' };
    const link = { codec: 'LDAC', sampleRate: 96000, bits: 32, ldac: 'adaptive' };
    const up = audioPath(out({ device: headphones, stream: float(48000), bluetooth: link, mixer: { matched: false, bitPerfect: false } }));
    expect(text(up.verdict.parts)).toBe('Android resamples 48 → 96 kHz for LDAC');
    expect(text(up.steps[3].value)).toBe('LDAC adaptive · 32-bit · 96 kHz');
    const same = audioPath(out({ device: headphones, stream: float(96000), bluetooth: { ...link, ldac: '990' }, mixer: { matched: false, bitPerfect: false } }));
    expect(text(same.verdict.parts)).toBe('Nothing resampled; LDAC still re-encodes it');
    expect(text(same.steps[3].value)).toBe('LDAC 990 kbps · 32-bit · 96 kHz');
  });

  it('does not guess a rate Android leaves out', () => {
    const path = audioPath(out({ device: { kind: 'bluetooth' }, mixer: { matched: false, bitPerfect: false }, codecAccess: 'needed' }));
    expect(text(path.steps[2].value)).toBe('Rate not reported');
    expect(path.steps[3].detail).toContain('Nearby devices');
  });

  it('gives the chip the output, its bits and its rate', () => {
    expect(describeOutput(out())).toMatchObject({ label: 'Speaker', outBits: '16-bit', khz: '48' });
    const ldac = describeOutput(out({ device: { kind: 'bluetooth', name: 'ROSE' }, bluetooth: { codec: 'LDAC', sampleRate: 96000, bits: 32, ldac: 'adaptive' } }));
    expect(ldac).toMatchObject({ label: 'LDAC adaptive', outBits: '32-bit', khz: '96' });
  });
});
