import { Component, DestroyRef, ElementRef, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Track } from '../../core/models';
import { DailyMixService } from '../../core/smart-shuffle/daily-mix.service';
import { PlayerService } from '../../core/player/player.service';
import { TrackSelectionService } from '../../core/layout/track-selection.service';
import { focusListItem, nextRowIndex } from '../../shared/utils/row-navigation';
import { DurationPipe } from '../../shared/pipes/duration.pipe';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { TrackActionsMenuComponent } from '../../shared/components/track-actions-menu/track-actions-menu.component';
import { TipDirective } from '../../shared/directives/tip.directive';

/** Today's Daily Mix: a fixed list made once a day from the listener profile. */
@Component({
  selector: 'app-daily-mix',
  standalone: true,
  imports: [DurationPipe, IconComponent, TrackActionsMenuComponent, TipDirective],
  templateUrl: './daily-mix.component.html',
  styleUrl: './daily-mix.component.scss',
})
export class DailyMixComponent {
  readonly mix = inject(DailyMixService);
  readonly player = inject(PlayerService);
  private readonly selection = inject(TrackSelectionService);
  private readonly rowsContainer = viewChild<ElementRef<HTMLElement>>('rowsContainer');
  readonly activeId = signal<string | null>(null);

  constructor() {
    void this.mix.ensure();
    effect(() => {
      const tracks = this.mix.tracks();
      untracked(() => {
        if (!tracks.some((track) => track.id === this.activeId())) this.activeId.set(tracks[0]?.id ?? null);
        this.selection.selected.set(tracks.find((track) => track.id === this.activeId()) ?? null);
      });
    });
    inject(DestroyRef).onDestroy(() => this.selection.selected.set(null));
  }

  onActivate(track: Track, moveFocus = false): void {
    this.activeId.set(track.id);
    this.selection.selected.set(track);
    if (moveFocus) focusListItem(this.rowsContainer()?.nativeElement, 'data-track-id', track.id);
  }

  onPlay(index: number): void {
    void this.mix.play(index);
  }

  onRemove(track: Track): void {
    const tracks = this.mix.tracks();
    const next = tracks[tracks.indexOf(track) + 1] ?? tracks[tracks.indexOf(track) - 1];
    this.mix.remove(track);
    if (next) this.onActivate(next, true);
  }

  onRowsKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const element = target.closest<HTMLElement>('.mix-row[data-track-id]');
    if (!element || target.closest('button, a, [role="button"]')) return;
    const tracks = this.mix.tracks();
    const current = tracks.findIndex((track) => track.id === element.dataset['trackId']);
    if (current < 0) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.onPlay(current);
      return;
    }
    let next = nextRowIndex(event.key, current, tracks.length, 1);
    if (next === null) return;
    event.preventDefault();
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const viewport = element.closest<HTMLElement>('.main-content');
      const rowHeight = element.getBoundingClientRect().height;
      const clearance = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
      const pageSize = viewport && rowHeight > 0 ? Math.max(1, Math.floor((viewport.clientHeight - clearance) / rowHeight)) : 1;
      next = nextRowIndex(event.key, current, tracks.length, pageSize)!;
    }
    this.onActivate(tracks[next], true);
  }
}
