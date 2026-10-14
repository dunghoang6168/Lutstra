import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY } from '../../core/contracts';
import { FolderNode, Track } from '../../core/models';
import { RightPanelService } from '../../core/layout/right-panel.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { RandomOptionsDialogComponent } from './random-options-dialog.component';
import { RandomReelComponent } from './random-reel.component';
import { RandomSessionService } from './random-session.service';
import { HARD_PITY, MYTHIC_GUARANTEE, RARITY_NAMES, RED_PITY, collectTrackIds, leadArtist, listFolders, popularityTiers, sourceTrackIds, tierCounts, trackRegions } from './random-folder.utils';
import { formatTrackFormat } from '../home/library-quality';
import { PopularityFetchService } from '../folders/popularity-fetch.service';
import { DurationPipe } from '../../shared/pipes/duration.pipe';
import { TipDirective } from '../../shared/directives/tip.directive';

/** Last opened source folder, as folder ids from a root down (folder ids are stable, derived from paths). */
const LAST_FOLDER_KEY = 'lutsra.dev.randomFolder.path';

/** Folders ticked to roll together, from anywhere in the tree. */
const CHECKED_KEY = 'lutsra.dev.randomFolder.checked';
/** Single tracks ticked to roll together with the ticked folders. */
const CHECKED_TRACKS_KEY = 'lutsra.dev.randomFolder.checkedTracks';

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : [];
  } catch {
    return [];
  }
}

@Component({
  selector: 'app-random-folder',
  standalone: true,
  imports: [IconComponent, DurationPipe, RandomOptionsDialogComponent, RandomReelComponent, TipDirective],
  templateUrl: './random-folder.component.html',
  styleUrl: './random-folder.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RandomFolderComponent implements OnInit {
  private readonly libraryGateway = inject(LIBRARY_GATEWAY);
  private readonly rightPanels = inject(RightPanelService);
  private readonly popularity = inject(PopularityFetchService);
  readonly session = inject(RandomSessionService);
  readonly rarity = this.session.tierOf;
  readonly rarityNames = RARITY_NAMES;
  readonly formatTrackFormat = formatTrackFormat;
  readonly hardPity = HARD_PITY;
  readonly redPity = RED_PITY;
  readonly mythicGuarantee = MYTHIC_GUARANTEE;
  private readonly destroyRef = inject(DestroyRef);
  private loadVersion = 0;
  private readonly tracksById = signal<ReadonlyMap<string, Track>>(new Map());
  private readonly roots = signal<FolderNode[]>([]);

  readonly isLoading = signal(true);
  /** Ids from a root down to the folder being browsed; the last one is the random source. */
  readonly pathIds = signal<string[]>(readIds(LAST_FOLDER_KEY));
  /** Ticked folders; when any are ticked they replace the open folder as the source. */
  readonly checkedIds = signal<ReadonlySet<string>>(new Set(readIds(CHECKED_KEY)));
  /** Ticked single tracks; they join the ticked folders in the same source. */
  readonly checkedTrackIds = signal<ReadonlySet<string>>(new Set(readIds(CHECKED_TRACKS_KEY)));
  readonly errorMessage = signal<string | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly spin = this.session.spin;
  readonly result = this.session.result;
  /** A roll is spinning; the page waits for it. */
  readonly isRandomizing = computed(() => !!this.spin() && !this.spin()!.settled);
  readonly artworkFailed = signal(false);
  readonly folders = computed(() => listFolders(this.roots()));
  private readonly foldersById = computed(() => new Map(this.folders().map((folder) => [folder.id, folder])));
  readonly nodeStack = computed(() => this.pathIds().map((id) => this.foldersById().get(id)).filter((node): node is FolderNode => !!node));
  readonly selectedFolder = computed(() => this.nodeStack().at(-1) ?? null);
  /** Rows to browse: the roots, or the subfolders of the open folder. No artwork, by design. */
  readonly rows = computed(() => {
    const folder = this.selectedFolder();
    const nodes = folder ? (folder.children ?? []).filter((child) => child.isFolder) : this.roots();
    return nodes.map((node) => ({ node, trackCount: collectTrackIds(node, true).length }));
  });
  /** Playable tracks directly in the open folder, listed under its subfolders. */
  readonly trackRows = computed(() => {
    const folder = this.selectedFolder();
    return folder ? this.availableTracks(collectTrackIds(folder, false)) : [];
  });
  readonly checkedFolders = computed(() => [...this.checkedIds()].map((id) => this.foldersById().get(id)).filter((node): node is FolderNode => !!node));
  readonly checkedTracks = computed(() => this.availableTracks([...this.checkedTrackIds()]));
  /** What is ticked, as "2 folders, 5 tracks"; empty when nothing is. */
  readonly checkedSummary = computed(() => {
    const count = (n: number, noun: string) => n ? `${n} ${noun}${n === 1 ? '' : 's'}` : '';
    return [count(this.checkedFolders().length, 'folder'), count(this.checkedTracks().length, 'track')].filter(Boolean).join(', ');
  });
  /** Name under the Roll button and in the round's notices. */
  readonly sourceLabel = computed(() => {
    const folders = this.checkedFolders();
    if (folders.length === 1 && !this.checkedTracks().length) return folders[0].name;
    return this.checkedSummary() || (this.selectedFolder()?.name ?? 'All music roots');
  });

  constructor() {
    effect(() => {
      const ids = this.pathIds();
      const checked = [...this.checkedIds()];
      const checkedTracks = [...this.checkedTrackIds()];
      if (this.isLoading()) return;
      try {
        localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify(ids));
        localStorage.setItem(CHECKED_KEY, JSON.stringify(checked));
        localStorage.setItem(CHECKED_TRACKS_KEY, JSON.stringify(checkedTracks));
      } catch {
        // Storage blocked: the folders are not remembered.
      }
    });
    // Tiers rank the whole library, not the source folder, so a track keeps its tier in every folder.
    effect(() => {
      const tracks = this.tracksById();
      const views = this.popularity.popularity();
      const ranked = [...trackRegions(this.roots())].filter(([id]) => tracks.get(id)?.isAvailable)
        .map(([id, region]) => ({ id, region, artist: leadArtist(tracks.get(id)!.artist), views: views.get(id)?.views ?? null }));
      const tiers = popularityTiers(ranked);
      this.session.tiers.set(tiers);
      this.session.libraryTiers.set(ranked.length ? tierCounts(ranked.map(({ id }) => tiers.get(id) ?? 1)) : undefined);
    });
    this.session.pageOpen.set(true);
    this.rightPanels.hideQueue(true);
    this.destroyRef.onDestroy(() => {
      this.session.pageClosed();
      ++this.loadVersion;
      this.rightPanels.hideQueue(false);
    });
  }

  ngOnInit(): void {
    this.libraryGateway.libraryChanged$?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.loadLibrary());
    let wasScanning = false;
    this.libraryGateway.scanProgress$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((progress) => {
      const finished = wasScanning && !progress.isScanning;
      wasScanning = progress.isScanning;
      if (finished) void this.loadLibrary();
    });
    void this.loadLibrary();
  }

  async loadLibrary(): Promise<void> {
    const version = ++this.loadVersion;
    this.isLoading.set(true);
    this.loadError.set(null);
    this.errorMessage.set(null);
    try {
      const library = await this.libraryGateway.getLibrary();
      if (version !== this.loadVersion) return;
      const trees = await Promise.allSettled(library.folders.map((folder) => this.libraryGateway.getFolderTree(folder.id)));
      if (version !== this.loadVersion) return;
      // Cached views only (never goes online); loaded before the first Random so its tiers are ready.
      await this.popularity.load(library.tracks.map((track) => track.id));
      if (version !== this.loadVersion) return;
      const roots: FolderNode[] = [];
      let failed = 0;
      for (const tree of trees) {
        if (tree.status === 'fulfilled' && tree.value) roots.push(tree.value);
        else ++failed;
      }
      this.tracksById.set(new Map(library.tracks.map((track) => [track.id, track])));
      this.roots.set(roots);
      if (this.nodeStack().length !== this.pathIds().length) this.pathIds.set([]);
      // Folders gone from the library lose their tick (not when a root failed to load: its folders may be back on Retry).
      if (!failed && this.checkedFolders().length !== this.checkedIds().size) this.checkedIds.set(new Set(this.checkedFolders().map((folder) => folder.id)));
      const tracks = this.tracksById();
      if ([...this.checkedTrackIds()].some((id) => !tracks.has(id))) this.checkedTrackIds.update((ids) => new Set([...ids].filter((id) => tracks.has(id))));
      if (!this.pathIds().length && roots.length === 1) this.pathIds.set([roots[0].id]);
      if (failed) this.loadError.set('Some folders could not be loaded. Retry to refresh the folder list.');
    } catch {
      if (version !== this.loadVersion) return;
      this.roots.set([]);
      this.tracksById.set(new Map());
      this.loadError.set('Could not load library folders. Retry to load them again.');
    } finally {
      if (version === this.loadVersion) this.isLoading.set(false);
    }
  }

  openFolder(folder: FolderNode): void {
    this.pathIds.update((ids) => [...ids, folder.id]);
    this.errorMessage.set(null);
  }

  /** Jumps back to a breadcrumb; -1 returns to the list of music roots. */
  openCrumb(index: number): void {
    this.pathIds.update((ids) => ids.slice(0, index + 1));
    this.errorMessage.set(null);
  }

  toggleChecked(folder: FolderNode): void {
    this.checkedIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(folder.id)) next.add(folder.id);
      return next;
    });
  }

  toggleTrack(track: Track): void {
    this.checkedTrackIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(track.id)) next.add(track.id);
      return next;
    });
  }

  clearChecked(): void {
    this.checkedIds.set(new Set());
    this.checkedTrackIds.set(new Set());
  }

  /**
   * Starts a new round from the ticked folders and tracks, else the open folder (every root at the
   * Music roots level).
   */
  randomize(): void {
    if (this.isLoading() || this.isRandomizing()) return;
    const open = this.selectedFolder();
    const recursive = this.session.options().includeSubfolders;
    const ticked = !!this.checkedSummary();
    const ids = ticked
      ? [...new Set([...sourceTrackIds(this.checkedFolders(), recursive), ...this.checkedTracks().map((track) => track.id)])]
      : sourceTrackIds(open ? [open] : this.roots(), recursive);
    this.errorMessage.set(null);
    this.artworkFailed.set(false);
    if (!this.session.start(this.availableTracks(ids), this.sourceLabel())) {
      this.errorMessage.set('No available tracks in this source. Include subfolders or choose another folder.');
    }
  }

  onSpinDone(): void {
    this.artworkFailed.set(false);
    void this.session.spinDone();
  }

  /** Leaves the roll view; the round keeps playing until the next Random starts a new one. */
  backToFolders(): void {
    this.session.leaveRollView();
    this.errorMessage.set(null);
  }

  private availableTracks(ids: string[]): Track[] {
    const tracks = this.tracksById();
    return ids.map((id) => tracks.get(id)).filter((track): track is Track => !!track?.isAvailable);
  }
}
