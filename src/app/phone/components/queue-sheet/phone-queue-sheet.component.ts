import { Component, ElementRef, Injector, NgZone, afterNextRender, computed, inject, output, signal, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { QueueActionsService } from '../../../core/player/queue-actions.service';
import { SmartShuffleService } from '../../../core/smart-shuffle/smart-shuffle.service';
import { QueueEntry } from '../../../core/models';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { haptic } from '../../haptics';
import { SwipeDirective } from '../../swipe.directive';
import { dropSlot } from '../../queue-drag';
import { focusQuietly } from '../../focus';
import { SheetDragDirective } from '../../sheet-drag.directive';
import { NearScreenDirective } from '../../near-screen.directive';

interface QueueDrag {
  id: string;
  pointerId: number;
  startY: number;
  startScroll: number;
  targetId: string | null;
  placement: 'before' | 'after';
}

/** How close to the list's top or bottom edge a dragged row starts scrolling it, and how fast. */
const EDGE_PX = 64;
const EDGE_STEP_PX = 12;

/** Rows a long queue adds when its rendered part is scrolled near an end, as the Library does (LIBRARY_PAGE). */
const QUEUE_PAGE = 40;

/** The rows other than the dragged one, measured once when a drag starts (positions inside the list's content). */
interface DragLayout {
  row: HTMLElement;
  source: number;
  height: number;
  others: { el: HTMLElement; id: string; middle: number }[];
  /** The rows shifted for the current slot, so a new slot only touches what changes. */
  shifted: HTMLElement[];
}

/** The queue as a bottom sheet: tap a row to play it; drag its handle to move it; swipe it away or use its ⋯ sheet. */
@Component({
  selector: 'app-phone-queue-sheet',
  standalone: true,
  imports: [CoverArtComponent, DurationPipe, IconComponent, SwipeDirective, SheetDragDirective, NearScreenDirective],
  templateUrl: './phone-queue-sheet.component.html',
  styleUrl: './phone-queue-sheet.component.scss',
})
export class PhoneQueueSheetComponent {
  readonly player = inject(PlayerService);
  readonly queueActions = inject(QueueActionsService);
  readonly library = inject(PhoneLibraryService);
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly injector = inject(Injector);
  private readonly zone = inject(NgZone);
  readonly close = output<void>();
  readonly drag = signal<QueueDrag | null>(null);
  readonly announcement = signal('');
  private layout: DragLayout | null = null;
  /**
   * Only the rows around the current one are built (20 before, 40 after), and more as the list nears an end: a
   * 710-track queue took about 0.9 s to open with every row (2026-10-25).
   */
  readonly before = signal(QUEUE_PAGE / 2);
  readonly after = signal(QUEUE_PAGE);
  readonly rows = computed(() => {
    const queue = this.player.queue();
    const current = Math.max(0, this.player.currentIndex());
    const from = Math.max(0, current - this.before());
    const entries = queue.slice(from, current + this.after() + 1);
    return { from, entries, toEnd: from + entries.length === queue.length };
  });
  readonly page = QUEUE_PAGE;
  /** Listening time left: the rest of the current track and everything after it. */
  readonly remaining = computed(() => {
    const queue = this.player.queue();
    const current = this.player.currentIndex();
    let seconds = 0;
    for (let i = Math.max(current, 0); i < queue.length; i++) seconds += queue[i].track.duration || 0;
    return current >= 0 ? Math.max(0, seconds - Math.min(this.player.currentTime(), queue[current]?.track.duration || 0)) : seconds;
  });

  private readonly smartShuffle = inject(SmartShuffleService);
  readonly refreshing = signal(false);

  /** Picks Autoplay's waiting suggestions again. */
  async refreshAutoplay(): Promise<void> {
    haptic('tick');
    this.refreshing.set(true);
    try { await this.smartShuffle.refreshAutoplay(); } finally { this.refreshing.set(false); }
  }

  /** Where Smart Shuffle's picks start after the current track, marked once instead of on every row. */
  readonly suggestedFrom = computed(() => {
    const queue = this.player.queue();
    for (let i = this.player.currentIndex() + 1; i < queue.length; i++) if (queue[i].suggested) return i;
    return -1;
  });

  constructor() {
    afterNextRender(() => {
      this.list()?.nativeElement.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
      focusQuietly(this.closeButton()?.nativeElement);
    });
  }

  /** Every removal comes with an Undo; removing the current entry moves playback on. */
  remove(entry: QueueEntry): void {
    this.library.removeFromQueue(entry);
  }

  /** Drag by the handle (after PixelPlayer's queue): the row lifts and follows the finger, the others make room, and the list scrolls at its edges. */
  dragStart(event: PointerEvent, id: string): void {
    if (this.drag() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation(); // the row's swipe must not see it
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    // Measured once: a long queue is not re-measured on every finger move (offsetTop ignores the shifts below).
    const list = this.list()?.nativeElement;
    const rows = [...(list?.querySelectorAll<HTMLElement>('.queue-row') ?? [])];
    const source = rows.findIndex((r) => r.dataset['entryId'] === id);
    if (source < 0) return;
    // ponytail: rows built mid-drag (the list scrolled near an end) are not drop slots; re-measure if that bites.
    this.layout = {
      // A row makes room for the dragged one's height plus the gap between cards.
      row: rows[source], source, height: rows[source].offsetHeight + parseFloat(getComputedStyle(list!).rowGap || '0'), shifted: [],
      others: rows.filter((_, i) => i !== source)
        .map((el) => ({ el, id: el.dataset['entryId']!, middle: el.offsetTop + el.offsetHeight / 2 })),
    };
    rows[source].style.transition = 'none';
    this.drag.set({
      id, pointerId: event.pointerId, startY: event.clientY, startScroll: this.list()?.nativeElement.scrollTop ?? 0,
      targetId: null, placement: 'before',
    });
    haptic('start');
    const move = (e: PointerEvent) => this.dragMove(e);
    const end = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      this.zone.run(() => this.dragEnd(e.type === 'pointerup'));
    };
    // Outside Angular: a finger move restyles rows and sets `drag` only when the slot changes, so it must not
    // run change detection for the whole app on every move.
    this.zone.runOutsideAngular(() => {
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }

  handleKeydown(event: KeyboardEvent, id: string): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const entries = this.player.queue();
    const index = entries.findIndex((entry) => entry.id === id);
    const up = event.key === 'ArrowUp';
    const target = entries[index + (up ? -1 : 1)];
    if (index < 0 || !target) return;
    this.move(id, target.id, up ? 'before' : 'after');
    afterNextRender(() => this.rowOf(id)?.querySelector<HTMLElement>('.drag-handle')?.focus(), { injector: this.injector });
  }

  private dragMove(event: PointerEvent): void {
    const drag = this.drag();
    const layout = this.layout;
    const list = this.list()?.nativeElement;
    if (!drag || !layout || !list) return;
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + EDGE_PX) list.scrollTop -= EDGE_STEP_PX;
    else if (event.clientY > bounds.bottom - EDGE_PX) list.scrollTop += EDGE_STEP_PX;

    // ponytail: the edges scroll only while the finger moves; add a timer loop if holding still at an edge feels stuck.
    layout.row.style.translate = `0 ${event.clientY - drag.startY + list.scrollTop - drag.startScroll}px`;

    const next = dropSlot(layout.others, event.clientY - bounds.top + list.scrollTop);
    if (next.targetId === drag.targetId && next.placement === drag.placement) return;
    this.drag.set({ ...drag, ...next });
    haptic('tick');
    // Rows between the dragged row's old and new place slide one row toward the gap it left.
    for (const el of layout.shifted) el.style.translate = '';
    const slot = next.placement === 'after' ? layout.others.length : layout.others.findIndex((r) => r.id === next.targetId);
    const from = Math.min(slot, layout.source);
    const to = Math.max(slot, layout.source);
    const shift = slot < layout.source ? layout.height : -layout.height;
    layout.shifted = layout.others.slice(from, to).map(({ el }) => el);
    for (const el of layout.shifted) el.style.translate = `0 ${shift}px`;
  }

  private dragEnd(drop: boolean): void {
    const drag = this.drag();
    this.drag.set(null);
    if (!drag) return;
    // Drop the shifts without animating: the rows take their new places in the same frame.
    const rows = [this.layout?.row, ...(this.layout?.shifted ?? [])].filter((row): row is HTMLElement => !!row);
    this.layout = null;
    for (const row of rows) { row.style.transition = 'none'; row.style.translate = ''; }
    afterNextRender(() => rows.forEach((row) => row.style.transition = ''), { injector: this.injector });
    if (drop && drag.targetId) this.move(drag.id, drag.targetId, drag.placement);
    haptic('end');
  }

  private move(id: string, targetId: string, placement: 'before' | 'after'): void {
    if (!this.player.moveQueueEntry(id, targetId, placement)) return;
    const queue = this.player.queue();
    this.announcement.set(`Moved to position ${queue.findIndex((entry) => entry.id === id) + 1} of ${queue.length}.`);
  }

  private rowOf(id: string): HTMLElement | null | undefined {
    return this.list()?.nativeElement.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
  }
}
