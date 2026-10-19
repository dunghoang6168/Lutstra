import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Album, Track } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { DailyMixService, isMixQueue } from '../../../core/smart-shuffle/daily-mix.service';
import { RecentPlaysService, recentlyPlayedAlbums } from '../../../core/layout/recent-plays.service';
import { albumFormatMap } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';

const STRIP_LENGTH = 10;
const MIX_ROWS = 5;
/** The collage's shapes, in the order its slots are laid out. */
const COLLAGE_SHAPES = ['circle', 'pill', 'circle', 'tile', 'blob'] as const;

interface MixRow { track: Track; current: boolean; queueIndex: number | null; mixIndex: number | null }

/**
 * Home, after PixelPlayer's: Flex Mix (today's Daily Mix) up top, a collage of recently played covers, the mix's
 * Up next card, then album strips.
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

  readonly mix = inject(DailyMixService);
  readonly mixLive = computed(() => !this.player.modesLocked() && isMixQueue(this.player.queue(), this.mix.tracks()));
  /**
   * Up next: while the mix plays, the queue's own entries from the current one (suggestions stay in the Queue sheet);
   * otherwise the mix's first rows. `end` is set once the last of them is on the card.
   */
  readonly mixView = computed<{ rows: MixRow[]; end: boolean }>(() => {
    if (!this.mixLive()) {
      return { rows: this.mix.tracks().slice(0, MIX_ROWS).map((track, i) => ({ track, current: false, queueIndex: null, mixIndex: i })), end: false };
    }
    const at = this.player.currentIndex();
    const own = this.player.queue().map((entry, queueIndex) => ({ entry, queueIndex })).filter(({ entry }) => !entry.suggested);
    const next = own.findIndex(({ queueIndex }) => queueIndex >= at);
    const from = next >= 0 ? next : Math.max(0, own.length - MIX_ROWS);
    const rows = own.slice(from, from + MIX_ROWS).map(({ entry, queueIndex }) => ({ track: entry.track, current: queueIndex === at, queueIndex, mixIndex: null }));
    return { rows, end: from + rows.length >= own.length };
  });
  /** Autoplay carries on after the mix: said on the card once its end is in view. */
  readonly autoplayNote = computed(() => this.mixView().end && this.player.autoplay() && !this.player.smartShuffle() && this.player.repeatMode() === 'off');
  readonly mixCovers = computed(() => [...new Set(this.mix.tracks().map((track) => track.artwork).filter((art): art is string => !!art))].slice(0, 3));

  constructor() {
    void this.library.ensureLoaded();
    // Today's mix once the library is in; DailyMixService keeps it for the day.
    effect(() => {
      if (this.library.snapshot()) untracked(() => void this.mix.ensure());
    });
  }

  /** The big button: plays Flex Mix from the top, or toggles playback while it is playing. */
  playMix(): void {
    if (this.mixLive()) void this.player.togglePlayPause();
    else void this.mix.play();
  }

  /** While the mix plays a row jumps to its entry, keeping what the user added; otherwise the mix starts there. */
  playRow(row: MixRow): void {
    if (row.queueIndex !== null) void this.player.jumpToQueueIndex(row.queueIndex);
    else if (row.mixIndex !== null) void this.mix.play(row.mixIndex);
  }
}
