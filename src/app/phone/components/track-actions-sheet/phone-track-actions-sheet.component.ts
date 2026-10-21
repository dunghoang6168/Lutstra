import { Component, ElementRef, EnvironmentInjector, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PlayerService } from '../../../core/player/player.service';
import { QueueActionsService } from '../../../core/player/queue-actions.service';
import { DailyMixService } from '../../../core/smart-shuffle/daily-mix.service';
import { formatTrackFormat } from '../../../features/home/library-quality';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { audioPathOpen, describeOutput, loadOutput, output } from '../../app-shell';
import { PhoneLibraryService } from '../../phone-library.service';
import { focusQuietly } from '../../focus';
import { SheetDragDirective } from '../../sheet-drag.directive';

/** Android paths are document URIs; the readable part follows the volume's ':' (FAT and exFAT forbid ':' in names). */
function readablePath(path: string): string {
  try { return decodeURIComponent(path).split(':').pop() || path; } catch { return path; }
}

/**
 * The ⋯ bottom sheet, as tonal pills after PixelPlayer's: Play next and Add to queue (not for the track that is
 * playing), Playlist, Album, Artist, and a File info row that opens the file and where its sound goes. Opened from a
 * queue row it acts on that entry instead: Play now, Play next (moves it) and Remove.
 * It closes on Escape, which Android Back sends.
 */
@Component({
  selector: 'app-phone-track-actions-sheet',
  standalone: true,
  imports: [CoverArtComponent, IconComponent, RouterLink, SheetDragDirective],
  templateUrl: './phone-track-actions-sheet.component.html',
  styleUrl: './phone-track-actions-sheet.component.scss',
})
export class PhoneTrackActionsSheetComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly player = inject(PlayerService);
  private readonly queueActions = inject(QueueActionsService);
  private readonly mix = inject(DailyMixService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly rootInjector = inject(EnvironmentInjector);
  readonly tracks = computed(() => this.library.actionTracks() ?? []);
  readonly track = computed(() => this.tracks().length === 1 ? this.tracks()[0] : null);
  readonly title = computed(() => this.track()?.title ?? `${this.tracks().length} tracks`);
  /** Queueing the track that is already playing would only duplicate it. */
  readonly isCurrent = computed(() => !!this.track() && this.track()!.id === this.player.currentTrack()?.id);
  /** The queue entry when the sheet was opened from a queue row; null once that entry leaves the queue. */
  readonly entry = computed(() => {
    const entry = this.library.actionEntry();
    return entry && this.player.queue().some((item) => item.id === entry.id) ? entry : null;
  });
  private readonly entryIndex = computed(() => {
    const id = this.entry()?.id;
    return id ? this.player.queue().findIndex((item) => item.id === id) : -1;
  });
  readonly canPlayNow = computed(() => !!this.entry()?.track.isAvailable && this.entryIndex() !== this.player.currentIndex());
  /** From a queue row: not the current entry, nor the one already next. Elsewhere: any track but the playing one. */
  readonly canPlayNext = computed(() => this.entry()
    ? this.entryIndex() !== this.player.currentIndex() && this.entryIndex() !== this.player.currentIndex() + 1
    : !this.isCurrent());
  readonly infoOpen = signal(false);
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
    const bitrate = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null;
    const size = track.fileSize ? `${(track.fileSize / 1048576).toFixed(1)} MB` : null;
    return {
      format: formatTrackFormat(track),
      bitrate,
      channels: track.channels,
      size,
      summary: [bitrate, size].filter(Boolean).join(' · '),
      path: readablePath(track.path),
      // The output is live, so it is shown for the playing track only.
      output: track.id === this.player.currentTrack()?.id ? describeOutput(output()) : null,
    };
  });

  constructor() {
    void loadOutput();
    afterNextRender(() => focusQuietly(this.host.querySelector<HTMLElement>('.action')));
  }

  /** `then` runs once focus is back on the opener. */
  close(then?: () => void): void {
    this.library.actionTracks.set(null);
    this.library.actionEntry.set(null);
    this.library.actionFromMix.set(false);
    // Now Playing and the queue stay inert until the next render, and this sheet is gone by then, so the root injector waits.
    const opener = this.opener;
    afterNextRender(() => {
      if (opener?.isConnected) focusQuietly(opener);
      then?.();
    }, { injector: this.rootInjector });
  }

  playNow(): void {
    const index = this.entryIndex();
    if (index >= 0) void this.player.jumpToQueueIndex(index);
    this.close();
  }

  playNext(): void {
    const entry = this.entry();
    const current = this.player.currentQueueEntry();
    if (entry && current) {
      if (this.player.moveQueueEntry(entry.id, current.id, 'after')) this.queueActions.notify(`“${entry.track.title}” plays next`);
    } else {
      this.library.playNext(this.tracks());
    }
    this.close();
  }

  /** Same as swiping the row away. */
  remove(): void {
    const entry = this.entry();
    if (entry) this.library.removeFromQueue(entry);
    this.close();
  }

  addToQueue(): void {
    this.library.addToQueue(this.tracks());
    this.close();
  }

  /** Taking a track out of Flex Mix also tells Smart Shuffle it was not wanted (DailyMixService.remove). */
  removeFromMix(): void {
    const track = this.track();
    if (track) this.mix.remove(track);
    this.close();
  }

  /** The ⋯ button gets focus back first, so the Audio path sheet returns focus there. */
  openAudioPath(): void {
    this.close(() => audioPathOpen.set(true));
  }

  addToPlaylist(): void {
    const tracks = this.tracks();
    // The ⋯ button gets focus back first, so the dialog returns focus there when it closes.
    this.close(() => this.library.playlistTracks.set(tracks));
  }
}
