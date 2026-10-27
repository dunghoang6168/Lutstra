import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { LISTENING_HISTORY_GATEWAY } from '../../../core/contracts';
import { HISTORY_PAGE_SIZE, HistoryEntry, Track } from '../../../core/models';
import { ListeningHistoryService } from '../../../core/history/listening-history.service';
import { HistoryRange, HistoryRow, historyDays, historyRangeStart, mergeHistory } from '../../../core/history/history-days';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { SwipeDirection, SwipeDirective } from '../../swipe.directive';

const RANGES: { id: HistoryRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

/**
 * The listening history, after PixelPlayer's Recently Played: a range, Play latest and Shuffle, then the listens
 * grouped by day. It draws its own header; the shell hides its app bar and the bottom nav here.
 */
@Component({
  selector: 'app-phone-history',
  standalone: true,
  imports: [IconComponent, PhoneTrackRowComponent, SwipeDirective],
  templateUrl: './phone-history.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-history.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneHistoryComponent {
  private readonly gateway = inject(LISTENING_HISTORY_GATEWAY);
  private readonly history = inject(ListeningHistoryService);
  private readonly library = inject(PhoneLibraryService);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);
  private readonly more = viewChild<ElementRef<HTMLElement>>('more');
  private readonly rangeRow = viewChild<ElementRef<HTMLElement>>('rangeRow');

  readonly ranges = RANGES;
  readonly range = signal<HistoryRange>('week');
  private readonly entries = signal<HistoryEntry[]>([]);
  readonly loading = signal(true);
  readonly failed = signal(false);
  private readonly hasMore = signal(false);
  private loadingMore = false;

  private readonly start = computed(() => historyRangeStart(this.range(), Date.now()));
  /** Each track once, at its latest listen in the range, as PixelPlayer; tracks the library no longer knows are left out. */
  readonly rows = computed<HistoryRow[]>(() => {
    const tracks = this.library.trackById();
    const start = this.start();
    const seen = new Set<string>();
    return this.entries().flatMap((entry) => {
      const track = entry.startedAt >= start && !seen.has(entry.trackId) ? tracks.get(entry.trackId) : undefined;
      if (!track) return [];
      seen.add(track.id);
      return [{ id: String(entry.id), track, startedAt: entry.startedAt }];
    });
  });
  readonly days = computed(() => historyDays(this.rows(), Date.now()));
  /** What Play latest, Shuffle and a tap play: the rows' tracks that can play, newest first. */
  private readonly queue = computed(() => this.rows().map((row) => row.track).filter((track) => track.isAvailable));
  readonly canPlay = computed(() => this.queue().length > 0);
  /** More older listens may still fall in the range. */
  readonly wantsMore = computed(() => this.hasMore() && (this.entries().at(-1)?.startedAt ?? 0) >= this.start());

  private readonly timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  constructor() {
    void this.library.ensureLoaded();
    void this.load();
    let first = true;
    effect(() => {
      this.history.changes();
      if (first) { first = false; return; }
      untracked(() => void this.refreshNewest());
    });
    // The end of the list near the screen loads the next page, while older listens may still be in the range.
    // Observed again after each page, so an end still in view asks for the next one.
    effect((onCleanup) => {
      this.entries();
      const el = this.more()?.nativeElement;
      if (!el) return;
      const observer = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) void this.loadMore(); }, { rootMargin: '400px 0px' });
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
  }

  /** The first range only swipes on to the next, the last only back. */
  readonly swipeAllow = computed(() => {
    const i = RANGES.findIndex((item) => item.id === this.range());
    return i === 0 ? 'left' : i === RANGES.length - 1 ? 'right' : 'both';
  });

  pick(range: HistoryRange): void {
    this.range.set(range);
    // Bring the chosen chip into view inside its row (scrollIntoView would also scroll the page's ancestors).
    const row = this.rangeRow()?.nativeElement;
    const chip = row?.children[RANGES.findIndex((item) => item.id === range)] as HTMLElement | undefined;
    if (row && chip) row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
  }

  swiped(direction: SwipeDirection): void {
    const i = RANGES.findIndex((item) => item.id === this.range()) + (direction === 'left' ? 1 : -1);
    if (RANGES[i]) this.pick(RANGES[i].id);
  }

  time(row: HistoryRow): string {
    return this.timeFormat.format(row.startedAt);
  }

  back(): void {
    this.location.back();
  }

  playLatest(): void {
    this.library.play(this.queue(), 0);
  }

  shuffle(): void {
    this.library.shuffle(this.queue());
  }

  playRow(row: HistoryRow): void {
    const queue = this.queue();
    this.library.play(queue, Math.max(0, queue.findIndex((track: Track) => track.id === row.track.id)));
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const page = await this.gateway.list({ limit: HISTORY_PAGE_SIZE });
      if (this.destroyRef.destroyed) return;
      this.entries.set(page);
      this.hasMore.set(page.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      console.error('Could not load history', error);
      if (!this.destroyRef.destroyed) this.failed.set(true);
    } finally {
      if (!this.destroyRef.destroyed) this.loading.set(false);
    }
  }

  private async loadMore(): Promise<void> {
    const last = this.entries().at(-1);
    if (!last || this.loadingMore || !this.wantsMore()) return;
    this.loadingMore = true;
    try {
      const page = await this.gateway.list({ limit: HISTORY_PAGE_SIZE, before: { startedAt: last.startedAt, id: last.id } });
      if (this.destroyRef.destroyed) return;
      this.entries.update((current) => mergeHistory(current, page));
      this.hasMore.set(page.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      console.error('Could not load more history', error);
    } finally {
      this.loadingMore = false;
    }
  }

  /** A listen was recorded or the history cleared: take the newest page again, keeping older pages already loaded. */
  private async refreshNewest(): Promise<void> {
    try {
      const page = await this.gateway.list({ limit: HISTORY_PAGE_SIZE });
      if (this.destroyRef.destroyed) return;
      if (!page.length) { this.entries.set([]); this.hasMore.set(false); return; }
      this.entries.update((current) => mergeHistory(current, page));
    } catch (error) {
      console.error('Could not refresh history', error);
    }
  }
}
