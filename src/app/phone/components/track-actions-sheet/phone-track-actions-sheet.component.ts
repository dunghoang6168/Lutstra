import { Component, ElementRef, EnvironmentInjector, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlayerService } from '../../../core/player/player.service';
import { formatKhz, formatTrackFormat } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { loadMixerRate, mixerRate, outputPath } from '../../app-shell';
import { PhoneLibraryService } from '../../phone-library.service';
import { focusQuietly } from '../../focus';

/** Android paths are document URIs; the readable part follows the volume's ':' (FAT and exFAT forbid ':' in names). */
function readablePath(path: string): string {
  try { return decodeURIComponent(path).split(':').pop() || path; } catch { return path; }
}

/**
 * The ⋯ bottom sheet: Play next, Add to queue (not for the track that is playing), Go to album or artist,
 * Add to playlist, and for one track its file and where its sound goes. It closes on Escape, which Android Back sends.
 */
@Component({
  selector: 'app-phone-track-actions-sheet',
  standalone: true,
  imports: [IconComponent, RouterLink],
  templateUrl: './phone-track-actions-sheet.component.html',
  styleUrl: './phone-track-actions-sheet.component.scss',
})
export class PhoneTrackActionsSheetComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly player = inject(PlayerService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly rootInjector = inject(EnvironmentInjector);
  readonly tracks = computed(() => this.library.actionTracks() ?? []);
  readonly track = computed(() => this.tracks().length === 1 ? this.tracks()[0] : null);
  readonly title = computed(() => this.track()?.title ?? `${this.tracks().length} tracks`);
  /** Queueing the track that is already playing would only duplicate it. */
  readonly isCurrent = computed(() => !!this.track() && this.track()!.id === this.player.currentTrack()?.id);
  readonly albumId = computed(() => {
    const id = this.track()?.id;
    return id ? this.library.snapshot()?.albums.find((album) => album.trackIds.includes(id))?.id ?? null : null;
  });
  readonly artistId = computed(() => {
    const id = this.track()?.id;
    return id ? this.library.snapshot()?.artists.find((artist) => artist.trackIds.includes(id))?.id ?? null : null;
  });
  readonly info = computed(() => {
    const track = this.track();
    if (!track) return null;
    return {
      format: formatTrackFormat(track),
      bitrate: track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null,
      channels: track.channels,
      size: track.fileSize ? `${(track.fileSize / 1048576).toFixed(1)} MB` : null,
      path: readablePath(track.path),
      fileKhz: track.sampleRate ? formatKhz(track.sampleRate) : null,
      output: outputPath(track.sampleRate, mixerRate()),
    };
  });

  constructor() {
    void loadMixerRate();
    afterNextRender(() => focusQuietly(this.host.querySelector<HTMLElement>('.action')));
  }

  /** `then` runs once focus is back on the opener. */
  close(then?: () => void): void {
    this.library.actionTracks.set(null);
    // Now Playing stays inert until the next render, and this sheet is gone by then, so the root injector waits.
    const opener = this.opener;
    afterNextRender(() => {
      if (opener?.isConnected) focusQuietly(opener);
      then?.();
    }, { injector: this.rootInjector });
  }

  playNext(): void {
    this.library.playNext(this.tracks());
    this.close();
  }

  addToQueue(): void {
    this.library.addToQueue(this.tracks());
    this.close();
  }

  addToPlaylist(): void {
    const tracks = this.tracks();
    // The ⋯ button gets focus back first, so the dialog returns focus there when it closes.
    this.close(() => this.library.playlistTracks.set(tracks));
  }
}
