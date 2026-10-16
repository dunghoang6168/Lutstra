import { Component, ElementRef, afterNextRender, inject, output, viewChild } from '@angular/core';
import { PlayerService } from '../../../core/player/player.service';
import { QueueActionsService } from '../../../core/player/queue-actions.service';
import { ListeningHistoryService } from '../../../core/history/listening-history.service';
import { QueueEntry } from '../../../core/models';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/** The queue as a bottom sheet: tap a row to play it, ✕ to remove it. Reordering comes with drag in P4. */
@Component({
  selector: 'app-phone-queue-sheet',
  standalone: true,
  imports: [DurationPipe, IconComponent],
  templateUrl: './phone-queue-sheet.component.html',
  styleUrl: './phone-queue-sheet.component.scss',
})
export class PhoneQueueSheetComponent {
  readonly player = inject(PlayerService);
  readonly queueActions = inject(QueueActionsService);
  private readonly history = inject(ListeningHistoryService);
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  readonly close = output<void>();

  constructor() {
    afterNextRender(() => {
      this.list()?.nativeElement.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
      this.closeButton()?.nativeElement.focus();
    });
  }

  remove(entry: QueueEntry): void {
    // Taking a suggestion out before it plays tells Smart Shuffle it was not wanted.
    if (entry.suggested) this.history.recordRemoval(entry.track);
    this.player.removeFromQueue(entry.id);
  }
}
