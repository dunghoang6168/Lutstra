import type { NativeOutput } from '../core/android/android-playback.engine';
import { formatKhz } from '../features/home/library-quality';
import { outputBits } from './app-shell';

/** A run of text; measurements are set in mono. */
export interface PathPart {
  text: string;
  measure?: boolean;
}

export interface PathStep {
  icon: 'decoder' | 'app' | 'mixer' | 'bluetooth' | 'usb' | 'speaker' | 'wired';
  label: string;
  value: PathPart[];
  detail?: string;
}

export interface AudioPath {
  /** One line on what happens to the sound; `ok` only when nothing changes its rate or mixes it away from the file. */
  verdict: { parts: PathPart[]; ok: boolean };
  steps: PathStep[];
  note: string;
  usb: boolean;
}

const m = (text: string): PathPart => ({ text, measure: true });
const t = (text: string): PathPart => ({ text });
const DEVICE = { speaker: 'Phone speaker', wired: 'Wired headphones', usb: 'USB DAC', bluetooth: 'Bluetooth', capture: 'Screen capture', other: 'Other output' };

/** "16-bit · 48 kHz": bits first, then the rate; either may be unknown. */
function bitsAndRate(bits: string | null, khz: string | null): PathPart[] {
  const parts: PathPart[] = [];
  if (bits) parts.push(m(bits));
  if (khz) parts.push(...(parts.length ? [t(' · ')] : []), m(khz), t(' kHz'));
  return parts;
}

/**
 * The Audio path sheet's steps after the file, after Poweramp's audio info chain: decoder, Lutstra → Android,
 * Android's mixer (or the USB mixer), and the output the device receives, bits before the rate. Only what Android
 * reports is stated; an unknown rate or bit depth is left out. `fileBits` lets the note say when bits are cut.
 */
export function audioPath(out: NativeOutput, fileBits: number | null = null): AudioPath {
  const kind = out.device?.kind ?? null;
  const { mixer, stream } = out;
  const usb = kind === 'usb';
  const bluetooth = kind === 'bluetooth';
  const link = bluetooth ? out.bluetooth ?? null : null;
  const codec = link ? `${link.codec}${link.ldac === 'adaptive' ? ' adaptive' : link.ldac ? ` ${link.ldac} kbps` : ''}` : null;
  const rate = link ? link.sampleRate : mixer.sampleRate;
  const streamKhz = stream ? formatKhz(stream.sampleRate) : null;
  const khz = rate ? formatKhz(rate) : null;
  const bits = outputBits(out);
  const resampled = !!rate && !!stream && stream.sampleRate !== rate;
  const device = out.device ? out.device.name || DEVICE[out.device.kind] : 'Not reported';
  const resampleParts = (): PathPart[] => [t('Android resamples '), m(streamKhz!), t(' → '), m(khz!), t(' kHz')];
  const withSpecs = (name: string): PathPart[] => [t(name), ...(bits || khz ? [t(' · '), ...bitsAndRate(bits, khz)] : [])];
  const steps: PathStep[] = [];

  steps.push({
    icon: 'decoder', label: 'Decoder', value: [t(out.decoder ? decoderName(out.decoder) : 'Android decoder')],
    detail: out.decoder ?? undefined,
  });
  steps.push({
    icon: 'app', label: 'Lutstra → Android', value: [m('32-bit'), t(' float'), ...(streamKhz ? [t(' · '), m(streamKhz), t(' kHz')] : [])],
    detail: 'Float is Android’s working format: 16- and 24-bit files fit in it exactly. No EQ, volume stays full.',
  });

  let verdict: AudioPath['verdict'];
  let note = 'Android mixes every app’s audio, so this is not bit-perfect. The file itself is untouched.';
  let output: PathStep = { icon: usb ? 'usb' : kind === 'wired' ? 'wired' : 'speaker', label: 'Output', value: withSpecs(device) };

  if (kind === 'capture') {
    steps.push({ icon: 'mixer', label: 'Android', value: [t('Sent to a screen capture')], detail: 'Another app is recording what plays, so Android sends it there.' });
    verdict = { parts: [t('Another app is capturing what plays')], ok: false };
    note = 'Stop the screen mirror (for example Phone View) to hear Lutstra on your own output again.';
  } else if (mixer.bitPerfect) {
    steps.push({ icon: 'mixer', label: 'USB', value: [t('Bit-perfect')], detail: 'Not mixed, no volume scaling.' });
    verdict = { parts: [t('Bit-perfect: the DAC gets the stream untouched')], ok: true };
    note = 'Lutstra’s stream reaches the DAC untouched: no mixing, no volume scaling.';
  } else if (usb && mixer.matched) {
    steps.push({ icon: 'mixer', label: 'USB mixer', value: [t('File rate')], detail: 'Android still mixes, so this is not bit-perfect.' });
    verdict = resampled ? { parts: resampleParts(), ok: false } : { parts: [t('Nothing resampled: the DAC runs at the file’s rate')], ok: true };
    note = 'The DAC runs at the file’s rate, so nothing is resampled. Android still mixes it, so this is not bit-perfect.';
  } else if (bluetooth) {
    steps.push(resampled
      ? { icon: 'mixer', label: 'Android mixer', value: [t('Resampled to '), m(khz!), t(' kHz')], detail: 'The Bluetooth link runs at one rate for every app.' }
      : khz
        ? { icon: 'mixer', label: 'Android', value: [t('Same rate as the link')], detail: 'Nothing is resampled on the way to Bluetooth.' }
        : { icon: 'mixer', label: 'Android mixer', value: [t('Rate not reported')], detail: 'Android does not say which rate, so Lutstra does not guess.' });
    output = link
      ? { icon: 'bluetooth', label: 'Output', value: withSpecs(codec!),
          detail: `Re-encoded for ${device}${link.ldac === 'adaptive' ? '; adaptive lowers the bitrate when the signal weakens (up to 990 kbps)' : ''}.` }
      : { icon: 'bluetooth', label: 'Output', value: [t(device)],
          detail: out.codecAccess === 'needed' ? 'Allow Nearby devices in Settings to see the codec.' : 'Android did not report the codec.' };
    verdict = resampled
      ? { parts: [...resampleParts(), t(link ? ` for ${link.codec}` : '')], ok: false }
      : { parts: [t(`Nothing resampled; ${link?.codec ?? 'Bluetooth'} still re-encodes it`)], ok: false };
    note = 'Bluetooth sends a compressed copy, so this is not bit-perfect. The file itself is untouched.';
  } else {
    steps.push(khz
      ? { icon: 'mixer', label: usb ? 'Android mixer (Shared)' : 'Android mixer', value: resampled ? [t('Resampled to '), m(khz), t(' kHz')] : [m(khz), t(' kHz · mixed in float')],
          detail: 'Every app’s sound is mixed here at one rate.' }
      : { icon: 'mixer', label: 'Android mixer', value: [t('Rate not reported')], detail: 'Android does not say which rate, so Lutstra does not guess.' });
    verdict = resampled
      ? { parts: resampleParts(), ok: false }
      : khz
        ? { parts: [t(`Nothing resampled; Android mixes it${bits ? ` and sends ${bits}` : ''}`)], ok: false }
        : { parts: [t('Android does not report the output rate')], ok: false };
    const outBits = bits ? Number.parseInt(bits, 10) : 0;
    if (fileBits && outBits && fileBits > outBits) {
      note = `Your ${fileBits}-bit file is cut to ${bits} at the ${kind === 'speaker' ? 'speaker' : 'output'}. ${note}`;
    }
  }
  steps.push(output);
  return { verdict, steps, note, usb };
}

/** "c2.android.flac.decoder" → "Android FLAC decoder"; other names are shown as they are. */
function decoderName(name: string): string {
  const android = /^(?:c2|omx)\.android\.([a-z0-9]+)\.decoder$/i.exec(name);
  return android ? `Android ${android[1].toUpperCase()} decoder` : name;
}
