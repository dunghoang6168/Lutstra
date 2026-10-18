import { Component, ElementRef, EnvironmentInjector, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlayerService } from '../../../core/player/player.service';
import { formatKhz } from '../../../features/home/library-quality';
import { IconComponent, IconName } from '../../../shared/components/icon/icon.component';
import { audioPathOpen, loadOutput, output } from '../../app-shell';
import { PathPart, PathStep, audioPath } from '../../audio-path';
import { focusQuietly } from '../../focus';

const ICONS: Record<PathStep['icon'] | 'file', IconName> = {
  file: 'file-audio', decoder: 'cpu', app: 'music', mixer: 'sliders', bluetooth: 'bluetooth', usb: 'usb', speaker: 'speaker', wired: 'headphones',
};

/**
 * Where the playing track's sound goes, as a chain after Poweramp's audio info: the file, the decoder, Lutstra,
 * Android's mixer or the USB mixer, the Bluetooth codec and the device, with one line on what happens to it.
 * Opened from Now Playing's output chip; it closes on Escape, which Android Back sends.
 */
@Component({
  selector: 'app-phone-audio-path-sheet',
  standalone: true,
  imports: [IconComponent, RouterLink],
  templateUrl: './phone-audio-path-sheet.component.html',
  styleUrl: './phone-audio-path-sheet.component.scss',
})
export class PhoneAudioPathSheetComponent {
  private readonly player = inject(PlayerService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly rootInjector = inject(EnvironmentInjector);
  readonly icons = ICONS;
  readonly path = computed(() => {
    const out = output();
    return out ? audioPath(out, this.player.currentTrack()?.bitDepth ?? null) : null;
  });
  readonly mode = computed(() => ({ shared: 'Shared', match: 'File rate', bitperfect: 'Bit-perfect' } as Record<string, string>)[output()?.usbMode ?? 'shared'] ?? 'Shared');
  /** The file as the library read it: codec, bits, rate, channels, bitrate. */
  readonly file = computed<{ value: PathPart[]; detail: string } | null>(() => {
    const track = this.player.currentTrack();
    if (!track) return null;
    const value: PathPart[] = [{ text: track.codec?.toUpperCase() ?? 'Audio' }];
    if (track.bitDepth) value.push({ text: ' · ' }, { text: `${track.bitDepth}-bit`, measure: true });
    if (track.sampleRate) value.push({ text: ' · ' }, { text: formatKhz(track.sampleRate), measure: true }, { text: ' kHz' });
    if (track.channels) value.push({ text: track.channels === 2 ? ' · stereo' : track.channels === 1 ? ' · mono' : ` · ${track.channels} ch` });
    const detail = [track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null, track.title].filter(Boolean).join(' · ');
    return { value, detail };
  });

  constructor() {
    void loadOutput();
    afterNextRender(() => focusQuietly(this.host.querySelector<HTMLElement>('.sheet-title')));
  }

  close(): void {
    audioPathOpen.set(false);
    const opener = this.opener;
    afterNextRender(() => { if (opener?.isConnected) focusQuietly(opener); }, { injector: this.rootInjector });
  }
}
