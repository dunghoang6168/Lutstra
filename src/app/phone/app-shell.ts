import { signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { NativeOutput, OutputDeviceKind, UsbMode, androidPlayback } from '../core/android/android-playback.engine';
import { DynamicPalette } from '../core/theme/dynamic-accent';
import { formatKhz } from '../features/home/library-quality';

/** A gesture's phases, as Android's HapticFeedbackConstants name them (PixelPlayer uses the same ones). */
export type HapticKind = 'tick' | 'start' | 'end' | 'activate' | 'deactivate';

/** The native shell services (`AppShellPlugin` in MainActivity). */
export const appShell = registerPlugin<{
  moveToBack(): Promise<void>;
  getDynamicColors(): Promise<{ palette: DynamicPalette }>;
  haptic(options: { kind: HapticKind }): Promise<void>;
}>('AppShell');

/** What the audio goes through now (device, stream, mixer, USB mode). Null until read, or off Android; the plugin keeps it live. */
export const output = signal<NativeOutput | null>(null);
let watching = false;

export async function loadOutput(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  if (!watching) {
    watching = true;
    void androidPlayback.addListener('output', (next) => output.set(next));
  }
  try { output.set(await androidPlayback.getOutput()); } catch { output.set(null); }
}

export async function setUsbMode(mode: UsbMode): Promise<void> {
  output.set(await androidPlayback.setUsbMode({ mode }));
}

const BITS: Record<string, string> = { pcm16: '16-bit', pcm24: '24-bit', pcm32: '32-bit', float: 'float' };
const DEVICE: Record<OutputDeviceKind, string> = { speaker: 'Phone speaker', wired: 'Wired', usb: 'USB DAC', bluetooth: 'Bluetooth', capture: 'Screen capture', other: 'Other' };

export interface OutputPath {
  /** Where the stream goes: "Android mixer", "USB mixer" (at the file's rate), "USB bit-perfect", "Bluetooth". */
  path: string;
  device: string | null;
  /** What Lutstra hands Android: "16-bit" or "float", and its rate. */
  bits: string | null;
  streamKhz: string | null;
  /** The rate the device's mixer runs at, when Android reports it. */
  khz: string | null;
  resampled: boolean;
  bitPerfect: boolean;
  note: string;
}

/** The output in words. Only what Android confirms is claimed: "bit-perfect" needs the unmixed mixer and a stream that equals it. */
export function describeOutput(out: NativeOutput | null): OutputPath | null {
  if (!out) return null;
  const kind = out.device?.kind ?? null;
  const { mixer, stream } = out;
  const usb = kind === 'usb';
  const path = mixer.bitPerfect ? 'USB bit-perfect' : usb && mixer.matched ? 'USB mixer' : usb ? 'USB · Android mixer' : kind === 'bluetooth' ? 'Bluetooth' : kind === 'capture' ? 'Screen capture' : 'Android mixer';
  const resampled = !!mixer.sampleRate && !!stream && stream.sampleRate !== mixer.sampleRate;
  let note = 'Android mixes every app’s audio, so this is not bit-perfect. The file itself is untouched.';
  if (kind === 'capture') note = 'Another app is recording what plays (a screen mirror), so Android sends it there and the USB DAC modes wait until it stops.';
  else if (mixer.bitPerfect) note ='Lutstra’s stream reaches the DAC untouched: no mixing, no volume scaling.';
  else if (usb && mixer.matched && out.usbMode === 'bitperfect') note = 'The DAC has no bit-perfect format for this stream, so Android mixes it at the file’s rate. Nothing is resampled.';
  else if (usb && mixer.matched) note = 'The DAC runs at the file’s rate, so nothing is resampled. Android still mixes it, so this is not bit-perfect.';
  return {
    path,
    device: out.device ? out.device.name || DEVICE[out.device.kind] : null,
    bits: stream ? BITS[stream.encoding] ?? stream.encoding : null,
    streamKhz: stream ? formatKhz(stream.sampleRate) : null,
    khz: mixer.sampleRate ? formatKhz(mixer.sampleRate) : null,
    resampled,
    bitPerfect: mixer.bitPerfect,
    note,
  };
}
