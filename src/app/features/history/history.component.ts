import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY, LISTENING_HISTORY_GATEWAY } from '../../core/contracts';
import { HISTORY_PAGE_SIZE, HistoryEntry, Track } from '../../core/models';
import { ListeningHistoryService } from '../../core/history/listening-history.service';
import { PlayerService } from '../../core/player/player.service';
import { TrackSelectionService } from '../../core/layout/track-selection.service';
import { focusListItem, nextRowIndex } from '../../shared/utils/row-navigation';
import { DurationPipe } from '../../shared/pipes/duration.pipe';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { TrackActionsMenuComponent } from '../../shared/components/track-actions-menu/track-actions-menu.component';
import { TipDirective } from '../../shared/directives/tip.directive';

export interface HistoryRow {
  id: string;
  track: Track;
  startedAt: number;
}

export interface HistoryDay {
  key: string;
  label: string;
  rows: HistoryRow[];
}

const dayKey = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** Groups rows (newest first) by local day: Today, Yesterday, then the date. */
export function historyDays(rows: readonly HistoryRow[], now: number): HistoryDay[] {
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate.getTime());
  const thisYear = new Date(now).getFullYear();
  const days: HistoryDay[] = [];
  for (const row of rows) {
    const key = dayKey(row.startedAt);
    let day = days.at(-1);
    if (day?.key !== key) {
      const date = new Date(row.startedAt);
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: date.getFullYear() === thisYear ? undefined : 'numeric' });
      day = { key, label, rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

/** Adds a newly fetched page to the loaded entries: no duplicates, newest first. */
export function mergeHistory(current: readonly HistoryEntry[], page: readonly HistoryEntry[]): HistoryEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of page) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [DurationPipe, IconComponent, TrackActionsMenuComponent, TipDirective],
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss',
})
export class HistoryComponent {
  private readonly gateway = inject(LISTENING_HISTORY_GATEWAY);
  private readonly libraryGateway = inject(LIBRARY_GATEWAY);
  private readonly history = inject(ListeningHistoryService);
  private readonly selection = inject(TrackSelectionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rowsContainer = viewChild<ElementRef<HTMLElement>>('rowsContainer');
  readonly player = inject(PlayerService);

  private readonly entries = signal<HistoryEntry[]>([]);
  private readonly tracks = signal<ReadonlyMap<string, Track>>(new Map());
  readonly isLoading = signal(true);
  readonly isLoadingMore = signal(false);
  readonly hasMore = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly activeId = signal<string | null>(null);

  /** Listens of tracks the library no longer knows at all are left out; there is nothing to show for them. */
  readonly rows = computed<HistoryRow[]>(() => {
    const tracks = this.tracks();
    return this.entries().flatMap((entry) => {
      const track = tracks.get(entry.trackId);
      return track ? [{ id: String(entry.id), track, startedAt: entry.startedAt }] : [];
    });
  });
  readonly days = computed(() => historyDays(this.rows(), Date.now()));

  private readonly timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  constructor() {
    void this.load();
    let firstChange = true;
    effect(() => {
      this.history.changes();
      if (firstChange) { firstChange = false; return; }
      untracked(() => void this.refreshNewest());
    });
    effect(() => {
      const rows = this.rows();
      untracked(() => {
        if (!rows.some((row) => row.id === this.activeId())) this.activeId.set(rows[0]?.id ?? null);
        this.selection.selected.set(rows.find((row) => row.id === this.activeId())?.track ?? null);
      });
    });
    this.libraryGateway.libraryChanged$?.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.loadTracks());
    this.destroyRef.onDestroy(() => this.selection.selected.set(null));
  }

  formatTime(time: number): string {
    return this.timeFormat.format(time);
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const [page] = await Promise.all([this.gateway.list({ limit: HISTORY_PAGE_SIZE }), this.loadTracks()]);
      if (this.destroyRef.destroyed) return;
      this.entries.set(page);
      this.hasMore.set(page.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      if (!this.destroyRef.destroyed) this.errorMessage.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.destroyRef.destroyed) this.isLoading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const last = this.entries().at(-1);
    if (!last || this.isLoadingMore()) return;
    this.isLoadingMore.set(true);
    try {
      const page = await this.gateway.list({ limit: HISTORY_PAGE_SIZE, before: { startedAt: last.startedAt, id: last.id } });
      if (this.destroyRef.destroyed) return;
      this.entries.update((current) => mergeHistory(current, page));
      this.hasMore.set(page.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      console.error('Could not load more history', error);
    } finally {
      if (!this.destroyRef.destroyed) this.isLoadingMore.set(false);
    }
  }

  /** A listen was recorded or the history was cleared: take the newest page again, keeping older pages already loaded. */
  private async refreshNewest(): Promise<void> {
    try {
      const page = await this.gateway.list({ limit: HISTORY_PAGE_SIZE });
      if (this.destroyRef.destroyed) return;
      if (page.length === 0) {
        this.entries.set([]);
        this.hasMore.set(false);
        return;
      }
      if (page.some((entry) => !this.tracks().has(entry.trackId))) await this.loadTracks();
      this.entries.update((current) => mergeHistory(current, page));
    } catch (error) {
      console.error('Could not refresh history', error);
    }
  }

  private async loadTracks(): Promise<void> {
    const library = await this.libraryGateway.getLibrary();
    if (!this.destroyRef.destroyed) this.tracks.set(new Map(library.tracks.map((track) => [track.id, track])));
  }

  onActivateRow(row: HistoryRow, moveFocus = false): void {
    this.activeId.set(row.id);
    this.selection.selected.set(row.track);
    if (moveFocus) focusListItem(this.rowsContainer()?.nativeElement, 'data-entry-id', row.id);
  }

  onPlayRow(row: HistoryRow): void {
    if (row.track.isAvailable) void this.player.playTrack(row.track);
  }

  onRowsKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const element = target.closest<HTMLElement>('.history-row[data-entry-id]');
    if (!element || target.closest('button, a, [role="button"]')) return;
    const rows = this.rows();
    const current = rows.findIndex((row) => row.id === element.dataset['entryId']);
    if (current < 0) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.onPlayRow(rows[current]);
      return;
    }
    let next = nextRowIndex(event.key, current, rows.length, 1);
    if (next === null) return;
    event.preventDefault();
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const viewport = element.closest<HTMLElement>('.main-content');
      const rowHeight = element.getBoundingClientRect().height;
      const clearance = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
      const pageSize = viewport && rowHeight > 0 ? Math.max(1, Math.floor((viewport.clientHeight - clearance) / rowHeight)) : 1;
      next = nextRowIndex(event.key, current, rows.length, pageSize)!;
    }
    this.onActivateRow(rows[next], true);
  }
}
