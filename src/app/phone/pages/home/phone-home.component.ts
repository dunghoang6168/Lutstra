import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Album } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { DailyMixService } from '../../../core/smart-shuffle/daily-mix.service';
import { RecentPlaysService, recentlyPlayedAlbums } from '../../../core/layout/recent-plays.service';
import { albumFormatMap } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';

const STRIP_LENGTH = 10;
/** The collage's shapes, in the order its slots are laid out. */
const COLLAGE_SHAPES = ['circle', 'pill', 'circle', 'tile', 'blob'] as const;

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
  /** Autoplay carries on after the mix: said on the card once its end is in view. */
  readonly autoplayNote = computed(() => this.mix.upNext().end && this.player.autoplay() && !this.player.smartShuffle() && this.player.repeatMode() === 'off');
  readonly mixCovers = computed(() => this.mix.covers().slice(0, 3));

  constructor() {
    void this.library.ensureLoaded();
    // Today's mix once the library is in; DailyMixService keeps it for the day.
    effect(() => {
      if (this.library.snapshot()) untracked(() => void this.mix.ensure());
    });
  }
}
