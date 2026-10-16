import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Album } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { RecentPlaysService, findRecentPlayableTrack, recentTrackCollection, recentlyPlayedAlbums } from '../../../core/layout/recent-plays.service';
import { albumFormatMap, formatTrackFormat } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';

const STRIP_LENGTH = 10;

/** Home: continue listening, a Smart Shuffle quick start, then recently added and recently played albums. */
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
  /** The playing track, or else the last one played that is still on the phone. */
  readonly resume = computed(() => {
    const current = this.player.currentTrack();
    const track = current ?? findRecentPlayableTrack(this.recentPlays.entries(), this.library.trackById());
    return track ? { track, current: !!current, format: formatTrackFormat(track) } : null;
  });
  readonly recentlyAdded = computed(() => {
    const byId = this.library.trackById();
    const newest = (album: Album) => Math.max(0, ...album.trackIds.map((id) => byId.get(id)?.lastModified ?? 0));
    return [...this.albums()].sort((a, b) => newest(b) - newest(a)).slice(0, STRIP_LENGTH);
  });
  readonly recentlyPlayed = computed(() => recentlyPlayedAlbums(this.recentPlays.entries(), this.albums(), null).slice(0, STRIP_LENGTH));

  constructor() {
    void this.library.ensureLoaded();
  }

  playResume(): void {
    const resume = this.resume();
    if (!resume) return;
    if (resume.current) { void this.player.togglePlayPause(); return; }
    const album = this.albums().find((item) => item.trackIds.includes(resume.track.id)) ?? null;
    const collection = recentTrackCollection(resume.track, album, this.library.trackById());
    this.library.play(collection.tracks, collection.startIndex);
  }

  startSmartShuffle(): void {
    void this.smartShuffle.playSuggestions();
  }
}
