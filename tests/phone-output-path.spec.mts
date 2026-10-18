import { describe, expect, it } from 'vitest';
import { NativeOutput } from '../src/app/core/android/android-playback.engine';
import { describeOutput } from '../src/app/phone/app-shell';

const out = (changes: Partial<NativeOutput> = {}): NativeOutput => ({
  device: { kind: 'speaker' },
  stream: { encoding: 'pcm16', sampleRate: 44100, channels: 2, offload: false },
  mixer: { sampleRate: 48000, matched: false, bitPerfect: false },
  codecAccess: 'granted',
  usbMode: 'shared',
  usbCapable: true,
  ...changes,
});

describe('phone output path', () => {
  it('names the mixer, the stream and marks a stream at another rate as resampled', () => {
    expect(describeOutput(out())).toMatchObject({ path: 'Android mixer', device: 'Phone speaker', bits: '16-bit', streamKhz: '44.1', khz: '48', resampled: true, bitPerfect: false });
    expect(describeOutput(out({ stream: { encoding: 'float', sampleRate: 48000, channels: 2, offload: false } }))).toMatchObject({ bits: 'float', resampled: false });
  });

  it('leaves an unreported rate out instead of guessing', () => {
    const bluetooth = describeOutput(out({ device: { kind: 'bluetooth', name: 'WH-1000XM4' }, mixer: { matched: false, bitPerfect: false } }));
    expect(bluetooth).toMatchObject({ path: 'Bluetooth', device: 'WH-1000XM4', khz: null, resampled: false });
    expect(describeOutput(null)).toBeNull();
  });

  it('names the Bluetooth codec and the link rate when Android reports them', () => {
    const headphones = { kind: 'bluetooth' as const, name: 'ROSE Ceramics MK2' };
    const ldac = describeOutput(out({ device: headphones, stream: { encoding: 'float', sampleRate: 96000, channels: 2, offload: false },
      bluetooth: { codec: 'LDAC', sampleRate: 96000, bits: 32, ldac: '990' }, mixer: { matched: false, bitPerfect: false } }))!;
    expect(ldac).toMatchObject({ path: 'Bluetooth LDAC 990', codec: 'LDAC 990 kbps', khz: '96', linkBits: '32-bit', resampled: false });
    expect(ldac.note).toContain('re-encodes the audio as LDAC');
    const adaptive = describeOutput(out({ device: headphones, bluetooth: { codec: 'LDAC', sampleRate: 96000, ldac: 'adaptive' }, mixer: { matched: false, bitPerfect: false } }))!;
    expect(adaptive).toMatchObject({ path: 'Bluetooth LDAC adaptive', resampled: true });
    expect(adaptive.note).toContain('lowers its bitrate');
    const unknown = describeOutput(out({ device: headphones, codecAccess: 'needed', mixer: { matched: false, bitPerfect: false } }))!;
    expect(unknown).toMatchObject({ path: 'Bluetooth', codec: null, khz: null });
    expect(unknown.note).toContain('Nearby devices');
  });

  it('names a screen capture instead of the DAC while another app records playback', () => {
    const captured = describeOutput(out({ device: { kind: 'capture' }, usbMode: 'match', mixer: { matched: false, bitPerfect: false } }))!;
    expect(captured).toMatchObject({ path: 'Screen capture', device: 'Screen capture', khz: null, bitPerfect: false });
    expect(captured.note).toContain('recording');
  });

  it('says bit-perfect only when Android confirms it, and why not otherwise', () => {
    const usb = { device: { kind: 'usb' as const, name: 'Black Pearl' }, usbMode: 'bitperfect' as const };
    expect(describeOutput(out({ ...usb, mixer: { sampleRate: 44100, matched: true, bitPerfect: true } }))).toMatchObject({ path: 'USB bit-perfect', bitPerfect: true });
    const fallback = describeOutput(out({ ...usb, mixer: { sampleRate: 44100, matched: true, bitPerfect: false } }))!;
    expect(fallback).toMatchObject({ path: 'USB mixer', bitPerfect: false, resampled: false });
    expect(fallback.note).toContain('no bit-perfect format');
    expect(describeOutput(out({ ...usb, usbMode: 'shared', mixer: { matched: false, bitPerfect: false } }))).toMatchObject({ path: 'USB · Android mixer', khz: null });
  });
});
