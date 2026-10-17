import { Injectable, NgZone } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { LibraryGateway, LibrarySnapshot } from '../contracts/library.gateway';
import { Album, Artist, FolderNode, MusicFolder, ScanProgress, Track, TrackDetails } from '../models';
import { compareAlbumTracks } from '../models/album-track-order';
import { AndroidFolderNode, FolderRule, FolderScan, androidFolders, openFolderPicker, selectedBranches, toggleFolder } from './android-folder-selection';

export interface MediaStoreTrack {
  id: string;
  uri: string;
  fileName: string | null;
  title: string | null;
  artist: string | null;
  albumArtist?: string | null;
  album: string | null;
  durationMs: number | null;
  mimeType: string | null;
  fileSize: number | null;
  lastModified: number | null;
  trackNumber: number | null;
  year: number | null;
  /** bps; sample rate and bit depth need Android 12 (API 31). */
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  /** Absolute path of the scaled cover in the app's files (embedded picture, else the folder's cover.jpg). */
  artwork?: string | null;
  relativePath: string | null;
  folderKey?: string;
}

function known(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '<unknown>' ? trimmed : null;
}

function codecFor(mime: string | null, name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'flac' || mime === 'audio/flac') return 'FLAC';
  if (extension === 'wav' || mime === 'audio/wav' || mime === 'audio/x-wav') return 'WAV';
  if (extension === 'mp3' || mime === 'audio/mpeg') return 'MP3';
  return extension?.toUpperCase() || null;
}

function toTrack(row: MediaStoreTrack): Track {
  const fileName = known(row.fileName) || row.id.split('/').pop() || 'Unknown audio';
  const title = known(row.title) || fileName.replace(/\.[^.]+$/, '');
  const packedTrack = row.trackNumber ?? 0;
  const trackNumber = packedTrack > 0 ? packedTrack % 1000 || null : null;
  const discNumber = packedTrack >= 1000 ? Math.floor(packedTrack / 1000) : null;
  return {
    id: row.id, path: row.uri, fileName, title,
    artist: known(row.artist), albumArtist: known(row.albumArtist ?? null), album: known(row.album),
    genre: null, year: row.year && row.year > 0 ? row.year : null,
    trackNumber, discNumber, duration: Math.max(0, (row.durationMs || 0) / 1000),
    codec: codecFor(row.mimeType, fileName), bitrate: row.bitrate || null, sampleRate: row.sampleRate || null,
    bitDepth: row.bitDepth || null, channels: null, artwork: row.artwork ? Capacitor.convertFileSrc(row.artwork) : null, fileSize: row.fileSize,
    lastModified: row.lastModified, isAvailable: true,
  };
}

export function snapshotFrom(rows: MediaStoreTrack[], folders: MusicFolder[] = []): LibrarySnapshot {
  const tracks = [...new Map(rows.map(row => [row.id, toTrack(row)])).values()];
  const albumMap = new Map<string, Album>();
  const artistMap = new Map<string, Artist>();
  for (const track of tracks) {
    // Same grouping as the desktop library: album artist first.
    // Sentence case, as everywhere on the phone; ids are lower-cased, so they do not change.
    const artistName = track.albumArtist || track.artist || 'Unknown artist';
    const artistId = `android:artist:${artistName.toLocaleLowerCase()}`;
    let artist = artistMap.get(artistId);
    if (!artist) {
      artist = { id: artistId, name: artistName, albumIds: [], trackIds: [], onlineMetadata: null, customAvatar: null };
      artistMap.set(artistId, artist);
    }
    artist.trackIds.push(track.id);
    if (track.album) {
      const albumId = `android:album:${artistId}:${track.album.toLocaleLowerCase()}`;
      let album = albumMap.get(albumId);
      if (!album) {
        album = { id: albumId, title: track.album, artist: artistName, year: track.year, artwork: null, trackIds: [] };
        albumMap.set(albumId, album);
        artist.albumIds.push(albumId);
      }
      album.trackIds.push(track.id);
      album.artwork ??= track.artwork;
    }
  }
  return { tracks, albums: [...albumMap.values()], artists: [...artistMap.values()], folders };
}

/** Native queue order for a whole library: album by album, each in disc/track order. */
export function libraryQueue(tracks: readonly Track[]): Track[] {
  return [...tracks].sort((a, b) => (a.album ?? '').localeCompare(b.album ?? '', undefined, { sensitivity: 'base', numeric: true })
    || compareAlbumTracks(a, b));
}

@Injectable({ providedIn: 'root' })
export class AndroidLibraryGateway implements LibraryGateway {
  private snapshot: LibrarySnapshot = snapshotFrom([]);
  private rows: MediaStoreTrack[] = [];
  private folderNodes: AndroidFolderNode[] = [];
  private loaded = false;
  private running: Promise<void> | null = null;
  private pass: Promise<void> | null = null;
  private rescanQueued = false;
  private restoring: Promise<void> | null = null;
  private readonly progress = new BehaviorSubject<ScanProgress>({
    isScanning: false, scannedFiles: 0, audioFiles: 0, currentPath: null,
  });
  readonly scanProgress$ = this.progress.asObservable();
  private readonly changed = new Subject<void>();
  readonly libraryChanged$ = this.changed.asObservable();

  constructor(private readonly zone?: NgZone) {
    void androidFolders.addListener('scanProgress', ({ tracks }) => {
      const update = () => {
        if (this.progress.value.isScanning) this.progress.next({ ...this.progress.value, scannedFiles: tracks, audioFiles: tracks });
      };
      if (this.zone) this.zone.run(update); else update();
    }).catch(() => undefined);
  }

  async getLibrary(): Promise<LibrarySnapshot> {
    if (!this.loaded) await (this.restoring ??= this.restoreLastScan());
    // Without a saved scan, callers arriving during the first scan wait for it instead of getting an empty library.
    if (!this.loaded) {
      // The error, if any, arrives through the pass below.
      if (!this.pass) this.requestScan().catch(() => undefined);
      await this.pass;
    }
    return this.snapshot;
  }

  async getTrackById(trackId: string): Promise<Track | null> {
    return this.snapshot.tracks.find(track => track.id === trackId) ?? null;
  }

  // The native scan always covers every selected branch, so a single-folder scan is a full rescan.
  async requestFolderScan(folderId: string): Promise<void> {
    await this.requestScan([folderId]);
  }

  /** A request during a scan queues one more pass, so a selection saved mid-scan is not dropped. */
  requestScan(folderIds?: string[]): Promise<void> {
    if (this.running) { this.rescanQueued = true; return this.running; }
    this.running = (async () => {
      try {
        await (this.pass = this.scanOnce(folderIds));
        while (this.rescanQueued) { this.rescanQueued = false; await (this.pass = this.scanOnce()); }
      } finally {
        this.rescanQueued = false;
        this.pass = null;
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Shows the last finished scan at once and rescans in the background; any failure falls back to a plain scan. */
  private async restoreLastScan(): Promise<void> {
    try {
      const [last, selection] = await Promise.all([androidFolders.getLastScan(), androidFolders.getSelection()]);
      if (!last.tracks || !last.folders || this.loaded) return;
      this.apply({ tracks: last.tracks, folders: last.folders, grants: last.grants ?? [] }, selection.rules);
      // A failed rescan is reported through scanProgress$; the saved library stays.
      this.requestScan().catch(() => undefined);
    } catch {
      // No saved scan: getLibrary() scans instead.
    }
  }

  private apply(scan: FolderScan, rules: FolderRule[]): void {
    this.rows = scan.tracks;
    this.folderNodes = scan.folders;
    this.snapshot = snapshotFrom(scan.tracks, selectedBranches(scan.folders, rules, scan.grants));
    this.loaded = true;
  }

  private async scanOnce(folderIds?: string[]): Promise<void> {
    if (folderIds?.length && folderIds.some(id => !this.snapshot.folders.some(folder => folder.id === id))) {
      throw new Error('Unknown Android folder');
    }
    this.progress.next({ isScanning: true, scannedFiles: 0, audioFiles: 0, currentPath: this.snapshot.folders[0]?.path || null });
    try {
      const [selection, result] = await Promise.all([androidFolders.getSelection(), androidFolders.scan()]);
      const before = JSON.stringify([this.rows, this.snapshot.folders]);
      const wasLoaded = this.loaded;
      this.apply(result, selection.rules);
      const count = this.snapshot.tracks.length;
      this.progress.next({ isScanning: false, scannedFiles: count, audioFiles: count, currentPath: null });
      // A background rescan that finds nothing new leaves the pages alone.
      if (!wasLoaded || JSON.stringify([this.rows, this.snapshot.folders]) !== before) this.changed.next();
    } catch (error) {
      const message = String(error);
      this.progress.next({ isScanning: false, scannedFiles: 0, audioFiles: 0, currentPath: null, error: message });
      throw error;
    }
  }

  async getFolderTree(folderId: string): Promise<FolderNode | null> {
    const folder = this.snapshot.folders.find(item => item.id === folderId);
    if (!folder) return null;
    const root: FolderNode = {
      id: folderId, name: folder.name, path: folder.path, isFolder: true,
      children: [],
    };
    const byKey = new Map(this.folderNodes.map(node => [node.key, node]));
    const belongsTo = (key: string | undefined): boolean => {
      const seen = new Set<string>();
      while (key && !seen.has(key)) {
        if (key === folderId) return true;
        seen.add(key);
        key = byKey.get(key)?.parentKey || undefined;
      }
      return false;
    };
    for (const row of this.rows) {
      if (!belongsTo(row.folderKey)) continue;
      const track = this.snapshot.tracks.find(item => item.id === row.id);
      if (!track) continue;
      let node = root;
      const parts: string[] = [];
      let parent = row.folderKey;
      const seen = new Set<string>();
      while (parent && parent !== folderId && !seen.has(parent)) {
        seen.add(parent);
        const folderNode = byKey.get(parent);
        if (!folderNode) break;
        parts.unshift(folderNode.name);
        parent = folderNode.parentKey || undefined;
      }
      for (const part of parts) {
        let child = node.children?.find(item => item.isFolder && item.name === part);
        if (!child) {
          child = { id: `${node.id}/${part}`, name: part, path: `${node.path}/${part}`, isFolder: true, children: [] };
          node.children!.push(child);
        }
        node = child;
      }
      node.children!.push({ id: track.id, name: track.fileName, path: track.path, isFolder: false, trackId: track.id });
    }
    return root;
  }

  async getTrackDetails(trackId: string): Promise<TrackDetails> {
    const track = this.snapshot.tracks.find(item => item.id === trackId);
    if (!track) throw new Error('Track not found or unavailable');
    return {
      trackId,
      metadata: {
        title: track.title, artists: track.artist ? [track.artist] : [], album: track.album,
        albumArtists: track.albumArtist ? [track.albumArtist] : [], date: track.year ? String(track.year) : null, year: track.year,
        composers: [], genres: [], trackNumber: track.trackNumber, totalTracks: null,
        discNumber: track.discNumber, totalDiscs: null,
      },
      audio: {
        duration: track.duration, numberOfSamples: null, sampleRate: track.sampleRate, channels: null,
        bitsPerSample: track.bitDepth, bitrate: track.bitrate, codec: track.codec, codecProfile: null,
        container: null, lossless: null, encoderTool: null, tagTypes: [], audioMd5: null,
      },
      file: {
        fileName: track.fileName, path: track.path, fileSize: track.fileSize,
        lastModified: track.lastModified,
      },
    };
  }

  // Opens the folder picker dialog (AndroidFolderPickerComponent), which saves the ticked branches.
  async selectAndAddMusicFolders(): Promise<MusicFolder[]> {
    if (!(await openFolderPicker())) return [];
    await this.requestScan();
    return this.snapshot.folders;
  }

  async removeMusicFolder(folderId: string): Promise<void> {
    // The last scan visited every ticked folder and its ancestors, which is all toggleFolder needs here.
    const selection = await androidFolders.getSelection();
    await androidFolders.saveSelection({ rules: toggleFolder(this.folderNodes, selection.rules, folderId, false) });
    await this.requestScan();
  }
}
