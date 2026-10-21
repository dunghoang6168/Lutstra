import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { albumFormatMap, formatCount } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { NearScreenDirective } from '../../near-screen.directive';
import {
  ALBUM_SORTS, ARTIST_SORTS, AlbumSort, ArtistSort, LIBRARY_PAGE, LibraryTab, SONG_SORTS, SongSort,
  isLibraryTab, sortAlbums, sortArtists, sortTracks,
} from '../../library-sort';

/** Library: chip tabs (kept in `?tab=` so Back returns to the same one), Shuffle and a sort for each list. */
@Component({
  selector: 'app-phone-library',
  standalone: true,
  imports: [RouterLink, IconComponent, CoverArtComponent, PhoneTrackRowComponent, NearScreenDirective],
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
  /** Long lists render in pages, so opening the Library does not build every row at once. */
  readonly shown = this.library.libraryShown;
  readonly visibleSongs = computed(() => this.songs().slice(0, this.shown()));
  readonly visibleAlbums = computed(() => this.albums().slice(0, this.shown()));
  readonly visibleArtists = computed(() => this.artists().slice(0, this.shown()));
  readonly hasMore = computed(() => {
    switch (this.tab()) {
      case 'songs': return this.songs().length > this.shown();
      case 'albums': return this.albums().length > this.shown();
      case 'artists': return this.artists().length > this.shown();
      default: return false;
    }
  });
  readonly count = computed(() => {
    switch (this.tab()) {
      case 'songs': return plural(this.songs().length, 'track');
      case 'albums': return plural(this.albums().length, 'album');
      case 'artists': return plural(this.artists().length, 'artist');
      case 'playlists': return plural(this.playlists().length, 'playlist');
      default: return plural(this.folders().length, 'folder');
    }
  });

  /** Quick return: the chips and toolbar hide while scrolling down and come back on any scroll up. */
  readonly barHidden = signal(false);
  readonly barPinned = signal(false);
  private readonly bar = viewChild.required<ElementRef<HTMLElement>>('bar');

  constructor() {
    this.followScroll();
    // A fresh visit starts at the first page; Back keeps what was shown so the shell's saved scroll offset fits.
    if (inject(Router).currentNavigation()?.trigger !== 'popstate') this.shown.set(LIBRARY_PAGE);
    void this.library.ensureLoaded();
    void this.library.loadPlaylists();
  }

  /** The page scrolls inside the shell's content area, so the bar follows that scroller's direction. */
  private followScroll(): void {
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const scroller = host.closest('.phone-content');
      if (!scroller) return;
      let last = scroller.scrollTop;
      const onScroll = (): void => {
        const top = scroller.scrollTop;
        this.barPinned.set(top > 0);
        // Near the top the bar sits in its own place, so it stays.
        if (top <= this.bar().nativeElement.offsetHeight) { this.barHidden.set(false); last = top; return; }
        // A few pixels of finger jitter do not flip it.
        if (Math.abs(top - last) < SCROLL_SLOP) return;
        this.barHidden.set(top > last);
        last = top;
      };
      scroller.addEventListener('scroll', onScroll, { passive: true });
      destroyRef.onDestroy(() => scroller.removeEventListener('scroll', onScroll));
    });
  }

  showMore(): void {
    this.shown.update((count) => count + LIBRARY_PAGE);
  }

  resetShown(): void {
    this.shown.set(LIBRARY_PAGE);
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

/** Pixels of scroll in one direction before the bar reacts. */
const SCROLL_SLOP = 6;

function plural(count: number, noun: string): string {
  return `${formatCount.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}
