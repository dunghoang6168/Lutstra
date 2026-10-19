import { Injectable, computed, inject, signal } from '@angular/core';
import { LIBRARY_GATEWAY, LibrarySnapshot, PLAYLIST_GATEWAY } from '../core/contracts';
import { ListeningHistoryService } from '../core/history/listening-history.service';
import { FolderNode, Playlist, QueueEntry, Track } from '../core/models';
import { PlayerService } from '../core/player/player.service';
import { QueueActionsService } from '../core/player/queue-actions.service';
import { AlbumSort, ArtistSort, SongSort } from './library-sort';

/** The phone pages' shared library state, playback starts and the track ⋯ sheet. */
@Injectable({ providedIn: 'root' })
export class PhoneLibraryService {
  private readonly library = inject(LIBRARY_GATEWAY);
  private readonly playlistGateway = inject(PLAYLIST_GATEWAY);
  private readonly player = inject(PlayerService);
  private readonly queueActions = inject(QueueActionsService);
  private readonly history = inject(ListeningHistoryService);
  private loading: Promise<void> | null = null;

  readonly snapshot = signal<LibrarySnapshot | null>(null);
  readonly playlists = signal<Playlist[]>([]);
  readonly error = signal<string | null>(null);
  readonly trackById = computed(() => new Map((this.snapshot()?.tracks ?? []).map((track) => [track.id, track] as const)));
  /** Tracks the ⋯ sheet acts on, and the tracks waiting for the Add to playlist dialog. */
  readonly actionTracks = signal<Track[] | null>(null);
  /** Set when the ⋯ sheet was opened from a queue row, so it acts on that entry. */
  readonly actionEntry = signal<QueueEntry | null>(null);
  /** Set when the ⋯ sheet was opened from a Flex Mix row on Home, so it offers Remove from mix. */
  readonly actionFromMix = signal(false);
  readonly playlistTracks = signal<Track[] | null>(null);
  /** Library sorts last for the session, so a detail page and Back keep them. */
  readonly songSort = signal<SongSort>('title');
  readonly albumSort = signal<AlbumSort>('title');
  readonly artistSort = signal<ArtistSort>('name');

  constructor() {
    this.library.libraryChanged$?.subscribe(() => void this.reload());
  }

  /** Loads once; later calls wait for the same load. */
  ensureLoaded(): Promise<void> {
    return this.loading ??= this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.snapshot.set(await this.library.getLibrary());
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load the library');
    }
  }

  async loadPlaylists(): Promise<void> {
    try { this.playlists.set(await this.playlistGateway.getPlaylists()); } catch { /* The tab shows what it had. */ }
  }

  folderTree(rootId: string): Promise<FolderNode | null> {
    return this.library.getFolderTree(rootId);
  }

  tracksOf(ids: readonly string[]): Track[] {
    const byId = this.trackById();
    return ids.map((id) => byId.get(id)).filter((track): track is Track => !!track);
  }

  play(tracks: readonly Track[], index = 0): void {
    if (!tracks.length || !tracks[index]?.isAvailable) return;
    this.player.setShuffle(false);
    void this.player.playCollection([...tracks], index);
  }

  shuffle(tracks: readonly Track[]): void {
    if (!tracks.length) return;
    this.player.setShuffle(true);
    void this.player.playCollection([...tracks], Math.floor(Math.random() * tracks.length));
  }

  openActions(tracks: Track[], entry: QueueEntry | null = null, fromMix = false): void {
    this.actionEntry.set(entry);
    this.actionFromMix.set(fromMix);
    this.actionTracks.set(tracks);
  }

  /** Removes a queue entry with Undo; a suggestion taken out tells Smart Shuffle it was not wanted, once the Undo has passed. */
  removeFromQueue(entry: QueueEntry): void {
    this.queueActions.removeWithUndo(entry, entry.suggested ? () => this.history.recordRemoval(entry.track) : undefined);
  }

  playNext(tracks: Track[]): void {
    this.player.playNext(tracks);
    this.queueActions.notify(tracks.length === 1 ? `“${tracks[0].title}” plays next` : `${tracks.length} tracks play next`);
  }

  addToQueue(tracks: Track[]): void {
    this.queueActions.add(tracks);
  }
}
