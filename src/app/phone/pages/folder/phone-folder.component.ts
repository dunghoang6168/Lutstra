import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { FolderNode, Track } from '../../../core/models';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneDetailHeaderComponent } from '../../components/detail-header/phone-detail-header.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { collectionMeasure } from '../collection-measure';

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** One folder of a music root: its sub-folders, then its own tracks. Play and Shuffle take everything below it. */
@Component({
  selector: 'app-phone-folder',
  standalone: true,
  imports: [RouterLink, IconComponent, PhoneDetailHeaderComponent, PhoneTrackRowComponent],
  templateUrl: './phone-folder.component.html',
  styleUrls: ['../../phone-lists.scss'],
})
export class PhoneFolderComponent {
  readonly library = inject(PhoneLibraryService);
  /** Folder node ids are the root's id followed by "/name" for each level. */
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });
  readonly root = computed(() => (this.library.snapshot()?.folders ?? [])
    .find((folder) => this.id() === folder.id || this.id().startsWith(folder.id + '/')) ?? null);
  private readonly tree = signal<FolderNode | null>(null);
  readonly searched = signal(false);
  readonly node = computed(() => findNode(this.tree(), this.id()));
  readonly subfolders = computed(() => (this.node()?.children ?? []).filter((child) => child.isFolder)
    .sort((a, b) => text.compare(a.name, b.name)));
  readonly tracks = computed(() => this.library.tracksOf((this.node()?.children ?? [])
    .filter((child) => !child.isFolder && child.trackId).map((child) => child.trackId!))
    .sort((a, b) => text.compare(a.fileName, b.fileName)));
  readonly allTracks = computed<Track[]>(() => this.library.tracksOf(trackIdsBelow(this.node())));
  readonly measure = computed(() => collectionMeasure(this.allTracks()));
  readonly subtitle = computed(() => {
    const root = this.root();
    if (!root) return null;
    return this.id() === root.id ? root.path : `${root.path}${this.id().slice(root.id.length)}`;
  });

  constructor() {
    void this.library.ensureLoaded();
    effect(() => {
      const root = this.root();
      this.library.snapshot();
      if (!root) { this.searched.set(this.library.snapshot() !== null); return; }
      void this.library.folderTree(root.id).then((tree) => {
        this.tree.set(tree);
        this.searched.set(true);
      });
    });
  }
}

function findNode(node: FolderNode | null, id: string): FolderNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    if (child.isFolder && (id === child.id || id.startsWith(child.id + '/'))) return findNode(child, id);
  }
  return null;
}

function trackIdsBelow(node: FolderNode | null): string[] {
  if (!node) return [];
  return (node.children ?? []).flatMap((child) => child.isFolder ? trackIdsBelow(child) : child.trackId ? [child.trackId] : []);
}
