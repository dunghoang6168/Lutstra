import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Album, Track } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { RecentPlaysService, recentlyPlayedAlbums } from '../../../core/layout/recent-plays.service';
import { albumFormatMap } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';

const STRIP_LENGTH = 10;
const MIX_ROWS = 5;
/** The collage's shapes, in the order its slots are laid out. */
const COLLAGE_SHAPES = ['circle', 'pill', 'circle', 'tile', 'blob'] as const;

interface MixRow { track: Track; suggested: boolean; current: boolean; queueIndex: number | null }

/**
 * Home, after PixelPlayer's: Smart Shuffle up top, a collage of recently played covers, the mix itself
 * (the live queue while Smart Shuffle plays, otherwise a preview of its picks), then album strips.
 */
@Component({
  selector: 'app-phone-home',
  standalone: true,
  imports: [RouterLink, IconComponent, CoverArtComponent],
  templateUrl: './phone-home.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-home.component.scss'],
})
export class PhoneHomeComponent {
  readonly player = inject(PlayerService);
  readonly library = inject(PhoneLibraryService);
  private readonly smartShuffle = inject(SmartShuffleService);
  private readonly recentPlays = inject(RecentPlaysService);

  private readonly albums = computed(() => this.library.snapshot()?.albums ?? []);
  readonly albumFormats = computed(() => albumFormatMap(this.albums(), this.library.snapshot()?.tracks ?? []));
  readonly recentlyAdded = computed(() => {
    const byId = this.library.trackById();
    const newest = (album: Album) => Math.max(0, ...album.trackIds.map((id) => byId.get(id)?.lastModified ?? 0));
    return [...this.albums()].sort((a, b) => newest(b) - newest(a)).slice(0, STRIP_LENGTH);
  });
  readonly recentlyPlayed = computed(() => recentlyPlayedAlbums(this.recentPlays.entries(), this.albums(), null).slice(0, STRIP_LENGTH));
  /** Covers only: recently played first, topped up with recently added. Hidden below three. */
  readonly collage = computed(() => {
    const seen = new Set<string>();
    const covers = [...this.recentlyPlayed(), ...this.recentlyAdded()]
      .filter((album) => album.artwork && !seen.has(album.id) && !!seen.add(album.id))
      .slice(0, COLLAGE_SHAPES.length);
    return covers.length >= 3 ? covers.map((album, i) => ({ album, shape: COLLAGE_SHAPES[i], slot: i })) : [];
  });

  readonly preview = signal<Track[]>([]);
  readonly mixLive = computed(() => this.player.smartShuffle() && this.player.queue().length > 0 && !this.player.modesLocked());
  readonly mixRows = computed<MixRow[]>(() => {
    if (this.mixLive()) {
      const index = Math.max(0, this.player.currentIndex());
      return this.player.queue().slice(index, index + MIX_ROWS).map((entry, i) => ({
        track: entry.track, suggested: !!entry.suggested, current: i === 0 && this.player.currentIndex() >= 0, queueIndex: index + i,
      }));
    }
    return this.preview().slice(0, MIX_ROWS).map((track) => ({ track, suggested: true, current: false, queueIndex: null }));
  });
  readonly mixCovers = computed(() => this.mixRows().map((row) => row.track.artwork).filter((art): art is string => !!art).slice(0, 3));

  constructor() {
    void this.library.ensureLoaded();
    // A fresh preview once the library is in, and again whenever Smart Shuffle stops.
    effect(() => {
      const ready = this.library.snapshot() !== null;
      const live = this.mixLive();
      if (ready && !live) untracked(() => void this.refreshPreview());
    });
  }

  async refreshPreview(): Promise<void> {
    try { this.preview.set(await this.smartShuffle.previewSuggestions()); } catch { this.preview.set([]); }
  }

  /** The big button: plays the previewed picks, or toggles playback while the mix is already playing. */
  playMix(): void {
    if (this.mixLive()) { void this.player.togglePlayPause(); return; }
    void this.smartShuffle.playSuggestions(this.preview());
  }

  playRow(row: MixRow, index: number): void {
    if (row.queueIndex !== null) { void this.player.jumpToQueueIndex(row.queueIndex); return; }
    // Starting from a later preview row keeps the picks after it.
    void this.smartShuffle.playSuggestions(this.preview().slice(index));
  }
}
