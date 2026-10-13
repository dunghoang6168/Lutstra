import { Injectable, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY, POPULARITY_GATEWAY, TrackPopularity } from '../../core/contracts';
import { DevModeService } from '../../core/settings/dev-mode.service';

/** Track ids with no cached views yet, in order and without duplicates. */
export function missingIds(trackIds: readonly string[], cached: ReadonlyMap<string, unknown>): string[] {
  return [...new Set(trackIds)].filter((id) => !cached.has(id));
}

/**
 * Developer mode: YouTube views per track. Root-provided so a library-wide fetch (about 20 minutes)
 * keeps running and reporting while the user leaves the Folders page. It starts with the Folders page,
 * so only scans finished after that trigger the automatic fetch.
 */
@Injectable({ providedIn: 'root' })
export class PopularityFetchService {
  private readonly gateway = inject(POPULARITY_GATEWAY);
  private readonly library = inject(LIBRARY_GATEWAY);
  private readonly devMode = inject(DevModeService).enabled;
  private busy = false;
  readonly popularity = signal<ReadonlyMap<string, TrackPopularity>>(new Map());
  readonly progress = signal<{ done: number; total: number } | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    this.gateway.progress$.pipe(takeUntilDestroyed()).subscribe(({ done, total, result }) => {
      this.merge([result]);
      if (this.progress()) this.progress.set({ done, total });
    });
    // A finished scan may have added tracks: fetch the ones without views (developer mode only).
    let wasScanning = false;
    this.library.scanProgress$.pipe(takeUntilDestroyed()).subscribe(({ isScanning }) => {
      const finished = wasScanning && !isScanning;
      wasScanning = isScanning;
      if (finished && this.devMode()) void this.fetchLibraryMissing();
    });
    // Views are a developer-mode experiment; turning the mode off stops a running fetch.
    effect(() => {
      if (!this.devMode() && this.progress()) this.cancel();
    });
  }

  /** Reads cached results; never goes online. */
  async load(trackIds: string[]): Promise<void> {
    if (!trackIds.length) return;
    try {
      this.merge(await this.gateway.getPopularity(trackIds));
    } catch {
      // Cache unreadable: the column shows "not fetched" until a fetch fills it.
    }
  }

  /** Searches YouTube for these tracks; with `onlyMissing`, tracks already cached are skipped. */
  async fetch(trackIds: string[], onlyMissing = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error.set(null);
    try {
      if (onlyMissing) await this.load(trackIds);
      const targets = onlyMissing ? missingIds(trackIds, this.popularity()) : [...new Set(trackIds)];
      if (!targets.length) return;
      this.progress.set({ done: 0, total: targets.length });
      const summary = await this.gateway.fetchPopularity(targets);
      if (summary.failed && !summary.cancelled) this.error.set(`${summary.failed} tracks could not be searched. Fetch again to retry them.`);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Fetching views failed');
    } finally {
      this.busy = false;
      this.progress.set(null);
    }
  }

  private async fetchLibraryMissing(): Promise<void> {
    try {
      await this.fetch((await this.library.getLibrary()).tracks.map((track) => track.id), true);
    } catch {
      // Library unreadable right after the scan: the Folders toolbar can still fetch missing views.
    }
  }

  cancel(): void {
    void this.gateway.cancelFetch();
  }

  private merge(entries: readonly TrackPopularity[]): void {
    if (!entries.length) return;
    this.popularity.update((current) => {
      const next = new Map(current);
      for (const entry of entries) next.set(entry.trackId, entry);
      return next;
    });
  }
}
