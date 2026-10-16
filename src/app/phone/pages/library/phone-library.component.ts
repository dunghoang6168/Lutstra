import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { albumFormatMap, formatCount } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import {
  ALBUM_SORTS, ARTIST_SORTS, AlbumSort, ArtistSort, LibraryTab, SONG_SORTS, SongSort,
  isLibraryTab, sortAlbums, sortArtists, sortTracks,
} from '../../library-sort';

/** Library: chip tabs (kept in `?tab=` so Back returns to the same one), Shuffle and a sort for each list. */
@Component({
  selector: 'app-phone-library',
  standalone: true,
  imports: [RouterLink, IconComponent, CoverArtComponent, PhoneTrackRowComponent],
  templateUrl: './phone-library.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-library.component.scss'],
})
export class PhoneLibraryComponent {
  readonly library = inject(PhoneLibraryService);
  readonly tabs: { id: LibraryTab; label: string }[] = [
    { id: 'songs', label: 'Songs' },
    { id: 'albums', label: 'Albums' },
    { id: 'artists', label: 'Artists' },
    { id: 'playlists', label: 'Playlists' },
    { id: 'folders', label: 'Folders' },
  ];
  readonly songSorts = Object.entries(SONG_SORTS) as [SongSort, string][];
  readonly albumSorts = Object.entries(ALBUM_SORTS) as [AlbumSort, string][];
  readonly artistSorts = Object.entries(ARTIST_SORTS) as [ArtistSort, string][];
  readonly formatCount = formatCount;

  readonly tab = toSignal(inject(ActivatedRoute).queryParamMap.pipe(
    map((params) => { const tab = params.get('tab'); return isLibraryTab(tab) ? tab : 'songs'; }),
  ), { initialValue: 'songs' as LibraryTab });
  readonly songSort = this.library.songSort;
  readonly albumSort = this.library.albumSort;
  readonly artistSort = this.library.artistSort;

  readonly loaded = computed(() => this.library.snapshot() !== null);
  readonly allTracks = computed(() => this.library.snapshot()?.tracks ?? []);
  readonly songs = computed(() => sortTracks(this.allTracks(), this.songSort()));
  readonly albums = computed(() => sortAlbums(this.library.snapshot()?.albums ?? [], this.albumSort()));
  readonly albumFormats = computed(() => albumFormatMap(this.library.snapshot()?.albums ?? [], this.allTracks()));
  readonly artists = computed(() => sortArtists(this.library.snapshot()?.artists ?? [], this.artistSort()));
  readonly folders = computed(() => this.library.snapshot()?.folders ?? []);
  readonly playlists = this.library.playlists;
  readonly count = computed(() => {
    switch (this.tab()) {
      case 'songs': return plural(this.songs().length, 'track');
      case 'albums': return plural(this.albums().length, 'album');
      case 'artists': return plural(this.artists().length, 'artist');
      case 'playlists': return plural(this.playlists().length, 'playlist');
      default: return plural(this.folders().length, 'folder');
    }
  });

  constructor() {
    void this.library.ensureLoaded();
    void this.library.loadPlaylists();
  }

  playSong(index: number): void {
    this.library.play(this.songs(), index);
  }

  shuffleAll(): void {
    this.library.shuffle(this.allTracks().filter((track) => track.isAvailable));
  }

  onSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (this.tab() === 'songs') this.songSort.set(value as SongSort);
    else if (this.tab() === 'albums') this.albumSort.set(value as AlbumSort);
    else this.artistSort.set(value as ArtistSort);
  }
}

function plural(count: number, noun: string): string {
  return `${formatCount.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}
