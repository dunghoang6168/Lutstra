import {
  Component, DestroyRef, ElementRef, Injector, NgZone, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { FolderNode, Track } from '../../../core/models';
import { albumFormatMap, formatCount } from '../../../features/home/library-quality';
import { artistAvatarCandidates } from '../../../features/artists/artist-avatar';
import { selectPlaylistArtwork } from '../../../shared/utils/list-media';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { ScrollbarComponent } from '../../../shared/components/scrollbar/scrollbar.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { NearScreenDirective } from '../../near-screen.directive';
import { CoverToneDirective } from '../../cover-tone.directive';
import { SheetDragDirective } from '../../sheet-drag.directive';
import { haptic } from '../../haptics';
import { pageBack } from '../../app-shell';
import { findNode, folderTrail, rootOf, trackIdsBelow } from '../../folder-tree';
import {
  ALBUM_SORTS, ARTIST_SORTS, LIBRARY_PAGE, LibraryTab, PLAYLIST_SORTS, SONG_SORTS,
  isLibraryTab, sortAlbums, sortArtists, sortPlaylists, sortTracks,
} from '../../library-sort';

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'songs', label: 'Songs' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'folders', label: 'Folders' },
];

/** Pixels of scroll in one direction before the sheet slides. */
const SCROLL_SLOP = 6;

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Library, after PixelPlayer's: a large title, chips, and a sheet holding an action row over a pager of the five
 * tabs. The pager is a native horizontal scroller with snap points, so it follows the finger, flings and settles
 * by itself; the chip follows the page nearest the middle. Scrolling a tab down slides the sheet up over the title
 * and chips, any scroll up brings them back. Folders open inside their tab (`?folder=`), and Back goes up one.
 */
@Component({
  selector: 'app-phone-library',
  standalone: true,
  imports: [
    RouterLink, FormsModule, IconComponent, CoverArtComponent, ScrollbarComponent, PhoneTrackRowComponent,
    NearScreenDirective, CoverToneDirective, SheetDragDirective,
  ],
  templateUrl: './phone-library.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-library.component.scss'],
})
export class PhoneLibraryComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);
  readonly tabs = TABS;
  readonly formatCount = formatCount;

  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  private readonly urlTab = computed<LibraryTab>(() => {
    const tab = this.params()?.get('tab');
    return isLibraryTab(tab) ? tab : 'songs';
  });
  readonly folderId = computed(() => this.params()?.get('folder') ?? null);

  /** The chip that is lit: the page nearest the pager's middle, so it changes halfway through a swipe. */
  readonly active = signal(TABS.findIndex((tab) => tab.id === this.urlTab()));
  readonly activeTab = computed(() => TABS[this.active()].id);
  readonly onPlaylists = computed(() => this.activeTab() === 'playlists');
  /** Pages are built once they are shown or next to the shown one, then kept, so each keeps its scroll. */
  readonly built = signal(new Set<LibraryTab>());
  /** Scrolled down: the sheet has slid up over the title and chips. */
  readonly collapsed = signal(false);

  private readonly pager = viewChild.required<ElementRef<HTMLElement>>('pager');
  private readonly chips = viewChild.required<ElementRef<HTMLElement>>('chips');
  private readonly crumbs = viewChild<ElementRef<HTMLElement>>('crumbs');
  private readonly sortDialog = viewChild.required<ElementRef<HTMLDialogElement>>('sortDialog');
  private readonly newDialog = viewChild.required<ElementRef<HTMLDialogElement>>('newDialog');

  readonly loaded = computed(() => this.library.snapshot() !== null);
  readonly allTracks = computed(() => this.library.snapshot()?.tracks ?? []);
  readonly songs = computed(() => sortTracks(this.allTracks(), this.library.songSort()));
  readonly albums = computed(() => sortAlbums(this.library.snapshot()?.albums ?? [], this.library.albumSort()));
  readonly albumFormats = computed(() => albumFormatMap(this.library.snapshot()?.albums ?? [], this.allTracks()));
  readonly artists = computed(() => sortArtists(this.library.snapshot()?.artists ?? [], this.library.artistSort()));
  readonly artistAvatars = computed(() => {
    const albums = this.library.snapshot()?.albums ?? [];
    return new Map(this.artists().map((artist) => [artist.id, artistAvatarCandidates(artist, albums)[0] ?? null]));
  });
  readonly playlists = computed(() => sortPlaylists(this.library.playlists(), this.library.playlistSort()));
  readonly playlistArt = computed(() => {
    const byId = this.library.trackById();
    return new Map(this.playlists().map((playlist) => [playlist.id, selectPlaylistArtwork(playlist.entries, byId)]));
  });
  readonly roots = computed(() => this.library.snapshot()?.folders ?? []);

  /** Long lists render in pages, so opening the Library does not build every row at once. */
  shown(tab: LibraryTab): number {
    return this.library.tabShown()[tab] ?? LIBRARY_PAGE;
  }
  readonly visibleSongs = computed(() => this.songs().slice(0, this.shown('songs')));
  readonly visibleAlbums = computed(() => this.albums().slice(0, this.shown('albums')));
  readonly visibleArtists = computed(() => this.artists().slice(0, this.shown('artists')));

  readonly count = computed(() => {
    switch (this.activeTab()) {
      case 'songs': return plural(this.songs().length, 'track');
      case 'albums': return plural(this.albums().length, 'album');
      case 'artists': return plural(this.artists().length, 'artist');
      default: return plural(this.playlists().length, 'playlist');
    }
  });

  // Folders, opened inside the tab.
  readonly folderRoot = computed(() => rootOf(this.roots(), this.folderId()));
  private readonly trees = signal(new Map<string, FolderNode | null>());
  readonly folderNode = computed(() => {
    const root = this.folderRoot();
    return root ? findNode(this.trees().get(root.id) ?? null, this.folderId()!) : null;
  });
  readonly subfolders = computed(() => (this.folderNode()?.children ?? []).filter((child) => child.isFolder)
    .sort((a, b) => text.compare(a.name, b.name)));
  readonly folderTracks = computed(() => this.library.tracksOf((this.folderNode()?.children ?? [])
    .filter((child) => !child.isFolder && child.trackId).map((child) => child.trackId!))
    .sort((a, b) => text.compare(a.fileName, b.fileName)));
  readonly trail = computed(() => folderTrail(this.folderRoot(), this.folderId(), 'Music folders'));
  readonly trackCountBelow = trackIdsBelow;

  // Sort sheet.
  readonly sortOptions = computed<[string, string][]>(() => {
    switch (this.activeTab()) {
      case 'songs': return Object.entries(SONG_SORTS);
      case 'albums': return Object.entries(ALBUM_SORTS);
      case 'artists': return Object.entries(ARTIST_SORTS);
      case 'playlists': return Object.entries(PLAYLIST_SORTS);
      default: return [];
    }
  });
  readonly sortValue = computed<string>(() => {
    switch (this.activeTab()) {
      case 'songs': return this.library.songSort();
      case 'albums': return this.library.albumSort();
      case 'artists': return this.library.artistSort();
      default: return this.library.playlistSort();
    }
  });
  newName = '';

  /** The scrollbar bubble: the first letter of the row the thumb is at, for orders by name. */
  readonly labels: Record<LibraryTab, (fraction: number) => string | null> = {
    songs: (fraction) => {
      const sort = this.library.songSort();
      if (sort === 'added') return null;
      const track = at(this.visibleSongs(), fraction);
      return track ? initial(sort === 'artist' ? track.artist : sort === 'album' ? track.album : track.title) : null;
    },
    albums: (fraction) => {
      const album = at(this.visibleAlbums(), fraction);
      if (!album) return null;
      const sort = this.library.albumSort();
      return sort === 'year' ? (album.year ? String(album.year) : null) : initial(sort === 'artist' ? album.artist : album.title);
    },
    artists: (fraction) => this.library.artistSort() === 'name' ? initial(at(this.visibleArtists(), fraction)?.name) : null,
    playlists: (fraction) => this.library.playlistSort() === 'name' ? initial(at(this.playlists(), fraction)?.name) : null,
    folders: () => null,
  };

  constructor() {
    const destroyRef = inject(DestroyRef);
    // A fresh visit starts each tab at its top and first page; Back keeps them so each tab comes back where it was.
    const returning = this.router.currentNavigation()?.trigger === 'popstate';
    if (!returning) {
      this.library.tabShown.set({});
      this.library.tabScroll.clear();
    }
    this.build(this.active());
    void this.library.ensureLoaded();
    void this.library.loadPlaylists();

    // A link to another tab (the bottom nav's Library) moves the pager; the pager's own moves only rewrite the URL.
    effect(() => {
      const index = TABS.findIndex((tab) => tab.id === this.urlTab());
      untracked(() => { if (index !== this.active()) this.goTo(index, false); });
    });

    // Folder trees load once per music folder.
    effect(() => {
      const root = this.folderRoot();
      if (!root || untracked(() => this.trees().has(root.id))) return;
      void this.library.folderTree(root.id).then((tree) => this.trees.update((trees) => new Map(trees).set(root.id, tree)));
    });

    // A long path scrolls so its last folder shows, as PixelPlayer's Breadcrumbs do.
    effect(() => {
      this.trail();
      afterNextRender(() => {
        const crumbs = this.crumbs()?.nativeElement;
        crumbs?.scrollTo({ left: crumbs.scrollWidth });
      }, { injector: this.injector });
    });

    pageBack.set(() => this.folderUp());
    destroyRef.onDestroy(() => pageBack.set(null));

    afterNextRender(() => {
      const pager = this.pager().nativeElement;
      pager.scrollLeft = this.active() * pager.clientWidth;
      if (returning) this.restoreScroll();
      this.zone.runOutsideAngular(() => this.followScroll(pager, destroyRef));
    });
  }

  /** One listener for the pager and every page inside it: scroll events do not bubble, but capture sees them. */
  private followScroll(pager: HTMLElement, destroyRef: DestroyRef): void {
    const last = new Map<string, number>();
    const onScroll = (event: Event): void => {
      const target = event.target as HTMLElement;
      if (target === pager) {
        const index = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
        if (index !== this.active() && TABS[index]) this.zone.run(() => this.select(index));
        return;
      }
      const tab = target.dataset['tab'] as LibraryTab | undefined;
      if (!tab) return;
      const top = target.scrollTop;
      this.library.tabScroll.set(tab, top);
      if (tab !== this.activeTab()) return;
      const before = last.get(tab) ?? 0;
      let collapse = this.collapsed();
      if (top <= 0) collapse = false;
      else if (top - before > SCROLL_SLOP) collapse = true;
      else if (before - top > SCROLL_SLOP) collapse = false;
      else return;
      last.set(tab, top);
      if (collapse !== this.collapsed()) this.zone.run(() => this.collapsed.set(collapse));
    };
    // Once the pager settles, the URL names the tab, so Back from a detail page lands on it.
    const onSettle = (event: Event): void => {
      if (event.target !== pager) return;
      const tab = this.activeTab();
      if (tab !== this.urlTab()) {
        this.zone.run(() => void this.router.navigate([], { queryParams: { tab }, queryParamsHandling: 'merge', replaceUrl: true }));
      }
    };
    pager.addEventListener('scroll', onScroll, { capture: true, passive: true });
    pager.addEventListener('scrollend', onSettle, { capture: true });
    destroyRef.onDestroy(() => {
      pager.removeEventListener('scroll', onScroll, { capture: true });
      pager.removeEventListener('scrollend', onSettle, { capture: true });
    });
  }

  private restoreScroll(): void {
    for (const scroller of this.pager().nativeElement.querySelectorAll<HTMLElement>('.pane-scroll')) {
      const top = this.library.tabScroll.get(scroller.dataset['tab'] as LibraryTab);
      if (top) scroller.scrollTop = top;
    }
  }

  private build(index: number): void {
    const wanted = [index - 1, index, index + 1].map((i) => TABS[i]?.id).filter((id): id is LibraryTab => !!id);
    if (wanted.every((id) => this.built().has(id))) return;
    this.built.update((built) => new Set([...built, ...wanted]));
  }

  /** The page under the pager's middle changed: light its chip, as PixelPlayer's TabAnimation does. */
  private select(index: number): void {
    this.active.set(index);
    this.build(index);
    // A tab at its top cannot scroll up to bring the title back, so arriving there brings it back.
    if (!this.library.tabScroll.get(TABS[index].id)) this.collapsed.set(false);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    afterNextRender(() => {
      const row = this.chips().nativeElement;
      const chip = row.children[index] as HTMLElement | undefined;
      if (!chip) return;
      row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: reduced ? 'auto' : 'smooth' });
      if (reduced) return;
      const timing = { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
      chip.animate([{ scale: 1 }, { scale: 1.05 }, { scale: 1 }], timing);
      for (const side of [-1, 1]) {
        (row.children[index + side] as HTMLElement | undefined)
          ?.animate([{ translate: '0 0' }, { translate: `${side * 12}px 0` }, { translate: '0 0' }], timing);
      }
    }, { injector: this.injector });
  }

  /** Slides the pager to a tab: a chip tap, or a link to one. */
  goTo(index: number, tapped = true): void {
    if (tapped) haptic('tick');
    const pager = this.pager().nativeElement;
    const smooth = tapped && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    pager.scrollTo({ left: index * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) this.select(index);
  }

  showMore(tab: LibraryTab): void {
    this.library.tabShown.update((shown) => ({ ...shown, [tab]: this.shown(tab) + LIBRARY_PAGE }));
  }

  playSong(index: number): void {
    this.library.play(this.songs(), index);
  }

  playFolderTrack(index: number): void {
    this.library.play(this.folderTracks(), index);
  }

  /** Shuffle, after PixelPlayer: the whole library, one random album or artist, or every playlist's tracks. */
  shuffle(): void {
    const tab = this.activeTab();
    if (tab === 'albums' || tab === 'artists') {
      const pool = tab === 'albums' ? this.albums() : this.artists();
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) this.library.shuffle(this.playable(this.library.tracksOf(pick.trackIds)));
    } else if (tab === 'playlists') {
      const ids = new Set(this.playlists().flatMap((playlist) => playlist.entries.map((entry) => entry.trackId)));
      this.library.shuffle(this.playable(this.library.tracksOf([...ids])));
    } else {
      this.library.shuffle(this.playable(this.allTracks()));
    }
  }

  private playable(tracks: readonly Track[]): Track[] {
    return tracks.filter((track) => track.isAvailable);
  }

  openSort(): void {
    this.sortDialog().nativeElement.showModal();
  }

  closeSort(): void {
    this.sortDialog().nativeElement.close();
  }

  /** A drag down leaves the sheet where it was let go; the next open starts in place. */
  sortClosed(): void {
    this.sortDialog().nativeElement.style.translate = '';
  }

  pickSort(value: string): void {
    switch (this.activeTab()) {
      case 'songs': this.library.songSort.set(value as keyof typeof SONG_SORTS); break;
      case 'albums': this.library.albumSort.set(value as keyof typeof ALBUM_SORTS); break;
      case 'artists': this.library.artistSort.set(value as keyof typeof ARTIST_SORTS); break;
      case 'playlists': this.library.playlistSort.set(value as keyof typeof PLAYLIST_SORTS); break;
    }
    this.closeSort();
  }

  openNewPlaylist(): void {
    this.newName = '';
    this.newDialog().nativeElement.showModal();
  }

  async createPlaylist(): Promise<void> {
    const name = this.newName.trim();
    if (!name) return;
    this.newDialog().nativeElement.close();
    await this.library.createPlaylist(name);
  }

  openFolder(id: string | null): void {
    void this.router.navigate([], { queryParams: { tab: 'folders', folder: id }, replaceUrl: true });
  }

  /** Back inside a folder goes up one; at the list of music folders it is the shell's Back. */
  folderUp(): boolean {
    if (this.activeTab() !== 'folders' || !this.folderId()) return false;
    const trail = this.trail();
    this.openFolder(trail.at(-2)?.id ?? null);
    return true;
  }
}

function plural(count: number, noun: string): string {
  return `${formatCount.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function at<T>(items: readonly T[], fraction: number): T | undefined {
  return items[Math.min(items.length - 1, Math.floor(fraction * items.length))];
}

/** A row's first letter for the scrollbar bubble; digits and symbols read as #. */
function initial(value: string | null | undefined): string | null {
  const first = [...(value ?? '').trim()][0];
  if (!first) return null;
  return /\p{L}/u.test(first) ? first.toLocaleUpperCase() : '#';
}
