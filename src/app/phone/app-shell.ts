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
/** The Audio path sheet, opened from Now Playing's output chip or the ⋯ sheet's File info. */
export const audioPathOpen = signal(false);
/**
 * A page's own step back, asked before the shell goes back a page; it returns true when it handled Back
 * (the Library's Folders tab goes up one folder).
 */
export const pageBack = signal<(() => boolean) | null>(null);
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

/** Asks for Nearby devices so the output line can name the Bluetooth codec. */
export async function requestBluetoothAccess(): Promise<void> {
  output.set(await androidPlayback.requestBluetoothAccess());
}

const BITS: Record<string, string> = { pcm16: '16-bit', pcm24: '24-bit', pcm32: '32-bit', float: 'float' };
const DEVICE: Record<OutputDeviceKind, string> = { speaker: 'Phone speaker', wired: 'Wired', usb: 'USB DAC', bluetooth: 'Bluetooth', capture: 'Screen capture', other: 'Other' };

const INTEGER_BITS: Record<string, string> = { pcm16: '16-bit', pcm24: '24-bit', pcm32: '32-bit' };

/**
 * The bits the device receives, only as Android reports them: the USB mixer's format when Lutstra set it, the
 * Bluetooth link's bits, or the device's one integer format (the speaker lists pcm16 alone); otherwise null.
 */
export function outputBits(out: NativeOutput): string | null {
  const kind = out.device?.kind;
  if (kind === 'bluetooth') return out.bluetooth?.bits ? `${out.bluetooth.bits}-bit` : null;
  if (out.mixer.matched && out.mixer.encoding) return INTEGER_BITS[out.mixer.encoding] ?? null;
  const integer = (out.device?.encodings ?? []).filter((encoding) => encoding in INTEGER_BITS);
  return integer.length === 1 ? INTEGER_BITS[integer[0]] : null;
}

export interface OutputPath {
  /** Where the stream goes: "Android mixer", "USB mixer" (at the file's rate), "USB bit-perfect", "Bluetooth". */
  path: string;
  /** The chip's name for the output: "Speaker", "Wired", the Bluetooth codec, or the USB path. */
  label: string;
  /** The bits the device receives (see outputBits). */
  outBits: string | null;
  device: string | null;
  /** What Lutstra hands Android: "16-bit" or "float", and its rate. */
  bits: string | null;
  streamKhz: string | null;
  /** The rate the device receives: the mixer's, or the Bluetooth link's, when Android reports it. */
  khz: string | null;
  /** The Bluetooth codec with LDAC's bitrate ("LDAC 990"), and the link's bits; null off Bluetooth or while unknown. */
  codec: string | null;
  linkBits: string | null;
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
  const link = kind === 'bluetooth' ? out.bluetooth ?? null : null;
  const codec = link ? `${link.codec}${link.ldac && link.ldac !== 'adaptive' ? ` ${link.ldac}` : link.ldac ? ' adaptive' : ''}` : null;
  const rate = link ? link.sampleRate : mixer.sampleRate;
  const path = mixer.bitPerfect ? 'USB bit-perfect' : usb && mixer.matched ? 'USB mixer' : usb ? 'USB · Android mixer'
    : kind === 'bluetooth' ? (codec ? `Bluetooth ${codec}` : 'Bluetooth') : kind === 'capture' ? 'Screen capture' : 'Android mixer';
  const resampled = !!rate && !!stream && stream.sampleRate !== rate;
  let note = 'Android mixes every app’s audio, so this is not bit-perfect. The file itself is untouched.';
  if (kind === 'capture') note = 'Another app is recording what plays (a screen mirror), so Android sends it there and the USB DAC modes wait until it stops.';
  else if (kind === 'bluetooth') {
    note = link ? `Bluetooth re-encodes the audio as ${link.codec}, so this is not bit-perfect.` : 'Bluetooth re-encodes the audio, so this is not bit-perfect.';
    if (link?.ldac === 'adaptive') note += ' LDAC adaptive lowers its bitrate when the signal weakens.';
    if (!link && out.codecAccess === 'needed') note += ' Allow Nearby devices in Settings to see the codec.';
  } else if (mixer.bitPerfect) note = 'Lutstra’s stream reaches the DAC untouched: no mixing, no volume scaling.';
  else if (usb && mixer.matched && out.usbMode === 'bitperfect') note = 'The DAC has no bit-perfect format for this stream, so Android mixes it at the file’s rate. Nothing is resampled.';
  else if (usb && mixer.matched) note = 'The DAC runs at the file’s rate, so nothing is resampled. Android still mixes it, so this is not bit-perfect.';
  const label = kind === 'speaker' ? 'Speaker' : kind === 'wired' ? 'Wired' : kind === 'bluetooth' ? codec ?? 'Bluetooth' : path;
  return {
    path,
    label,
    outBits: outputBits(out),
    device: out.device ? out.device.name || DEVICE[out.device.kind] : null,
    bits: stream ? BITS[stream.encoding] ?? stream.encoding : null,
    streamKhz: stream ? formatKhz(stream.sampleRate) : null,
    khz: rate ? formatKhz(rate) : null,
    codec: link ? `${codec}${link.ldac && link.ldac !== 'adaptive' ? ' kbps' : ''}` : null,
    linkBits: link?.bits ? `${link.bits}-bit` : null,
    resampled,
    bitPerfect: mixer.bitPerfect,
    note,
  };
}
